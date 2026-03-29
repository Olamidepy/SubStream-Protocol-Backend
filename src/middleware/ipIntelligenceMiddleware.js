const { logger } = require('../utils/logger');
const { getRequestIp } = require('../utils/requestIp');

/**
 * IP Intelligence Middleware for SIWS flow and fraud prevention
 * Provides active defense against VPNs, Tor, and high-risk IP addresses
 */
class IPIntelligenceMiddleware {
  constructor(ipIntelligenceService, config = {}) {
    this.ipService = ipIntelligenceService;
    this.config = {
      // Risk level restrictions
      restrictions: {
        // Actions that require different risk levels
        critical: {
          maxRiskLevel: config.critical?.maxRiskLevel || 'low',
          actions: ['create_creator', 'high_value_withdrawal', 'bulk_operations']
        },
        high: {
          maxRiskLevel: config.high?.maxRiskLevel || 'medium',
          actions: ['create_subscription', 'upload_content', 'update_settings']
        },
        medium: {
          maxRiskLevel: config.medium?.maxRiskLevel || 'high',
          actions: ['view_content', 'basic_operations']
        }
      },
      // SIWS specific settings
      siws: {
        enabled: config.siws?.enabled !== false,
        maxRiskLevel: config.siws?.maxRiskLevel || 'medium',
        requireAdditionalVerification: config.siws?.requireAdditionalVerification || true,
        blockHighRisk: config.siws?.blockHighRisk !== false
      },
      // Response configuration
      responses: {
        blocked: {
          status: 403,
          message: 'Access denied due to security restrictions',
          code: 'IP_BLOCKED'
        },
        restricted: {
          status: 429,
          message: 'Additional verification required',
          code: 'IP_RESTRICTED'
        },
        monitored: {
          status: 200,
          message: 'Request allowed with enhanced monitoring',
          code: 'IP_MONITORED'
        }
      },
      // Monitoring settings
      monitoring: {
        logAllRequests: config.monitoring?.logAllRequests || false,
        logHighRiskOnly: config.monitoring?.logHighRiskOnly !== false,
        alertThreshold: config.monitoring?.alertThreshold || 80,
        trackReputation: config.monitoring?.trackReputation !== false
      },
      ...config
    };

    // IP reputation tracking
    this.ipReputation = new Map();
    this.loadReputationData();
  }

  /**
   * Create middleware for SIWS authentication flow
   * @returns {Function} Express middleware
   */
  createSIWSMiddleware() {
    return async (req, res, next) => {
      try {
        if (!this.config.siws.enabled) {
          return next();
        }

        const ipAddress = getRequestIp(req);
        
        if (!ipAddress) {
          logger.warn('Unable to determine IP address for SIWS request', {
            userAgent: req.get('User-Agent'),
            traceId: req.logger?.fields?.traceId
          });
          return next(); // Allow but log
        }

        // Assess IP risk
        const riskAssessment = await this.ipService.assessIPRisk(ipAddress, {
          context: 'siws_auth',
          userAgent: req.get('User-Agent')
        });

        // Update IP reputation
        this.updateIPReputation(ipAddress, 'siws_attempt', riskAssessment.riskScore);

        // Check if IP should be blocked
        if (this.shouldBlockIP(riskAssessment, 'siws')) {
          logger.warn('SIWS request blocked - high risk IP', {
            ipAddress,
            riskScore: riskAssessment.riskScore,
            riskLevel: riskAssessment.riskLevel,
            riskFactors: riskAssessment.riskFactors,
            userAgent: req.get('User-Agent'),
            traceId: req.logger?.fields?.traceId
          });

          return res.status(this.config.responses.blocked.status).json({
            success: false,
            error: this.config.responses.blocked.message,
            code: this.config.responses.blocked.code,
            metadata: {
              riskLevel: riskAssessment.riskLevel,
              reason: 'High risk IP detected during authentication'
            }
          });
        }

        // Check if additional verification is required
        if (this.requiresAdditionalVerification(riskAssessment, 'siws')) {
          logger.info('SIWS request requires additional verification', {
            ipAddress,
            riskScore: riskAssessment.riskScore,
            riskLevel: riskAssessment.riskLevel,
            traceId: req.logger?.fields?.traceId
          });

          // Add verification requirement to request
          req.ipIntelligence = {
            ...riskAssessment,
            requiresAdditionalVerification: true,
            allowedActions: this.getAllowedActions(riskAssessment, 'siws')
          };

          return res.status(this.config.responses.restricted.status).json({
            success: false,
            error: this.config.responses.restricted.message,
            code: this.config.responses.restricted.code,
            metadata: {
              riskLevel: riskAssessment.riskLevel,
              requiresAdditionalVerification: true,
              allowedActions: req.ipIntelligence.allowedActions
            }
          });
        }

        // Add IP intelligence to request for monitoring
        req.ipIntelligence = {
          ...riskAssessment,
          allowedActions: this.getAllowedActions(riskAssessment, 'siws'),
          requiresAdditionalVerification: false
        };

        // Log if monitoring is enabled
        if (this.config.monitoring.logHighRiskOnly && riskAssessment.riskScore >= this.config.monitoring.alertThreshold) {
          logger.warn('High risk IP allowed in SIWS flow', {
            ipAddress,
            riskScore: riskAssessment.riskScore,
            riskLevel: riskAssessment.riskLevel,
            riskFactors: riskAssessment.riskFactors,
            traceId: req.logger?.fields?.traceId
          });
        }

        next();

      } catch (error) {
        logger.error('IP intelligence middleware error in SIWS flow', {
          error: error.message,
          ipAddress: getRequestIp(req),
          traceId: req.logger?.fields?.traceId
        });

        // Fail safe - allow but monitor
        req.ipIntelligence = {
          error: error.message,
          riskScore: 50,
          riskLevel: 'medium'
        };
        next();
      }
    };
  }

  /**
   * Create middleware for general IP intelligence checks
   * @param {string} actionType - Type of action being performed
   * @returns {Function} Express middleware
   */
  createGeneralMiddleware(actionType) {
    return async (req, res, next) => {
      try {
        const ipAddress = getRequestIp(req);
        
        if (!ipAddress) {
          return next(); // Allow but log
        }

        // Assess IP risk
        const riskAssessment = await this.ipService.assessIPRisk(ipAddress, {
          context: actionType,
          userAgent: req.get('User-Agent'),
          endpoint: req.path,
          method: req.method
        });

        // Update IP reputation
        this.updateIPReputation(ipAddress, actionType, riskAssessment.riskScore);

        // Check if action is allowed for this risk level
        if (!this.isActionAllowed(actionType, riskAssessment.riskLevel)) {
          logger.warn('Action blocked due to IP risk level', {
            ipAddress,
            actionType,
            riskScore: riskAssessment.riskScore,
            riskLevel: riskAssessment.riskLevel,
            endpoint: req.path,
            method: req.method,
            traceId: req.logger?.fields?.traceId
          });

          return res.status(this.config.responses.blocked.status).json({
            success: false,
            error: this.config.responses.blocked.message,
            code: this.config.responses.blocked.code,
            metadata: {
              actionType,
              riskLevel: riskAssessment.riskLevel,
              reason: 'Action not allowed for this IP risk level'
            }
          });
        }

        // Add IP intelligence to request
        req.ipIntelligence = riskAssessment;

        // Log high-risk requests
        if (riskAssessment.riskScore >= this.config.monitoring.alertThreshold) {
          logger.warn('High risk IP request allowed', {
            ipAddress,
            actionType,
            riskScore: riskAssessment.riskScore,
            riskLevel: riskAssessment.riskLevel,
            endpoint: req.path,
            traceId: req.logger?.fields?.traceId
          });
        }

        next();

      } catch (error) {
        logger.error('IP intelligence middleware error', {
          error: error.message,
          actionType,
          ipAddress: getRequestIp(req),
          traceId: req.logger?.fields?.traceId
        });

        // Fail safe - allow but monitor
        req.ipIntelligence = {
          error: error.message,
          riskScore: 50,
          riskLevel: 'medium'
        };
        next();
      }
    };
  }

  /**
   * Create middleware for creator-specific actions
   * @returns {Function} Express middleware
   */
  createCreatorMiddleware() {
    return this.createGeneralMiddleware('create_creator');
  }

  /**
   * Create middleware for high-value withdrawals
   * @returns {Function} Express middleware
   */
  createWithdrawalMiddleware() {
    return this.createGeneralMiddleware('high_value_withdrawal');
  }

  /**
   * Create middleware for content uploads
   * @returns {Function} Express middleware
   */
  createContentMiddleware() {
    return this.createGeneralMiddleware('upload_content');
  }

  /**
   * Check if IP should be blocked based on risk assessment
   * @param {object} riskAssessment 
   * @param {string} context 
   * @returns {boolean}
   */
  shouldBlockIP(riskAssessment, context) {
    const riskLevel = riskAssessment.riskLevel;
    
    switch (context) {
      case 'siws':
        // Block critical and high risk IPs in SIWS
        return ['critical', 'high'].includes(riskLevel);
      default:
        // Block critical risk IPs for other contexts
        return riskLevel === 'critical';
    }
  }

  /**
   * Check if additional verification is required
   * @param {object} riskAssessment 
   * @param {string} context 
   * @returns {boolean}
   */
  requiresAdditionalVerification(riskAssessment, context) {
    const riskLevel = riskAssessment.riskLevel;
    
    switch (context) {
      case 'siws':
        // Require verification for medium and high risk IPs
        return ['medium', 'high'].includes(riskLevel);
      default:
        // Require verification for high risk IPs
        return riskLevel === 'high';
    }
  }

  /**
   * Check if action is allowed for risk level
   * @param {string} actionType 
   * @param {string} riskLevel 
   * @returns {boolean}
   */
  isActionAllowed(actionType, riskLevel) {
    // Find the restriction category for this action
    for (const [category, config] of Object.entries(this.config.restrictions)) {
      if (config.actions.includes(actionType)) {
        return this.compareRiskLevels(riskLevel, config.maxRiskLevel) <= 0;
      }
    }

    // Default to allowing medium risk actions
    return this.compareRiskLevels(riskLevel, 'medium') <= 0;
  }

  /**
   * Compare risk levels (returns -1, 0, or 1)
   * @param {string} level1 
   * @param {string} level2 
   * @returns {number}
   */
  compareRiskLevels(level1, level2) {
    const levels = ['minimal', 'low', 'medium', 'high', 'critical'];
    const index1 = levels.indexOf(level1);
    const index2 = levels.indexOf(level2);
    
    return index1 - index2;
  }

  /**
   * Get allowed actions for risk level and context
   * @param {object} riskAssessment 
   * @param {string} context 
   * @returns {array} Allowed actions
   */
  getAllowedActions(riskAssessment, context) {
    const riskLevel = riskAssessment.riskLevel;
    const allowedActions = [];

    // Define action hierarchy by risk level
    const actionHierarchy = {
      minimal: ['view_content', 'basic_operations'],
      low: ['view_content', 'basic_operations', 'create_subscription'],
      medium: ['view_content', 'basic_operations', 'create_subscription', 'upload_content'],
      high: ['view_content', 'basic_operations'],
      critical: [] // No actions allowed for critical risk
    };

    if (context === 'siws') {
      // Special handling for SIWS
      if (this.compareRiskLevels(riskLevel, 'low') <= 0) {
        allowedActions.push('siws_auth');
      }
    } else {
      // General actions based on risk level
      const actions = actionHierarchy[riskLevel] || [];
      allowedActions.push(...actions);
    }

    return allowedActions;
  }

  /**
   * Update IP reputation tracking
   * @param {string} ipAddress 
   * @param {string} actionType 
   * @param {number} riskScore 
   */
  updateIPReputation(ipAddress, actionType, riskScore) {
    if (!this.config.monitoring.trackReputation) return;

    const now = Date.now();
    let reputation = this.ipReputation.get(ipAddress);

    if (!reputation) {
      reputation = {
        ipAddress,
        firstSeen: now,
        lastSeen: now,
        actionCount: 0,
        riskScores: [],
        averageRiskScore: riskScore,
        reputationScore: 100 - riskScore, // Start with good reputation
        actions: new Map()
      };
    }

    // Update reputation data
    reputation.lastSeen = now;
    reputation.actionCount++;
    reputation.riskScores.push(riskScore);
    
    // Keep only last 10 risk scores for average
    if (reputation.riskScores.length > 10) {
      reputation.riskScores.shift();
    }
    
    // Calculate new average risk score
    reputation.averageRiskScore = reputation.riskScores.reduce((a, b) => a + b, 0) / reputation.riskScores.length;
    
    // Update action-specific tracking
    if (!reputation.actions.has(actionType)) {
      reputation.actions.set(actionType, { count: 0, firstSeen: now });
    }
    const actionData = reputation.actions.get(actionType);
    actionData.count++;
    actionData.lastSeen = now;

    // Calculate reputation score (0-100, higher is better)
    const recentActions = reputation.riskScores.slice(-5); // Last 5 actions
    const recentAverage = recentActions.reduce((a, b) => a + b, 0) / recentActions.length;
    reputation.reputationScore = Math.max(0, Math.min(100, 100 - recentAverage));

    this.ipReputation.set(ipAddress, reputation);

    // Clean up old reputation data periodically
    if (this.ipReputation.size > 10000) {
      this.cleanupReputationData();
    }
  }

  /**
   * Load existing reputation data
   */
  loadReputationData() {
    // In production, this would load from database or file
    // For now, start with empty reputation
    logger.info('IP reputation tracking initialized', {
      maxEntries: 10000
    });
  }

  /**
   * Clean up old reputation data
   */
  cleanupReputationData() {
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    
    for (const [ip, reputation] of this.ipReputation.entries()) {
      if (reputation.lastSeen < thirtyDaysAgo) {
        this.ipReputation.delete(ip);
      }
    }

    logger.debug('IP reputation data cleaned up', {
      remainingEntries: this.ipReputation.size
    });
  }

  /**
   * Get IP reputation data
   * @param {string} ipAddress 
   * @returns {object|null} Reputation data
   */
  getIPReputation(ipAddress) {
    return this.ipReputation.get(ipAddress) || null;
  }

  /**
   * Get reputation statistics
   * @returns {object} Reputation stats
   */
  getReputationStats() {
    const stats = {
      totalIPs: this.ipReputation.size,
      averageReputationScore: 0,
      riskDistribution: {
        minimal: 0,
        low: 0,
        medium: 0,
        high: 0,
        critical: 0
      },
      topRiskIPs: [],
      actionStats: {}
    };

    if (this.ipReputation.size === 0) {
      return stats;
    }

    let totalReputationScore = 0;
    const ipScores = [];

    for (const reputation of this.ipReputation.values()) {
      totalReputationScore += reputation.reputationScore;
      ipScores.push({
        ip: reputation.ipAddress,
        score: reputation.reputationScore,
        riskScore: reputation.averageRiskScore
      });

      // Count risk distribution
      const riskLevel = this.getRiskLevelFromScore(reputation.averageRiskScore);
      stats.riskDistribution[riskLevel]++;

      // Count actions
      for (const [action, data] of reputation.actions.entries()) {
        if (!stats.actionStats[action]) {
          stats.actionStats[action] = 0;
        }
        stats.actionStats[action] += data.count;
      }
    }

    stats.averageReputationScore = totalReputationScore / this.ipReputation.size;

    // Get top risk IPs (lowest reputation scores)
    stats.topRiskIPs = ipScores
      .sort((a, b) => a.score - b.score)
      .slice(0, 10);

    return stats;
  }

  /**
   * Get risk level from score
   * @param {number} score 
   * @returns {string} Risk level
   */
  getRiskLevelFromScore(score) {
    if (score >= 90) return 'critical';
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    if (score >= 30) return 'low';
    return 'minimal';
  }

  /**
   * Create middleware for enhanced rate limiting based on IP risk
   * @param {object} baseRateLimiter 
   * @returns {Function} Enhanced rate limiting middleware
   */
  createEnhancedRateLimitMiddleware(baseRateLimiter) {
    return async (req, res, next) => {
      try {
        const ipAddress = getRequestIp(req);
        
        if (!ipAddress) {
          return baseRateLimiter(req, res, next);
        }

        // Get IP reputation
        const reputation = this.getIPReputation(ipAddress);
        
        if (!reputation) {
          return baseRateLimiter(req, res, next);
        }

        // Adjust rate limits based on reputation
        const riskMultiplier = this.getRiskMultiplier(reputation.averageRiskScore);
        const adjustedLimits = this.adjustRateLimits(baseRateLimiter, riskMultiplier);

        // Apply adjusted rate limiting
        // This would integrate with the existing rate limiter
        // For now, proceed with normal rate limiting
        baseRateLimiter(req, res, next);

      } catch (error) {
        logger.error('Enhanced rate limiting middleware error', {
          error: error.message,
          ipAddress: getRequestIp(req),
          traceId: req.logger?.fields?.traceId
        });
        baseRateLimiter(req, res, next);
      }
    };
  }

  /**
   * Get risk multiplier for rate limiting
   * @param {number} riskScore 
   * @returns {number} Multiplier
   */
  getRiskMultiplier(riskScore) {
    if (riskScore >= 80) return 0.25; // 75% reduction for high risk
    if (riskScore >= 60) return 0.5;  // 50% reduction for medium risk
    if (riskScore >= 30) return 0.75; // 25% reduction for low risk
    return 1; // No reduction for minimal risk
  }

  /**
   * Adjust rate limits based on risk multiplier
   * @param {object} rateLimiter 
   * @param {number} multiplier 
   * @returns {object} Adjusted rate limiter
   */
  adjustRateLimits(rateLimiter, multiplier) {
    // This would adjust the rate limiter configuration
    // Implementation depends on the specific rate limiter being used
    return {
      ...rateLimiter,
      bucketCapacity: Math.floor(rateLimiter.bucketCapacity * multiplier),
      leakRatePerSecond: rateLimiter.leakRatePerSecond * multiplier
    };
  }

  /**
   * Get middleware statistics
   * @returns {object} Middleware stats
   */
  getMiddlewareStats() {
    return {
      reputationStats: this.getReputationStats(),
      config: {
        siwsEnabled: this.config.siws.enabled,
        monitoringEnabled: this.config.monitoring.trackReputation,
        alertThreshold: this.config.monitoring.alertThreshold
      }
    };
  }
}

module.exports = { IPIntelligenceMiddleware };
