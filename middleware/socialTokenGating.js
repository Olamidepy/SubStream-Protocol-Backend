const { logger } = require('../utils/logger');
const crypto = require('crypto');

/**
 * Social Token Gating Middleware
 * Binary content gating based on Stellar Asset holdings
 * Provides real-time access control and periodic balance re-verification
 */
class SocialTokenGatingMiddleware {
  constructor(socialTokenService, database, redisClient) {
    this.socialTokenService = socialTokenService;
    this.database = database;
    this.redis = redisClient;
    
    // Session management
    this.activeSessions = new Map(); // In-memory session cache
    this.sessionCleanupInterval = 300000; // 5 minutes
    this.maxSessionAge = 3600000; // 1 hour
    
    // Start cleanup interval
    this.startSessionCleanup();
  }

  /**
   * Express middleware for social token gating
   * @param {object} options Middleware options
   * @returns {Function} Express middleware function
   */
  requireSocialToken(options = {}) {
    return async (req, res, next) => {
      try {
        const { contentId } = req.params;
        const userAddress = req.user?.address;

        if (!userAddress) {
          return res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'AUTH_REQUIRED'
          });
        }

        if (!contentId) {
          return res.status(400).json({
            success: false,
            error: 'Content ID is required',
            code: 'CONTENT_ID_REQUIRED'
          });
        }

        // Check if content requires social token gating
        const accessResult = await this.socialTokenService.checkContentAccess(userAddress, contentId);

        if (!accessResult.hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Access denied',
            code: 'INSUFFICIENT_TOKENS',
            details: {
              requiresToken: accessResult.requiresToken,
              assetCode: accessResult.assetCode,
              assetIssuer: accessResult.assetIssuer,
              minimumBalance: accessResult.minimumBalance,
              reason: accessResult.reason
            }
          });
        }

        // If token gating is required, start re-verification session
        if (accessResult.requiresToken) {
          const sessionId = this.generateSessionId();
          
          await this.socialTokenService.startBalanceReverification(
            sessionId,
            userAddress,
            contentId
          );

          // Add session info to request
          req.socialTokenSession = {
            sessionId,
            requiresReverification: true,
            verificationInterval: accessResult.verificationInterval,
            assetInfo: {
              code: accessResult.assetCode,
              issuer: accessResult.assetIssuer,
              minimumBalance: accessResult.minimumBalance
            }
          };

          logger.info('Social token session started', {
            sessionId,
            userAddress,
            contentId,
            assetCode: accessResult.assetCode
          });
        }

        // Add access info to request
        req.socialTokenAccess = accessResult;

        next();
      } catch (error) {
        logger.error('Social token gating middleware error', {
          error: error.message,
          contentId: req.params.contentId,
          userAddress: req.user?.address
        });

        res.status(500).json({
          success: false,
          error: 'Access verification failed',
          code: 'VERIFICATION_ERROR'
        });
      }
    };
  }

  /**
   * Middleware for periodic balance re-verification during streaming
   * @param {object} options Verification options
   * @returns {Function} Express middleware function
   */
  verifyTokenBalance(options = {}) {
    return async (req, res, next) => {
      try {
        const sessionId = req.socialTokenSession?.sessionId;
        
        if (!sessionId) {
          // No session, skip verification
          return next();
        }

        // Re-verify token balance
        const stillValid = await this.socialTokenService.reverifyBalance(sessionId);

        if (!stillValid) {
          // End the session
          await this.socialTokenService.endReverificationSession(sessionId);

          return res.status(403).json({
            success: false,
            error: 'Token balance insufficient - access revoked',
            code: 'TOKEN_BALANCE_REVOKED',
            sessionId
          });
        }

        // Update session last verified time
        req.socialTokenSession.lastVerified = new Date().toISOString();

        next();
      } catch (error) {
        logger.error('Token balance verification error', {
          error: error.message,
          sessionId: req.socialTokenSession?.sessionId
        });

        res.status(500).json({
          success: false,
          error: 'Balance verification failed',
          code: 'BALANCE_VERIFICATION_ERROR'
        });
      }
    };
  }

  /**
   * WebSocket handler for real-time balance monitoring
   * @param {object} socket WebSocket connection
   * @param {object} data Connection data
   */
  handleWebSocketConnection(socket, data) {
    const { sessionId, userAddress, contentId } = data;

    if (!sessionId || !userAddress || !contentId) {
      socket.emit('error', { message: 'Invalid connection data' });
      return;
    }

    // Store socket reference
    this.activeSessions.set(sessionId, {
      socket,
      userAddress,
      contentId,
      connectedAt: new Date(),
      lastVerification: new Date()
    });

    // Start periodic verification
    const verificationInterval = setInterval(async () => {
      try {
        const stillValid = await this.socialTokenService.reverifyBalance(sessionId);

        if (!stillValid) {
          // Notify client and close connection
          socket.emit('access_revoked', {
            reason: 'Token balance insufficient',
            sessionId
          });

          clearInterval(verificationInterval);
          this.activeSessions.delete(sessionId);
          socket.disconnect();
        } else {
          // Send verification confirmation
          socket.emit('access_verified', {
            sessionId,
            verifiedAt: new Date().toISOString()
          });

          // Update session
          const session = this.activeSessions.get(sessionId);
          if (session) {
            session.lastVerification = new Date();
          }
        }
      } catch (error) {
        logger.error('WebSocket verification error', {
          error: error.message,
          sessionId
        });

        socket.emit('verification_error', {
          message: 'Balance verification failed',
          sessionId
        });
      }
    }, 60000); // Verify every minute

    // Handle disconnection
    socket.on('disconnect', () => {
      clearInterval(verificationInterval);
      this.activeSessions.delete(sessionId);
      
      logger.debug('Social token WebSocket disconnected', { sessionId });
    });

    logger.info('Social token WebSocket connected', {
      sessionId,
      userAddress,
      contentId
    });
  }

  /**
   * Generate unique session ID
   * @returns {string} Session ID
   */
  generateSessionId() {
    return `st_${crypto.randomUUID()}`;
  }

  /**
   * Start session cleanup interval
   */
  startSessionCleanup() {
    setInterval(async () => {
      try {
        await this.cleanupExpiredSessions();
      } catch (error) {
        logger.error('Session cleanup error', { error: error.message });
      }
    }, this.sessionCleanupInterval);
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions() {
    try {
      const now = new Date();
      const expiredSessions = [];

      // Clean up in-memory sessions
      for (const [sessionId, session] of this.activeSessions.entries()) {
        const age = now - session.connectedAt;
        
        if (age > this.maxSessionAge) {
          expiredSessions.push(sessionId);
          
          // Close WebSocket if still connected
          if (session.socket && session.socket.readyState === 1) {
            session.socket.emit('session_expired', { sessionId });
            session.socket.disconnect();
          }
          
          this.activeSessions.delete(sessionId);
        }
      }

      // Clean up database sessions
      const dbCleanupCount = await this.socialTokenService.cleanupExpiredSessions(this.maxSessionAge);

      if (expiredSessions.length > 0 || dbCleanupCount > 0) {
        logger.info('Session cleanup completed', {
          memorySessions: expiredSessions.length,
          dbSessions: dbCleanupCount
        });
      }
    } catch (error) {
      logger.error('Session cleanup failed', { error: error.message });
    }
  }

  /**
   * Get active session count
   * @returns {number} Number of active sessions
   */
  getActiveSessionCount() {
    return this.activeSessions.size;
  }

  /**
   * Get session information
   * @param {string} sessionId Session ID
   * @returns {object|null} Session information
   */
  getSessionInfo(sessionId) {
    const session = this.activeSessions.get(sessionId);
    
    if (!session) {
      return null;
    }

    return {
      sessionId,
      userAddress: session.userAddress,
      contentId: session.contentId,
      connectedAt: session.connectedAt,
      lastVerification: session.lastVerification,
      duration: Date.now() - session.connectedAt.getTime()
    };
  }

  /**
   * Force session termination
   * @param {string} sessionId Session ID
   * @param {string} reason Termination reason
   * @returns {Promise<boolean>} Whether session was terminated
   */
  async terminateSession(sessionId, reason = 'Manual termination') {
    try {
      const session = this.activeSessions.get(sessionId);
      
      if (session) {
        // Notify via WebSocket
        if (session.socket && session.socket.readyState === 1) {
          session.socket.emit('session_terminated', {
            sessionId,
            reason,
            terminatedAt: new Date().toISOString()
          });
          session.socket.disconnect();
        }
        
        this.activeSessions.delete(sessionId);
      }

      // End database session
      const dbEnded = await this.socialTokenService.endReverificationSession(sessionId);

      logger.info('Session terminated', {
        sessionId,
        reason,
        hadWebSocket: !!session,
        dbSessionEnded: dbEnded
      });

      return true;
    } catch (error) {
      logger.error('Failed to terminate session', {
        error: error.message,
        sessionId,
        reason
      });
      return false;
    }
  }

  /**
   * Get statistics for social token gating
   * @returns {Promise<object>} Statistics
   */
  async getStatistics() {
    try {
      // Get database statistics
      const activeSessionsQuery = `
        SELECT COUNT(*) as count 
        FROM social_token_sessions 
        WHERE still_valid = 1
      `;
      const dbSessions = this.database.db.prepare(activeSessionsQuery).get();

      const totalAccessAttemptsQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN has_access = 1 THEN 1 END) as successful,
          COUNT(DISTINCT user_address) as unique_users,
          COUNT(DISTINCT content_id) as gated_content
        FROM social_token_access_logs 
        WHERE created_at >= datetime('now', '-24 hours')
      `;
      const accessStats = this.database.db.prepare(totalAccessAttemptsQuery).get();

      // Get top assets by usage
      const topAssetsQuery = `
        SELECT 
          asset_code,
          asset_issuer,
          COUNT(*) as usage_count,
          AVG(CASE WHEN has_access = 1 THEN 1 ELSE 0 END) as success_rate
        FROM social_token_access_logs 
        WHERE created_at >= datetime('now', '-24 hours')
          AND asset_code IS NOT NULL
        GROUP BY asset_code, asset_issuer
        ORDER BY usage_count DESC
        LIMIT 5
      `;
      const topAssets = this.database.db.prepare(topAssetsQuery).all();

      return {
        activeSessions: {
          webSocket: this.activeSessions.size,
          database: dbSessions.count || 0,
          total: this.activeSessions.size + (dbSessions.count || 0)
        },
        accessAttempts: {
          last24Hours: {
            total: accessStats.total || 0,
            successful: accessStats.successful || 0,
            successRate: accessStats.total > 0 
              ? (accessStats.successful / accessStats.total) * 100 
              : 0,
            uniqueUsers: accessStats.unique_users || 0,
            gatedContent: accessStats.gated_content || 0
          }
        },
        topAssets: topAssets.map(asset => ({
          ...asset,
          successRate: (asset.success_rate || 0) * 100
        })),
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to get social token statistics', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Validate asset configuration
   * @param {string} assetCode Asset code
   * @param {string} assetIssuer Asset issuer
   * @returns {Promise<object>} Validation result
   */
  async validateAsset(assetCode, assetIssuer) {
    try {
      // Check if asset exists on Stellar
      const assetExists = await this.socialTokenService.verifyAssetExists(assetCode, assetIssuer);
      
      if (!assetExists) {
        return {
          valid: false,
          error: 'Asset does not exist on Stellar network',
          code: 'ASSET_NOT_FOUND'
        };
      }

      // Validate asset code format
      if (assetCode.length > 12) {
        return {
          valid: false,
          error: 'Asset code too long (max 12 characters)',
          code: 'INVALID_ASSET_CODE'
        };
      }

      // Validate issuer address format
      if (!assetIssuer.match(/^G[A-Z0-9]{55}$/)) {
        return {
          valid: false,
          error: 'Invalid Stellar address format',
          code: 'INVALID_ISSUER'
        };
      }

      return {
        valid: true,
        asset: {
          code: assetCode,
          issuer: assetIssuer
        }
      };
    } catch (error) {
      logger.error('Asset validation error', {
        error: error.message,
        assetCode,
        assetIssuer
      });

      return {
        valid: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR'
      };
    }
  }

  /**
   * Create access token for gated content
   * @param {object} tokenData Token data
   * @returns {Promise<object>} Access token
   */
  async createAccessToken(tokenData) {
    try {
      const {
        userAddress,
        contentId,
        sessionId,
        expiresIn = 3600 // 1 hour default
      } = tokenData;

      // Verify user still has access
      const accessResult = await this.socialTokenService.checkContentAccess(userAddress, contentId);
      
      if (!accessResult.hasAccess) {
        throw new Error('User does not have access to this content');
      }

      // Create JWT token
      const jwt = require('jsonwebtoken');
      const tokenPayload = {
        userAddress,
        contentId,
        sessionId,
        type: 'social_token_access',
        requiresToken: accessResult.requiresToken,
        assetInfo: accessResult.requiresToken ? {
          code: accessResult.assetCode,
          issuer: accessResult.assetIssuer,
          minimumBalance: accessResult.minimumBalance
        } : null,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresIn
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET);

      logger.info('Social token access token created', {
        userAddress,
        contentId,
        sessionId,
        expiresIn
      });

      return {
        token,
        type: 'Bearer',
        expiresIn,
        tokenType: 'social_token_access',
        accessInfo: accessResult
      };
    } catch (error) {
      logger.error('Failed to create access token', {
        error: error.message,
        tokenData
      });
      throw error;
    }
  }

  /**
   * Verify access token
   * @param {string} token JWT token
   * @returns {Promise<object>} Token verification result
   */
  async verifyAccessToken(token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type !== 'social_token_access') {
        throw new Error('Invalid token type');
      }

      // Re-verify access if token requires social token
      if (decoded.requiresToken && decoded.assetInfo) {
        const stillValid = await this.socialTokenService.verifyTokenHolding(
          decoded.userAddress,
          decoded.assetInfo.code,
          decoded.assetInfo.issuer,
          decoded.assetInfo.minimumBalance
        );

        if (!stillValid) {
          throw new Error('Token balance requirements no longer met');
        }
      }

      return {
        valid: true,
        decoded,
        verifiedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Access token verification failed', {
        error: error.message
      });

      return {
        valid: false,
        error: error.message
      };
    }
  }
}

module.exports = SocialTokenGatingMiddleware;
