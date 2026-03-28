const { Server, Api } = require('@stellar/stellar-sdk');
const { logger } = require('../utils/logger');

/**
 * Social Token Gating Service
 * Verifies Stellar Asset holdings for content access control
 * Provides binary gating based on minimum token requirements
 */
class SocialTokenGatingService {
  constructor(config, database, redisClient) {
    this.config = config;
    this.database = database;
    this.redis = redisClient;
    
    // Stellar server connection
    this.server = new Server({
      hostname: config.stellar?.horizonUrl || 'https://horizon-testnet.stellar.org',
      protocol: 'https',
      port: 443,
      userAgent: 'SubStream-SocialTokenGating/1.0'
    });

    // Caching configuration
    this.cacheTTL = config.socialToken?.cacheTTL || 300; // 5 minutes
    this.reverificationInterval = config.socialToken?.reverificationInterval || 60000; // 1 minute
    this.prefix = config.socialToken?.cachePrefix || 'social_token:';

    // Retry configuration
    this.maxRetries = config.stellar?.maxRetries || 3;
    this.retryDelay = config.stellar?.retryDelay || 1000;
  }

  /**
   * Verify if a user holds sufficient tokens for content access
   * @param {string} userAddress User's Stellar wallet address
   * @param {string} assetCode Asset code to check
   * @param {string} assetIssuer Asset issuer address
   * @param {number} minimumBalance Minimum required balance
   * @returns {Promise<boolean>} Whether user has sufficient tokens
   */
  async verifyTokenHolding(userAddress, assetCode, assetIssuer, minimumBalance) {
    try {
      const cacheKey = this.getBalanceCacheKey(userAddress, assetCode, assetIssuer);
      
      // Try to get from cache first
      const cached = await this.getCachedBalance(cacheKey);
      if (cached !== null) {
        logger.debug('Token balance found in cache', {
          userAddress,
          assetCode,
          assetIssuer,
          cachedBalance: cached,
          minimumBalance
        });
        return cached >= minimumBalance;
      }

      // Fetch from Stellar network
      const balance = await this.fetchTokenBalance(userAddress, assetCode, assetIssuer);
      
      // Cache the result
      await this.cacheBalance(cacheKey, balance);

      logger.info('Token balance verified', {
        userAddress,
        assetCode,
        assetIssuer,
        balance,
        minimumBalance,
        hasSufficient: balance >= minimumBalance
      });

      return balance >= minimumBalance;
    } catch (error) {
      logger.error('Failed to verify token holding', {
        error: error.message,
        userAddress,
        assetCode,
        assetIssuer,
        minimumBalance
      });
      
      // Fail safe: deny access if verification fails
      return false;
    }
  }

  /**
   * Fetch token balance from Stellar network
   * @param {string} userAddress User's Stellar wallet address
   * @param {string} assetCode Asset code
   * @param {string} assetIssuer Asset issuer address
   * @returns {Promise<number>} Token balance
   */
  async fetchTokenBalance(userAddress, assetCode, assetIssuer) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.debug(`Fetching token balance (attempt ${attempt})`, {
          userAddress,
          assetCode,
          assetIssuer
        });

        const account = await this.server.accounts().accountId(userAddress).call();
        
        // Find the specific asset balance
        const assetString = `${assetCode}:${assetIssuer}`;
        const balance = account.balances.find(b => 
          b.asset_type === 'credit_alphanum4' || 
          b.asset_type === 'credit_alphanum12'
        ) && account.balances.find(b => b.asset_code === assetCode && b.asset_issuer === assetIssuer);

        if (!balance) {
          logger.debug('Asset not found in account balances', {
            userAddress,
            assetCode,
            assetIssuer,
            availableAssets: account.balances.map(b => ({
              type: b.asset_type,
              code: b.asset_code,
              issuer: b.asset_issuer
            }))
          });
          return 0;
        }

        const numericBalance = parseFloat(balance.balance);
        
        logger.debug('Token balance fetched successfully', {
          userAddress,
          assetCode,
          assetIssuer,
          balance: numericBalance
        });

        return numericBalance;
      } catch (error) {
        lastError = error;
        logger.warn(`Token balance fetch attempt ${attempt} failed`, {
          error: error.message,
          userAddress,
          assetCode,
          assetIssuer
        });

        // Don't retry on certain errors
        if (error.response?.status === 404) {
          // Account not found
          return 0;
        }

        if (attempt < this.maxRetries) {
          // Exponential backoff
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if content requires social token gating
   * @param {string} contentId Content ID
   * @returns {Promise<object|null>} Gating requirements or null
   */
  async getContentGatingRequirements(contentId) {
    try {
      const query = `
        SELECT 
          asset_code,
          asset_issuer,
          minimum_balance,
          verification_interval,
          created_at
        FROM social_token_gated_content 
        WHERE content_id = ? AND active = 1
      `;

      const result = this.database.db.prepare(query).get(contentId);
      
      if (!result) {
        return null;
      }

      return {
        assetCode: result.asset_code,
        assetIssuer: result.asset_issuer,
        minimumBalance: parseFloat(result.minimum_balance),
        verificationInterval: result.verification_interval || this.reverificationInterval,
        createdAt: result.created_at
      };
    } catch (error) {
      logger.error('Failed to get content gating requirements', {
        error: error.message,
        contentId
      });
      return null;
    }
  }

  /**
   * Create or update social token gating for content
   * @param {object} gatingData Gating configuration
   * @returns {Promise<object>} Created/updated gating record
   */
  async setContentGating(gatingData) {
    try {
      const {
        contentId,
        creatorAddress,
        assetCode,
        assetIssuer,
        minimumBalance,
        verificationInterval = this.reverificationInterval,
        active = true
      } = gatingData;

      // Validate asset exists on Stellar network
      const assetExists = await this.verifyAssetExists(assetCode, assetIssuer);
      if (!assetExists) {
        throw new Error(`Asset ${assetCode}:${assetIssuer} does not exist on Stellar network`);
      }

      // Upsert gating record
      const upsertQuery = `
        INSERT OR REPLACE INTO social_token_gated_content (
          content_id, creator_address, asset_code, asset_issuer,
          minimum_balance, verification_interval, active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.database.db.prepare(upsertQuery).run(
        contentId,
        creatorAddress,
        assetCode,
        assetIssuer,
        minimumBalance.toString(),
        verificationInterval,
        active ? 1 : 0,
        new Date().toISOString()
      );

      logger.info('Social token gating set for content', {
        contentId,
        creatorAddress,
        assetCode,
        assetIssuer,
        minimumBalance
      });

      return await this.getContentGatingRequirements(contentId);
    } catch (error) {
      logger.error('Failed to set content gating', {
        error: error.message,
        gatingData
      });
      throw error;
    }
  }

  /**
   * Verify if asset exists on Stellar network
   * @param {string} assetCode Asset code
   * @param {string} assetIssuer Asset issuer address
   * @returns {Promise<boolean>} Whether asset exists
   */
  async verifyAssetExists(assetCode, assetIssuer) {
    try {
      // Try to get asset details
      const assets = await this.server.assets()
        .forCode(assetCode)
        .forIssuer(assetIssuer)
        .call();

      return assets.records.length > 0;
    } catch (error) {
      logger.debug('Asset verification failed', {
        error: error.message,
        assetCode,
        assetIssuer
      });
      return false;
    }
  }

  /**
   * Check user access to gated content
   * @param {string} userAddress User's wallet address
   * @param {string} contentId Content ID
   * @returns {Promise<object>} Access result with details
   */
  async checkContentAccess(userAddress, contentId) {
    try {
      const gating = await this.getContentGatingRequirements(contentId);
      
      if (!gating) {
        // No gating requirements, content is publicly accessible
        return {
          hasAccess: true,
          requiresToken: false,
          reason: 'No token requirements'
        };
      }

      // Verify token holding
      const hasTokens = await this.verifyTokenHolding(
        userAddress,
        gating.assetCode,
        gating.assetIssuer,
        gating.minimumBalance
      );

      const result = {
        hasAccess: hasTokens,
        requiresToken: true,
        assetCode: gating.assetCode,
        assetIssuer: gating.assetIssuer,
        minimumBalance: gating.minimumBalance,
        verificationInterval: gating.verificationInterval,
        reason: hasTokens ? 'Sufficient tokens' : 'Insufficient tokens'
      };

      // Log access attempt
      await this.logAccessAttempt(userAddress, contentId, result);

      return result;
    } catch (error) {
      logger.error('Failed to check content access', {
        error: error.message,
        userAddress,
        contentId
      });

      return {
        hasAccess: false,
        requiresToken: true,
        reason: 'Verification failed'
      };
    }
  }

  /**
   * Start periodic balance re-verification for active sessions
   * @param {string} sessionId Session ID
   * @param {string} userAddress User's wallet address
   * @param {string} contentId Content ID
   * @returns {Promise<object>} Session management data
   */
  async startBalanceReverification(sessionId, userAddress, contentId) {
    try {
      const gating = await this.getContentGatingRequirements(contentId);
      
      if (!gating) {
        return { requiresReverification: false };
      }

      // Create session record
      const sessionData = {
        sessionId,
        userAddress,
        contentId,
        assetCode: gating.assetCode,
        assetIssuer: gating.assetIssuer,
        minimumBalance: gating.minimumBalance,
        verificationInterval: gating.verificationInterval,
        lastVerified: new Date().toISOString(),
        stillValid: true,
        createdAt: new Date().toISOString()
      };

      const insertQuery = `
        INSERT INTO social_token_sessions (
          session_id, user_address, content_id, asset_code, asset_issuer,
          minimum_balance, verification_interval, last_verified, still_valid, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.database.db.prepare(insertQuery).run(
        sessionId,
        userAddress,
        contentId,
        gating.assetCode,
        gating.assetIssuer,
        gating.minimumBalance.toString(),
        gating.verificationInterval,
        sessionData.lastVerified,
        1,
        sessionData.createdAt
      );

      logger.info('Balance reverification session started', {
        sessionId,
        userAddress,
        contentId,
        verificationInterval: gating.verificationInterval
      });

      return {
        requiresReverification: true,
        ...sessionData
      };
    } catch (error) {
      logger.error('Failed to start balance reverification', {
        error: error.message,
        sessionId,
        userAddress,
        contentId
      });
      throw error;
    }
  }

  /**
   * Re-verify token balance for active session
   * @param {string} sessionId Session ID
   * @returns {Promise<boolean>} Whether balance is still sufficient
   */
  async reverifyBalance(sessionId) {
    try {
      const query = `
        SELECT user_address, content_id, asset_code, asset_issuer, minimum_balance
        FROM social_token_sessions 
        WHERE session_id = ? AND still_valid = 1
      `;

      const session = this.database.db.prepare(query).get(sessionId);
      
      if (!session) {
        logger.debug('Session not found or already invalidated', { sessionId });
        return false;
      }

      // Re-verify token holding
      const stillValid = await this.verifyTokenHolding(
        session.user_address,
        session.asset_code,
        session.asset_issuer,
        parseFloat(session.minimum_balance)
      );

      // Update session status
      this.database.db.prepare(`
        UPDATE social_token_sessions 
        SET still_valid = ?, last_verified = ?
        WHERE session_id = ?
      `).run(
        stillValid ? 1 : 0,
        new Date().toISOString(),
        sessionId
      );

      if (!stillValid) {
        logger.info('Balance reverification failed - session invalidated', {
          sessionId,
          userAddress: session.user_address,
          contentId: session.content_id
        });
      }

      return stillValid;
    } catch (error) {
      logger.error('Failed to reverify balance', {
        error: error.message,
        sessionId
      });
      return false;
    }
  }

  /**
   * End balance re-verification session
   * @param {string} sessionId Session ID
   * @returns {Promise<boolean>} Whether session was ended
   */
  async endReverificationSession(sessionId) {
    try {
      const result = this.database.db.prepare(`
        DELETE FROM social_token_sessions WHERE session_id = ?
      `).run(sessionId);

      const ended = result.changes > 0;
      
      if (ended) {
        logger.info('Balance reverification session ended', { sessionId });
      }

      return ended;
    } catch (error) {
      logger.error('Failed to end reverification session', {
        error: error.message,
        sessionId
      });
      return false;
    }
  }

  /**
   * Get cached balance
   * @param {string} cacheKey Cache key
   * @returns {Promise<number|null>} Cached balance or null
   */
  async getCachedBalance(cacheKey) {
    try {
      const cached = await this.redis.get(cacheKey);
      return cached !== null ? parseFloat(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached balance', {
        error: error.message,
        cacheKey
      });
      return null;
    }
  }

  /**
   * Cache balance result
   * @param {string} cacheKey Cache key
   * @param {number} balance Balance to cache
   */
  async cacheBalance(cacheKey, balance) {
    try {
      await this.redis.setex(cacheKey, this.cacheTTL, balance.toString());
    } catch (error) {
      logger.error('Failed to cache balance', {
        error: error.message,
        cacheKey,
        balance
      });
    }
  }

  /**
   * Get balance cache key
   * @param {string} userAddress User address
   * @param {string} assetCode Asset code
   * @param {string} assetIssuer Asset issuer
   * @returns {string} Cache key
   */
  getBalanceCacheKey(userAddress, assetCode, assetIssuer) {
    return `${this.prefix}balance:${userAddress}:${assetCode}:${assetIssuer}`;
  }

  /**
   * Log access attempt for analytics
   * @param {string} userAddress User address
   * @param {string} contentId Content ID
   * @param {object} result Access result
   */
  async logAccessAttempt(userAddress, contentId, result) {
    try {
      const query = `
        INSERT INTO social_token_access_logs (
          user_address, content_id, has_access, requires_token,
          asset_code, asset_issuer, minimum_balance, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.database.db.prepare(query).run(
        userAddress,
        contentId,
        result.hasAccess ? 1 : 0,
        result.requiresToken ? 1 : 0,
        result.assetCode || null,
        result.assetIssuer || null,
        result.minimumBalance || null,
        new Date().toISOString()
      );
    } catch (error) {
      logger.error('Failed to log access attempt', {
        error: error.message,
        userAddress,
        contentId
      });
    }
  }

  /**
   * Get social token statistics for a creator
   * @param {string} creatorAddress Creator's wallet address
   * @returns {Promise<object>} Statistics
   */
  async getCreatorTokenStats(creatorAddress) {
    try {
      // Get gated content count
      const gatedContentQuery = `
        SELECT COUNT(*) as count FROM social_token_gated_content 
        WHERE creator_address = ? AND active = 1
      `;
      const gatedContent = this.database.db.prepare(gatedContentQuery).get(creatorAddress);

      // Get access attempts in last 30 days
      const accessQuery = `
        SELECT 
          COUNT(*) as total_attempts,
          COUNT(CASE WHEN has_access = 1 THEN 1 END) as successful_attempts,
          COUNT(DISTINCT user_address) as unique_users
        FROM social_token_access_logs atl
        JOIN social_token_gated_content stgc ON atl.content_id = stgc.content_id
        WHERE stgc.creator_address = ? 
        AND atl.created_at >= datetime('now', '-30 days')
      `;
      const accessStats = this.database.db.prepare(accessQuery).get(creatorAddress);

      // Get most used tokens
      const tokenQuery = `
        SELECT 
          asset_code,
          asset_issuer,
          COUNT(*) as usage_count,
          AVG(CASE WHEN has_access = 1 THEN 1 ELSE 0 END) as success_rate
        FROM social_token_access_logs atl
        JOIN social_token_gated_content stgc ON atl.content_id = stgc.content_id
        WHERE stgc.creator_address = ? 
        AND atl.created_at >= datetime('now', '-30 days')
        GROUP BY asset_code, asset_issuer
        ORDER BY usage_count DESC
        LIMIT 5
      `;
      const tokenUsage = this.database.db.prepare(tokenQuery).all(creatorAddress);

      return {
        creatorAddress,
        gatedContentCount: gatedContent.count || 0,
        totalAttempts: accessStats.total_attempts || 0,
        successfulAttempts: accessStats.successful_attempts || 0,
        uniqueUsers: accessStats.unique_users || 0,
        successRate: accessStats.total_attempts > 0 
          ? (accessStats.successful_attempts / accessStats.total_attempts) * 100 
          : 0,
        topTokens: tokenUsage
      };
    } catch (error) {
      logger.error('Failed to get creator token stats', {
        error: error.message,
        creatorAddress
      });
      return null;
    }
  }

  /**
   * Clean up expired sessions
   * @param {number} maxAge Maximum age in milliseconds
   * @returns {Promise<number>} Number of sessions cleaned up
   */
  async cleanupExpiredSessions(maxAge = 3600000) { // 1 hour default
    try {
      const cutoffTime = new Date(Date.now() - maxAge).toISOString();
      
      const result = this.database.db.prepare(`
        DELETE FROM social_token_sessions 
        WHERE created_at < ? OR (still_valid = 0 AND last_verified < ?)
      `).run(cutoffTime, cutoffTime);

      logger.info('Expired sessions cleaned up', {
        deletedCount: result.changes,
        cutoffTime
      });

      return result.changes;
    } catch (error) {
      logger.error('Failed to cleanup expired sessions', {
        error: error.message,
        maxAge
      });
      return 0;
    }
  }

  /**
   * Sleep utility for delays
   * @param {number} ms Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SocialTokenGatingService;
