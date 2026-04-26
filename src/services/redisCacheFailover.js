/**
 * Redis Cache Failover Handler
 * 
 * This module ensures Redis caches are cleared upon failover to prevent stale data
 * from corrupting the new primary region. It provides mechanisms for:
 * - Complete cache invalidation
 * - Selective cache clearing by pattern
 * - Cache warming after failover
 * - Monitoring cache health
 */

const redis = require('redis');

class RedisCacheFailoverHandler {
  constructor(config) {
    this.config = config;
    this.redisClient = null;
    this.isConnected = false;
    this.cacheStats = {
      totalKeys: 0,
      clearedKeys: 0,
      clearedPatterns: [],
      timestamp: null
    };
  }

  /**
   * Initialize Redis connection
   */
  async initialize() {
    try {
      this.redisClient = redis.createClient({
        socket: {
          host: this.config.redis.host,
          port: this.config.redis.port,
          tls: this.config.redis.tls || {}
        },
        password: this.config.redis.password,
        database: this.config.redis.database || 0
      });

      this.redisClient.on('error', (err) => {
        console.error('[RedisFailover] Redis client error:', err);
      });

      this.redisClient.on('connect', () => {
        console.log('[RedisFailover] Redis client connected');
        this.isConnected = true;
      });

      this.redisClient.on('disconnect', () => {
        console.warn('[RedisFailover] Redis client disconnected');
        this.isConnected = false;
      });

      await this.redisClient.connect();
      console.log('[RedisFailover] Initialized successfully');
    } catch (error) {
      console.error('[RedisFailover] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Get total number of keys in Redis
   */
  async getDbSize() {
    try {
      if (!this.isConnected) {
        await this.initialize();
      }
      const size = await this.redisClient.dbSize();
      return size;
    } catch (error) {
      console.error('[RedisFailover] Failed to get DB size:', error.message);
      throw error;
    }
  }

  /**
   * Clear all caches (FLUSHALL)
   * This is the most aggressive option and should be used during failover
   */
  async clearAllCaches() {
    try {
      console.log('[RedisFailover] Clearing all caches...');
      
      if (!this.isConnected) {
        await this.initialize();
      }

      const beforeSize = await this.getDbSize();
      console.log(`[RedisFailover] Cache size before clear: ${beforeSize}`);

      // Flush all databases
      await this.redisClient.flushAll();
      
      const afterSize = await this.getDbSize();
      console.log(`[RedisFailover] Cache size after clear: ${afterSize}`);

      this.cacheStats = {
        totalKeys: beforeSize,
        clearedKeys: beforeSize - afterSize,
        clearedPatterns: ['ALL'],
        timestamp: new Date().toISOString()
      };

      console.log('[RedisFailover] All caches cleared successfully');
      return {
        success: true,
        beforeSize,
        afterSize,
        clearedKeys: this.cacheStats.clearedKeys,
        timestamp: this.cacheStats.timestamp
      };
    } catch (error) {
      console.error('[RedisFailover] Failed to clear all caches:', error.message);
      throw error;
    }
  }

  /**
   * Clear caches by pattern
   * More selective option for specific cache types
   */
  async clearCacheByPattern(pattern) {
    try {
      console.log(`[RedisFailover] Clearing caches matching pattern: ${pattern}`);
      
      if (!this.isConnected) {
        await this.initialize();
      }

      const beforeSize = await this.getDbSize();
      
      // Get all keys matching the pattern
      const keys = await this.redisClient.keys(pattern);
      
      if (keys.length === 0) {
        console.log(`[RedisFailover] No keys found matching pattern: ${pattern}`);
        return {
          success: true,
          pattern,
          clearedKeys: 0,
          timestamp: new Date().toISOString()
        };
      }

      // Delete all matching keys
      await this.redisClient.del(keys);
      
      const afterSize = await this.getDbSize();
      console.log(`[RedisFailover] Cleared ${keys.length} keys matching pattern: ${pattern}`);

      this.cacheStats.clearedPatterns.push(pattern);
      
      return {
        success: true,
        pattern,
        clearedKeys: keys.length,
        beforeSize,
        afterSize,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[RedisFailover] Failed to clear cache by pattern:', error.message);
      throw error;
    }
  }

  /**
   * Clear specific cache categories
   */
  async clearCacheCategories(categories) {
    try {
      console.log('[RedisFailover] Clearing specific cache categories...');
      
      const patterns = {
        user_sessions: 'session:*',
        api_cache: 'api:*',
        subscription_cache: 'subscription:*',
        video_cache: 'video:*',
        analytics_cache: 'analytics:*',
        rate_limit: 'ratelimit:*',
        device_fingerprint: 'device:*',
        ip_intelligence: 'ip:*',
        behavioral_biometric: 'behavioral:*'
      };

      const results = [];
      
      for (const category of categories) {
        if (patterns[category]) {
          const result = await this.clearCacheByPattern(patterns[category]);
          results.push({
            category,
            ...result
          });
        }
      }

      return {
        success: true,
        results,
        totalCleared: results.reduce((sum, r) => sum + r.clearedKeys, 0),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[RedisFailover] Failed to clear cache categories:', error.message);
      throw error;
    }
  }

  /**
   * Clear all application caches (selective failover)
   * Clears only application-specific caches, preserving system caches
   */
  async clearApplicationCaches() {
    try {
      console.log('[RedisFailover] Clearing application caches...');
      
      const categories = [
        'user_sessions',
        'api_cache',
        'subscription_cache',
        'video_cache',
        'analytics_cache',
        'rate_limit',
        'device_fingerprint',
        'ip_intelligence',
        'behavioral_biometric'
      ];

      return await this.clearCacheCategories(categories);
    } catch (error) {
      console.error('[RedisFailover] Failed to clear application caches:', error.message);
      throw error;
    }
  }

  /**
   * Warm up cache with frequently accessed data
   * This should be called after failover to improve performance
   */
  async warmUpCache(warmupData) {
    try {
      console.log('[RedisFailover] Warming up cache...');
      
      if (!this.isConnected) {
        await this.initialize();
      }

      const warmedKeys = [];

      for (const item of warmupData) {
        try {
          await this.redisClient.set(item.key, item.value, {
            EX: item.ttl || 3600 // Default 1 hour TTL
          });
          warmedKeys.push(item.key);
        } catch (error) {
          console.error(`[RedisFailover] Failed to warm up key ${item.key}:`, error.message);
        }
      }

      console.log(`[RedisFailover] Warmed up ${warmedKeys.length} cache keys`);
      
      return {
        success: true,
        warmedKeys,
        count: warmedKeys.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[RedisFailover] Failed to warm up cache:', error.message);
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      if (!this.isConnected) {
        await this.initialize();
      }

      const info = await this.redisClient.info('stats');
      const memory = await this.redisClient.info('memory');
      const dbSize = await this.getDbSize();

      return {
        dbSize,
        info: this.parseRedisInfo(info),
        memory: this.parseRedisInfo(memory),
        lastClearStats: this.cacheStats,
        isConnected: this.isConnected,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[RedisFailover] Failed to get cache stats:', error.message);
      throw error;
    }
  }

  /**
   * Parse Redis INFO output
   */
  parseRedisInfo(info) {
    const lines = info.split('\n');
    const result = {};
    
    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        result[key.trim()] = value.trim();
      }
    }
    
    return result;
  }

  /**
   * Handle failover event
   * Main entry point for failover cache clearing
   */
  async handleFailover(options = {}) {
    console.log('[RedisFailover] Handling failover event...');
    
    try {
      const strategy = options.strategy || 'all'; // 'all', 'application', 'selective'
      
      let result;
      
      switch (strategy) {
        case 'all':
          result = await this.clearAllCaches();
          break;
        case 'application':
          result = await this.clearApplicationCaches();
          break;
        case 'selective':
          if (options.patterns) {
            const results = [];
            for (const pattern of options.patterns) {
              const r = await this.clearCacheByPattern(pattern);
              results.push(r);
            }
            result = {
              success: true,
              results,
              totalCleared: results.reduce((sum, r) => sum + r.clearedKeys, 0),
              timestamp: new Date().toISOString()
            };
          } else {
            throw new Error('Selective strategy requires patterns array');
          }
          break;
        default:
          throw new Error(`Unknown strategy: ${strategy}`);
      }

      // Warm up cache if warmup data provided
      if (options.warmupData && options.warmupData.length > 0) {
        const warmupResult = await this.warmUpCache(options.warmupData);
        result.warmup = warmupResult;
      }

      console.log('[RedisFailover] Failover handled successfully');
      return result;
    } catch (error) {
      console.error('[RedisFailover] Failed to handle failover:', error.message);
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      if (!this.isConnected) {
        await this.initialize();
      }

      const ping = await this.redisClient.ping();
      const dbSize = await this.getDbSize();
      
      return {
        healthy: ping === 'PONG',
        connected: this.isConnected,
        dbSize,
        lastClearStats: this.cacheStats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        healthy: false,
        connected: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Close Redis connection
   */
  async close() {
    try {
      if (this.redisClient && this.isConnected) {
        await this.redisClient.quit();
        this.isConnected = false;
        console.log('[RedisFailover] Redis connection closed');
      }
    } catch (error) {
      console.error('[RedisFailover] Failed to close connection:', error.message);
      throw error;
    }
  }
}

// Singleton instance
let cacheFailoverHandlerInstance = null;

/**
 * Get or create the RedisCacheFailoverHandler singleton
 */
function getRedisCacheFailoverHandler(config) {
  if (!cacheFailoverHandlerInstance) {
    cacheFailoverHandlerInstance = new RedisCacheFailoverHandler(config);
  }
  return cacheFailoverHandlerInstance;
}

/**
 * Reset the singleton (useful for testing)
 */
function resetRedisCacheFailoverHandler() {
  if (cacheFailoverHandlerInstance) {
    cacheFailoverHandlerInstance.close().catch(err => {
      console.error('[RedisFailover] Error during cleanup:', err.message);
    });
  }
  cacheFailoverHandlerInstance = null;
}

module.exports = {
  RedisCacheFailoverHandler,
  getRedisCacheFailoverHandler,
  resetRedisCacheFailoverHandler
};
