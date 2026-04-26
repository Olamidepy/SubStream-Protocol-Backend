/**
 * Rate Limiting Middleware
 * 
 * Express middleware that enforces rate limits using the token bucket algorithm.
 * Returns HTTP 429 with Retry-After header when limits are exceeded.
 * Differentiates between authenticated and anonymous traffic.
 */

const RateLimitService = require('../services/rateLimitService');
const logger = require('../utils/logger');

class RateLimitMiddleware {
  constructor(options = {}) {
    this.rateLimitService = options.rateLimitService || new RateLimitService();
    
    // Middleware configuration
    this.skipSuccessfulRequests = options.skipSuccessfulRequests || false;
    this.skipFailedRequests = options.skipFailedRequests || false;
    this.enableWebhookWhitelist = options.enableWebhookWhitelist !== false;
    this.enableIPBlacklist = options.enableIPBlacklist !== false;
    this.enableTorBlocking = options.enableTorBlocking !== false;
    
    // Headers to add to responses
    this.addHeaders = options.addHeaders !== false;
  }

  /**
   * Extract client IP from request
   * @param {object} req - Express request
   * @returns {string} IP address
   */
  getClientIP(req) {
    return req.ip || 
           req.connection?.remoteAddress || 
           req.socket?.remoteAddress ||
           (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
           '0.0.0.0';
  }

  /**
   * Extract tenant ID from request
   * @param {object} req - Express request
   * @returns {string|null} Tenant ID
   */
  getTenantId(req) {
    return req.user?.tenantId || 
           req.tenantId || 
           req.headers['x-tenant-id'] || 
           null;
  }

  /**
   * Extract API key from request
   * @param {object} req - Express request
   * @returns {string|null} API key
   */
  getAPIKey(req) {
    return req.headers['x-api-key'] || 
           req.query.api_key || 
           req.user?.apiKey || 
           null;
  }

  /**
   * Check if request is from a whitelisted webhook
   * @param {object} req - Express request
   * @returns {boolean}
   */
  isWebhookRequest(req) {
    const hostname = req.hostname || req.headers['host'] || '';
    const userAgent = req.headers['user-agent'] || '';
    const path = req.path || '';

    // Check hostname whitelist
    if (this.enableWebhookWhitelist && this.rateLimitService.isWebhookWhitelisted(hostname)) {
      return true;
    }

    // Check for common webhook paths
    const webhookPaths = ['/webhook', '/webhooks', '/hooks', '/callback'];
    if (webhookPaths.some(wp => path.startsWith(wp))) {
      return true;
    }

    // Check for known webhook user agents
    const webhookUserAgents = ['Stripe', 'PayPal', 'GitHub', 'webhook'];
    if (webhookUserAgents.some(ua => userAgent.includes(ua))) {
      return true;
    }

    return false;
  }

  /**
   * Rate limiting middleware for general API requests
   */
  apiRateLimit() {
    return async (req, res, next) => {
      try {
        const ip = this.getClientIP(req);
        const tenantId = this.getTenantId(req);
        const apiKey = this.getAPIKey(req);

        // Skip webhook requests if whitelist is enabled
        if (this.enableWebhookWhitelist && this.isWebhookRequest(req)) {
          logger.debug('[RateLimit] Skipping whitelisted webhook request', {
            ip,
            path: req.path
          });
          return next();
        }

        // Check IP blacklist
        if (this.enableIPBlacklist && this.rateLimitService.isIPBlacklisted(ip)) {
          logger.warn('[RateLimit] Blocked blacklisted IP', {
            ip,
            path: req.path,
            userAgent: req.headers['user-agent']
          });

          return res.status(403).json({
            error: 'Forbidden',
            message: 'Your IP has been blocked due to suspicious activity',
            code: 'IP_BLOCKED'
          });
        }

        // Check Tor exit nodes
        if (this.enableTorBlocking && this.rateLimitService.isTorExitNode(ip)) {
          logger.warn('[RateLimit] Blocked Tor exit node', {
            ip,
            path: req.path
          });

          return res.status(403).json({
            error: 'Forbidden',
            message: 'Access from Tor exit nodes is not allowed',
            code: 'TOR_BLOCKED'
          });
        }

        // Check rate limit
        const result = await this.rateLimitService.checkAPIRateLimit(ip, tenantId, apiKey);

        // Add rate limit headers to response
        if (this.addHeaders) {
          res.setHeader('X-RateLimit-Limit', result.limit);
          res.setHeader('X-RateLimit-Remaining', result.remaining);
          res.setHeader('X-RateLimit-Reset', result.reset);
        }

        if (!result.allowed) {
          logger.warn('[RateLimit] Rate limit exceeded', {
            ip,
            tenantId,
            path: req.path,
            limit: result.limit,
            remaining: result.remaining,
            retryAfter: result.retryAfter
          });

          // Return 429 with Retry-After header
          res.setHeader('Retry-After', result.retryAfter);
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please retry later.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: result.retryAfter,
            limit: result.limit,
            reset: result.reset
          });
        }

        // Add rate limit info to request for downstream use
        req.rateLimit = {
          limit: result.limit,
          remaining: result.remaining,
          reset: result.reset
        };

        next();
      } catch (error) {
        logger.error('[RateLimit] Middleware error', {
          error: error.message,
          path: req.path
        });

        // Fail open - allow request if middleware fails
        next();
      }
    };
  }

  /**
   * Rate limiting middleware for login attempts
   */
  loginRateLimit() {
    return async (req, res, next) => {
      try {
        const ip = this.getClientIP(req);
        const tenantId = this.getTenantId(req);

        // Check rate limit
        const result = await this.rateLimitService.checkLoginRateLimit(ip, tenantId);

        // Add rate limit headers
        if (this.addHeaders) {
          res.setHeader('X-RateLimit-Limit', result.limit);
          res.setHeader('X-RateLimit-Remaining', result.remaining);
          res.setHeader('X-RateLimit-Reset', result.reset);
        }

        if (!result.allowed) {
          logger.warn('[RateLimit] Login rate limit exceeded', {
            ip,
            tenantId,
            retryAfter: result.retryAfter
          });

          res.setHeader('Retry-After', result.retryAfter);
          return res.status(429).json({
            error: 'Too Many Login Attempts',
            message: 'Too many login attempts. Please try again later.',
            code: 'LOGIN_RATE_LIMIT_EXCEEDED',
            retryAfter: result.retryAfter,
            reset: result.reset
          });
        }

        next();
      } catch (error) {
        logger.error('[RateLimit] Login middleware error', {
          error: error.message
        });

        // Fail open
        next();
      }
    };
  }

  /**
   * Rate limiting middleware for specific endpoints with custom limits
   * @param {object} customLimits - Custom rate limits
   */
  customRateLimit(customLimits) {
    return async (req, res, next) => {
      try {
        const ip = this.getClientIP(req);
        const tenantId = this.getTenantId(req);
        const apiKey = this.getAPIKey(req);

        // Skip webhook requests
        if (this.enableWebhookWhitelist && this.isWebhookRequest(req)) {
          return next();
        }

        // Check IP blacklist
        if (this.enableIPBlacklist && this.rateLimitService.isIPBlacklisted(ip)) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Your IP has been blocked',
            code: 'IP_BLOCKED'
          });
        }

        // Use custom limits
        const result = await this.rateLimitService.checkRateLimit(
          tenantId ? `custom:${tenantId}` : `custom:${ip}`,
          customLimits
        );

        if (this.addHeaders) {
          res.setHeader('X-RateLimit-Limit', result.limit);
          res.setHeader('X-RateLimit-Remaining', result.remaining);
          res.setHeader('X-RateLimit-Reset', result.reset);
        }

        if (!result.allowed) {
          res.setHeader('Retry-After', result.retryAfter);
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded for this endpoint',
            code: 'CUSTOM_RATE_LIMIT_EXCEEDED',
            retryAfter: result.retryAfter,
            reset: result.reset
          });
        }

        next();
      } catch (error) {
        logger.error('[RateLimit] Custom middleware error', {
          error: error.message
        });

        next();
      }
    };
  }

  /**
   * Middleware to block headless browsers
   */
  blockHeadlessBrowsers() {
    return (req, res, next) => {
      const userAgent = req.headers['user-agent'] || '';
      
      // Common headless browser signatures
      const headlessSignatures = [
        'HeadlessChrome',
        'PhantomJS',
        'SlimerJS',
        'HtmlUnit',
        'JSoup',
        'python-requests',
        'curl',
        'wget',
        'axios',
        'node-fetch',
        'Go-http-client',
        'Java',
        'Apache-HttpClient'
      ];

      const isHeadless = headlessSignatures.some(signature => 
        userAgent.includes(signature)
      );

      if (isHeadless && !this.isWebhookRequest(req)) {
        logger.warn('[RateLimit] Blocked headless browser', {
          ip: this.getClientIP(req),
          userAgent,
          path: req.path
        });

        return res.status(403).json({
          error: 'Forbidden',
          message: 'Automated browsers are not allowed',
          code: 'HEADLESS_BROWSER_BLOCKED'
        });
      }

      next();
    };
  }

  /**
   * Middleware to require API key authentication
   */
  requireAPIKey() {
    return (req, res, next) => {
      const apiKey = this.getAPIKey(req);

      if (!apiKey) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'API key is required',
          code: 'API_KEY_REQUIRED'
        });
      }

      // Add API key to request for downstream use
      req.apiKey = apiKey;
      next();
    };
  }
}

// Factory function for creating middleware instances
function createRateLimitMiddleware(options = {}) {
  const middleware = new RateLimitMiddleware(options);
  
  return {
    apiRateLimit: middleware.apiRateLimit.bind(middleware),
    loginRateLimit: middleware.loginRateLimit.bind(middleware),
    customRateLimit: middleware.customRateLimit.bind(middleware),
    blockHeadlessBrowsers: middleware.blockHeadlessBrowsers.bind(middleware),
    requireAPIKey: middleware.requireAPIKey.bind(middleware),
    getService: () => middleware.rateLimitService
  };
}

module.exports = createRateLimitMiddleware;
