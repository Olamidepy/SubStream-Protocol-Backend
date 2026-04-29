const usageQuotaService = require('../services/usageQuota');

class UsageTrackingMiddleware {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) {
      await usageQuotaService.initialize();
      this.initialized = true;
    }
  }

  // Main middleware function for tracking and rate limiting
  async usageTracker(req, res, next) {
    const startTime = Date.now();
    
    try {
      await this.initialize();
      
      // Extract API key from headers
      const apiKey = this.extractApiKey(req);
      
      if (!apiKey) {
        return res.status(401).json({
          error: 'API key required',
          message: 'Please provide a valid API key in the X-API-Key header',
        });
      }

      // Validate API key and get tier information
      const keyInfo = await usageQuotaService.validateApiKey(apiKey);
      
      if (!keyInfo) {
        return res.status(401).json({
          error: 'Invalid API key',
          message: 'The provided API key is invalid or has been deactivated',
        });
      }

      // Check quotas
      const [hourlyQuota, monthlyQuota] = await Promise.all([
        usageQuotaService.checkHourlyQuota(keyInfo.id, keyInfo.tier),
        usageQuotaService.checkMonthlyQuota(keyInfo.id, keyInfo.tier),
      ]);

      // Check if quotas are exceeded
      if (!hourlyQuota.allowed) {
        return this.handleRateLimit(res, 'hourly', hourlyQuota, keyInfo.tier);
      }

      if (!monthlyQuota.allowed) {
        return this.handleRateLimit(res, 'monthly', monthlyQuota, keyInfo.tier);
      }

      // Add usage info to request object for downstream use
      req.usageInfo = {
        apiKeyId: keyInfo.id,
        tier: keyInfo.tier,
        developerId: keyInfo.developer_id,
        subscriptionStatus: keyInfo.subscription_status,
        hourlyQuota,
        monthlyQuota,
      };

      // Add usage headers to response
      res.set({
        'X-RateLimit-Limit-Hourly': hourlyQuota.limit,
        'X-RateLimit-Remaining-Hourly': hourlyQuota.remaining,
        'X-RateLimit-Limit-Monthly': monthlyQuota.limit,
        'X-RateLimit-Remaining-Monthly': monthlyQuota.remaining,
        'X-API-Tier': keyInfo.tier,
      });

      // Override res.end to track response
      const originalEnd = res.end;
      res.end = function(chunk, encoding) {
        const responseTime = Date.now() - startTime;
        
        // Track usage asynchronously (non-blocking)
        usageQuotaService.incrementUsage(
          req.usageInfo.apiKeyId,
          req.path,
          req.method,
          res.statusCode,
          responseTime,
          req.ip,
          req.get('User-Agent')
        ).catch(error => {
          console.error('Failed to track usage:', error);
        });

        // Call original end
        originalEnd.call(this, chunk, encoding);
      };

      next();
    } catch (error) {
      console.error('Usage tracking middleware error:', error);
      // Fail open - allow request but log error
      next();
    }
  }

  // Extract API key from various sources
  extractApiKey(req) {
    // Try header first
    const apiKey = req.get('X-API-Key') || req.get('x-api-key');
    if (apiKey) return apiKey;

    // Try query parameter
    if (req.query && req.query.api_key) {
      return req.query.api_key;
    }

    // Try authorization header (Bearer token)
    const authHeader = req.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }

  // Handle rate limit exceeded scenarios
  handleRateLimit(res, type, quota, tier) {
    const messages = {
      hourly: {
        standard: 'Hourly rate limit exceeded. Standard tier allows 1,000 requests per hour. Upgrade to Premium for 10,000 requests per hour.',
        premium: 'Hourly rate limit exceeded. Premium tier allows 10,000 requests per hour. Contact support for higher limits.',
      },
      monthly: {
        standard: 'Monthly rate limit exceeded. Standard tier allows 10,000 requests per month. Upgrade to Premium for 100,000 requests per month.',
        premium: 'Monthly rate limit exceeded. Premium tier allows 100,000 requests per month. Contact support for enterprise options.',
      },
    };

    const message = messages[type][tier];
    const retryAfter = type === 'hourly' ? 3600 : 86400; // 1 hour or 1 day

    return res.status(429).json({
      error: 'Rate limit exceeded',
      message,
      tier,
      quota: {
        type,
        current: quota.current,
        limit: quota.limit,
        remaining: quota.remaining,
      },
      retryAfter,
      upgradeUrl: tier === 'standard' ? 'https://substream.protocol/billing/upgrade' : 'https://substream.protocol/support',
    });
  }

  // Middleware for public endpoints (no API key required)
  publicTracker(req, res, next) {
    const startTime = Date.now();
    
    // Override res.end to track response for analytics
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      const responseTime = Date.now() - startTime;
      
      // Log public endpoint usage for analytics
      console.log(`Public endpoint: ${req.method} ${req.path} - ${res.statusCode} - ${responseTime}ms`);

      originalEnd.call(this, chunk, encoding);
    };

    next();
  }
}

module.exports = new UsageTrackingMiddleware();
