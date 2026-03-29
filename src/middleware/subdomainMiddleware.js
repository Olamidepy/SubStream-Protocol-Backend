const url = require('url');

/**
 * Subdomain routing middleware for multi-tenant architecture.
 * Resolves creator subdomains to creator_id and sets request context.
 */
class SubdomainMiddleware {
  /**
   * @param {object} database Database instance
   * @param {object} config Application configuration
   */
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.baseDomain = config.substream?.baseDomain || 'substream.app';
    this.cache = new Map(); // Simple in-memory cache for subdomain lookups
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Express middleware function.
   * @param {import('express').Request} req Request object
   * @param {import('express').Response} res Response object
   * @param {import('express').NextFunction} next Next function
   */
  middleware() {
    return (req, res, next) => {
      try {
        const hostname = req.hostname || req.headers.host;
        
        // Skip subdomain resolution for API routes and direct access
        if (this.shouldSkipSubdomainResolution(req.path)) {
          return next();
        }

        const subdomain = this.extractSubdomain(hostname);
        
        if (!subdomain) {
          // No subdomain, serve main platform
          return next();
        }

        // Resolve subdomain to creator
        const creatorInfo = this.resolveSubdomain(subdomain);
        
        if (!creatorInfo) {
          return res.status(404).json({
            error: 'Creator not found',
            message: `The subdomain "${subdomain}" is not registered.`
          });
        }

        // Set creator context on request
        req.creatorContext = {
          creatorId: creatorInfo.creatorId,
          subdomain: subdomain,
          isSubdomainRequest: true
        };

        // Add CORS headers for subdomain requests
        res.header('Access-Control-Allow-Origin', `https://${subdomain}.${this.baseDomain}`);
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

        next();
      } catch (error) {
        console.error('Subdomain middleware error:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to resolve subdomain'
        });
      }
    };
  }

  /**
   * Extract subdomain from hostname.
   * @param {string} hostname Full hostname
   * @returns {string|null} Subdomain or null if not found
   */
  extractSubdomain(hostname) {
    if (!hostname) return null;

    // Remove port if present
    const cleanHost = hostname.split(':')[0];
    
    // Remove www prefix if present
    const hostWithoutWww = cleanHost.replace(/^www\./, '');
    
    // Check if this is a subdomain of our base domain
    const baseDomainParts = this.baseDomain.split('.');
    const hostParts = hostWithoutWww.split('.');

    if (hostParts.length <= baseDomainParts.length) {
      return null; // Not a subdomain
    }

    // Extract subdomain (everything before the base domain)
    const subdomainParts = hostParts.slice(0, -baseDomainParts.length);
    return subdomainParts.join('.');
  }

  /**
   * Resolve subdomain to creator information.
   * @param {string} subdomain Subdomain name
   * @returns {object|null} Creator information or null if not found
   */
  resolveSubdomain(subdomain) {
    // Check cache first
    const cacheKey = `subdomain:${subdomain}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    // Look up in database
    const subdomainRecord = this.database.getCreatorSubdomainByName(subdomain);
    
    if (!subdomainRecord) {
      return null;
    }

    const creatorInfo = {
      creatorId: subdomainRecord.creatorId,
      subdomain: subdomainRecord.subdomain,
      status: subdomainRecord.status
    };

    // Cache the result
    this.cache.set(cacheKey, {
      data: creatorInfo,
      timestamp: Date.now()
    });

    return creatorInfo;
  }

  /**
   * Check if subdomain resolution should be skipped for certain paths.
   * @param {string} path Request path
   * @returns {boolean} True if should skip
   */
  shouldSkipSubdomainResolution(path) {
    const skipPaths = [
      '/api/',
      '/health',
      '/metrics',
      '/.well-known/',
      '/robots.txt',
      '/favicon.ico'
    ];

    return skipPaths.some(skipPath => path.startsWith(skipPath));
  }

  /**
   * Clear the subdomain cache.
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get creator context from request.
   * @param {import('express').Request} req Request object
   * @returns {object|null} Creator context or null
   */
  static getCreatorContext(req) {
    return req.creatorContext || null;
  }

  /**
   * Check if request is from a creator subdomain.
   * @param {import('express').Request} req Request object
   * @returns {boolean} True if subdomain request
   */
  static isSubdomainRequest(req) {
    return !!(req.creatorContext && req.creatorContext.isSubdomainRequest);
  }

  /**
   * Get creator ID from request context.
   * @param {import('express').Request} req Request object
   * @returns {string|null} Creator ID or null
   */
  static getCreatorId(req) {
    return req.creatorContext ? req.creatorContext.creatorId : null;
  }
}

module.exports = {
  SubdomainMiddleware
};
