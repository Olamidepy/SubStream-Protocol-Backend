/**
 * Redis-Backed Token Bucket Rate Limiter
 * 
 * Implements a distributed token bucket algorithm using Redis for:
 * - Application-layer rate limiting
 * - Differentiated limits for authenticated vs anonymous traffic
 * - Dynamic rate limit updates for enterprise merchants
 * - Precise boundary enforcement with HTTP 429 responses
 */

const Redis = require('ioredis');
const logger = require('../utils/logger');

class RateLimitService {
  constructor({ redisUrl, redisOptions } = {}) {
    this.redis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);
    
    // Default rate limits
    this.defaultLimits = {
      anonymous: {
        requestsPerMinute: 100,
        requestsPerHour: 1000,
        loginAttemptsPerMinute: 5,
        loginAttemptsPerHour: 20
      },
      authenticated: {
        requestsPerMinute: 300,
        requestsPerHour: 5000,
        loginAttemptsPerMinute: 10,
        loginAttemptsPerHour: 50
      },
      enterprise: {
        requestsPerMinute: 1000,
        requestsPerHour: 50000,
        loginAttemptsPerMinute: 50,
        loginAttemptsPerHour: 200
      }
    };

    // Token bucket configuration
    this.bucketCapacity = {
      anonymous: 100,
      authenticated: 300,
      enterprise: 1000
    };

    this.refillRate = {
      anonymous: 100 / 60, // 100 tokens per minute
      authenticated: 300 / 60, // 300 tokens per minute
      enterprise: 1000 / 60 // 1000 tokens per minute
    };

    // IP blacklist cache
    this.ipBlacklist = new Set();
    this.torExitNodes = new Set();
    
    // Webhook whitelist
    this.webhookWhitelist = new Set([
      'stripe.com',
      'api.stripe.com',
      'hooks.stripe.com',
      'webhooks.stripe.com',
      'paypal.com',
      'api.paypal.com',
      'github.com',
      'api.github.com'
    ]);

    // Initialize
    this.initialize();
  }

  /**
   * Initialize the rate limiter
   */
  async initialize() {
    try {
      // Load IP blacklist from Redis
      const blacklist = await this.redis.smembers('rate_limit:ip_blacklist');
      this.ipBlacklist = new Set(blacklist);

      // Load Tor exit nodes from Redis
      const torNodes = await this.redis.smembers('rate_limit:tor_exit_nodes');
      this.torExitNodes = new Set(torNodes);

      logger.info('[RateLimitService] Initialized', {
        blacklistSize: this.ipBlacklist.size,
        torNodesSize: this.torExitNodes.size
      });
    } catch (error) {
      logger.error('[RateLimitService] Initialization failed', {
        error: error.message
      });
    }
  }

  /**
   * Check if an IP is blacklisted
   * @param {string} ip - IP address
   * @returns {boolean}
   */
  isIPBlacklisted(ip) {
    return this.ipBlacklist.has(ip);
  }

  /**
   * Check if an IP is a Tor exit node
   * @param {string} ip - IP address
   * @returns {boolean}
   */
  isTorExitNode(ip) {
    return this.torExitNodes.has(ip);
  }

  /**
   * Check if a request is from a whitelisted webhook
   * @param {string} hostname - Request hostname
   * @returns {boolean}
   */
  isWebhookWhitelisted(hostname) {
    return this.webhookWhitelist.has(hostname) || 
           Array.from(this.webhookWhitelist).some(whitelisted => 
             hostname.endsWith(whitelisted)
           );
  }

  /**
   * Get rate limits for a tenant
   * @param {string} tenantId - Tenant ID
   * @param {string} apiKey - API key (optional)
   * @returns {object} Rate limits
   */
  async getTenantRateLimits(tenantId, apiKey = null) {
    try {
      // Check if tenant has custom rate limits (enterprise)
      const customLimits = await this.redis.hgetall(`rate_limit:tenant:${tenantId}`);
      
      if (customLimits && Object.keys(customLimits).length > 0) {
        return {
          requestsPerMinute: parseInt(customLimits.requestsPerMinute) || this.defaultLimits.enterprise.requestsPerMinute,
          requestsPerHour: parseInt(customLimits.requestsPerHour) || this.defaultLimits.enterprise.requestsPerHour,
          loginAttemptsPerMinute: parseInt(customLimits.loginAttemptsPerMinute) || this.defaultLimits.enterprise.loginAttemptsPerMinute,
          loginAttemptsPerHour: parseInt(customLimits.loginAttemptsPerHour) || this.defaultLimits.enterprise.loginAttemptsPerHour,
          isEnterprise: true
        };
      }

      // Check if authenticated
      if (apiKey) {
        return {
          ...this.defaultLimits.authenticated,
          isEnterprise: false
        };
      }

      // Default to anonymous limits
      return {
        ...this.defaultLimits.anonymous,
        isEnterprise: false
      };
    } catch (error) {
      logger.error('[RateLimitService] Failed to get tenant rate limits', {
        tenantId,
        error: error.message
      });
      return this.defaultLimits.anonymous;
    }
  }

  /**
   * Update rate limits for a tenant (enterprise)
   * @param {string} tenantId - Tenant ID
   * @param {object} limits - New rate limits
   * @returns {boolean}
   */
  async updateTenantRateLimits(tenantId, limits) {
    try {
      await this.redis.hset(`rate_limit:tenant:${tenantId}`, {
        requestsPerMinute: limits.requestsPerMinute,
        requestsPerHour: limits.requestsPerHour,
        loginAttemptsPerMinute: limits.loginAttemptsPerMinute,
        loginAttemptsPerHour: limits.loginAttemptsPerHour,
        updatedAt: new Date().toISOString()
      });

      logger.info('[RateLimitService] Updated tenant rate limits', {
        tenantId,
        limits
      });

      return true;
    } catch (error) {
      logger.error('[RateLimitService] Failed to update tenant rate limits', {
        tenantId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check rate limit using token bucket algorithm
   * @param {string} key - Rate limit key (e.g., "ip:1.2.3.4" or "tenant:123")
   * @param {object} limits - Rate limits
   * @param {number} tokensRequired - Tokens required for this request
   * @returns {object} Rate limit check result
   */
  async checkRateLimit(key, limits, tokensRequired = 1) {
    try {
      const now = Date.now();
      const bucketKey = `rate_limit:bucket:${key}`;
      
      // Get current bucket state
      const bucketData = await this.redis.hgetall(bucketKey);
      
      let tokens;
      let lastRefill;
      
      if (Object.keys(bucketData).length > 0) {
        tokens = parseFloat(bucketData.tokens);
        lastRefill = parseInt(bucketData.lastRefill);
      } else {
        // Initialize bucket
        tokens = limits.requestsPerMinute;
        lastRefill = now;
      }

      // Calculate time elapsed since last refill
      const timeElapsed = (now - lastRefill) / 1000; // in seconds
      
      // Refill tokens based on elapsed time
      const refillRate = limits.requestsPerMinute / 60; // tokens per second
      const tokensToAdd = Math.min(timeElapsed * refillRate, limits.requestsPerMinute);
      tokens = Math.min(tokens + tokensToAdd, limits.requestsPerMinute);

      // Check if we have enough tokens
      if (tokens >= tokensRequired) {
        // Consume tokens
        tokens -= tokensRequired;
        
        // Update bucket state
        await this.redis.hset(bucketKey, {
          tokens: tokens.toString(),
          lastRefill: now.toString()
        });
        
        // Set expiration (2x the refill period to allow for burst capacity)
        await this.redis.expire(bucketKey, 120);

        return {
          allowed: true,
          remaining: Math.floor(tokens),
          reset: new Date(now + 60000).toISOString(),
          limit: limits.requestsPerMinute
        };
      } else {
        // Rate limit exceeded
        const retryAfter = Math.ceil((tokensRequired - tokens) / refillRate);
        
        return {
          allowed: false,
          remaining: 0,
          reset: new Date(now + retryAfter * 1000).toISOString(),
          limit: limits.requestsPerMinute,
          retryAfter: Math.max(retryAfter, 1)
        };
      }
    } catch (error) {
      logger.error('[RateLimitService] Rate limit check failed', {
        key,
        error: error.message
      });
      
      // Fail open - allow request if Redis is down
      return {
        allowed: true,
        remaining: limits.requestsPerMinute,
        reset: new Date(Date.now() + 60000).toISOString(),
        limit: limits.requestsPerMinute,
        error: true
      };
    }
  }

  /**
   * Check login attempt rate limit
   * @param {string} ip - IP address
   * @param {string} tenantId - Tenant ID (optional)
   * @returns {object} Rate limit check result
   */
  async checkLoginRateLimit(ip, tenantId = null) {
    const key = tenantId ? `login:${tenantId}` : `login:${ip}`;
    const limits = tenantId ? 
      this.defaultLimits.authenticated : 
      this.defaultLimits.anonymous;

    return await this.checkRateLimit(key, {
      requestsPerMinute: limits.loginAttemptsPerMinute,
      requestsPerHour: limits.loginAttemptsPerHour
    });
  }

  /**
   * Check general API rate limit
   * @param {string} ip - IP address
   * @param {string} tenantId - Tenant ID (optional)
   * @param {string} apiKey - API key (optional)
   * @returns {object} Rate limit check result
   */
  async checkAPIRateLimit(ip, tenantId = null, apiKey = null) {
    // Use tenant ID if authenticated, otherwise use IP
    const key = tenantId ? `api:${tenantId}` : `api:${ip}`;
    
    const limits = await this.getTenantRateLimits(tenantId, apiKey);
    
    return await this.checkRateLimit(key, limits);
  }

  /**
   * Add IP to blacklist
   * @param {string} ip - IP address
   * @param {string} reason - Reason for blacklisting
   * @param {number} ttl - Time to live in seconds (default: 1 hour)
   */
  async blacklistIP(ip, reason = 'manual', ttl = 3600) {
    try {
      await this.redis.sadd('rate_limit:ip_blacklist', ip);
      await this.redis.expire('rate_limit:ip_blacklist', ttl);
      this.ipBlacklist.add(ip);

      logger.warn('[RateLimitService] IP blacklisted', {
        ip,
        reason,
        ttl
      });

      // Log to audit
      await this.redis.lpush('rate_limit:audit', JSON.stringify({
        action: 'blacklist',
        ip,
        reason,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      logger.error('[RateLimitService] Failed to blacklist IP', {
        ip,
        error: error.message
      });
    }
  }

  /**
   * Remove IP from blacklist
   * @param {string} ip - IP address
   */
  async unblacklistIP(ip) {
    try {
      await this.redis.srem('rate_limit:ip_blacklist', ip);
      this.ipBlacklist.delete(ip);

      logger.info('[RateLimitService] IP unblacklisted', { ip });
    } catch (error) {
      logger.error('[RateLimitService] Failed to unblacklist IP', {
        ip,
        error: error.message
      });
    }
  }

  /**
   * Add Tor exit node to list
   * @param {string} ip - IP address
   */
  async addTorExitNode(ip) {
    try {
      await this.redis.sadd('rate_limit:tor_exit_nodes', ip);
      this.torExitNodes.add(ip);

      logger.info('[RateLimitService] Tor exit node added', { ip });
    } catch (error) {
      logger.error('[RateLimitService] Failed to add Tor exit node', {
        ip,
        error: error.message
      });
    }
  }

  /**
   * Remove Tor exit node from list
   * @param {string} ip - IP address
   */
  async removeTorExitNode(ip) {
    try {
      await this.redis.srem('rate_limit:tor_exit_nodes', ip);
      this.torExitNodes.delete(ip);

      logger.info('[RateLimitService] Tor exit node removed', { ip });
    } catch (error) {
      logger.error('[RateLimitService] Failed to remove Tor exit node', {
        ip,
        error: error.message
      });
    }
  }

  /**
   * Get rate limit statistics
   * @returns {object} Statistics
   */
  async getStatistics() {
    try {
      const totalKeys = await this.redis.dbsize();
      const rateLimitKeys = await this.redis.keys('rate_limit:*');
      
      return {
        totalRedisKeys: totalKeys,
        rateLimitKeys: rateLimitKeys.length,
        blacklistedIPs: this.ipBlacklist.size,
        torExitNodes: this.torExitNodes.size,
        webhookWhitelisted: this.webhookWhitelist.size
      };
    } catch (error) {
      logger.error('[RateLimitService] Failed to get statistics', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Reset rate limit for a key
   * @param {string} key - Rate limit key
   */
  async resetRateLimit(key) {
    try {
      await this.redis.del(`rate_limit:bucket:${key}`);
      logger.info('[RateLimitService] Rate limit reset', { key });
    } catch (error) {
      logger.error('[RateLimitService] Failed to reset rate limit', {
        key,
        error: error.message
      });
    }
  }

  /**
   * Cleanup expired rate limit entries
   */
  async cleanup() {
    try {
      // Redis automatically expires keys, but we can force cleanup if needed
      const keys = await this.redis.keys('rate_limit:bucket:*');
      let cleaned = 0;

      for (const key of keys) {
        const ttl = await this.redis.ttl(key);
        if (ttl === -1) { // No expiration set
          await this.redis.expire(key, 120);
          cleaned++;
        }
      }

      logger.info('[RateLimitService] Cleanup completed', { cleaned });
    } catch (error) {
      logger.error('[RateLimitService] Cleanup failed', {
        error: error.message
      });
    }
  }

  /**
   * Close Redis connection
   */
  async close() {
    await this.redis.quit();
    logger.info('[RateLimitService] Redis connection closed');
  }
}

module.exports = RateLimitService;
