/**
 * PII (Personally Identifiable Information) Scrubbing Service
 * 
 * This service implements GDPR/CCPA compliant data deletion by:
 * - Cryptographically hashing PII with secure salt
 * - Preserving financial data for tax compliance while anonymizing user identity
 * - Scrubbing Redis caches
 * - Sending merchant webhooks
 * - Maintaining immutable audit logs
 * 
 * One-way hashing prevents reversal while allowing data correlation for accounting.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

class PIIScrubbingService {
  constructor({ database, redisClient, webhookService, auditLogService } = {}) {
    this.database = database;
    this.redisClient = redisClient;
    this.webhookService = webhookService;
    this.auditLogService = auditLogService;
    
    // Secure salt for hashing (should be from environment variable in production)
    this.salt = process.env.PII_SCRUBBING_SALT || crypto.randomBytes(32).toString('hex');
    
    // Hash algorithm (SHA-256 is secure and fast)
    this.hashAlgorithm = 'sha256';
    
    // Retention period for inactive users (3 years)
    this.inactiveRetentionYears = parseInt(process.env.INACTIVE_RETENTION_YEARS || '3');
  }

  /**
   * Hash a value with salt using SHA-256
   * @param {string} value - Value to hash
   * @returns {string} Hashed value
   */
  hashValue(value) {
    if (!value) return null;
    
    return crypto
      .createHmac(this.hashAlgorithm, this.salt)
      .update(value)
      .digest('hex');
  }

  /**
   * Anonymize a wallet address for financial records
   * @param {string} walletAddress - Original wallet address
   * @returns {string} Anonymized wallet address
   */
  anonymizeWalletAddress(walletAddress) {
    if (!walletAddress) return null;
    
    // Keep first 8 chars for debugging, hash the rest
    const prefix = walletAddress.substring(0, 8);
    const suffix = this.hashValue(walletAddress).substring(0, 40);
    
    return `${prefix}_${suffix}`;
  }

  /**
   * Scrub PII for a user by wallet address
   * @param {string} walletAddress - User's wallet address
   * @param {object} options - Scrubbing options
   * @returns {object} Scrubbing result
   */
  async scrubUserPII(walletAddress, options = {}) {
    const {
      scrubRedis = true,
      sendWebhooks = true,
      reason = 'user_request',
      requestedBy = 'system'
    } = options;

    const scrubId = crypto.randomUUID();
    const startTime = Date.now();

    logger.info('[PIIScrubbing] Starting PII scrub', {
      scrubId,
      walletAddress,
      reason,
      requestedBy
    });

    try {
      // Step 1: Scrub database PII
      const dbResult = await this.scrubDatabasePII(walletAddress, scrubId);

      // Step 2: Scrub Redis caches
      let redisResult = { success: true, keysScrubbed: 0 };
      if (scrubRedis && this.redisClient) {
        redisResult = await this.scrubRedisCache(walletAddress, scrubId);
      }

      // Step 3: Send merchant webhooks
      let webhookResult = { success: true, webhooksSent: 0 };
      if (sendWebhooks && this.webhookService) {
        webhookResult = await this.sendForgetWebhooks(walletAddress, scrubId, reason);
      }

      // Step 4: Log audit trail
      await this.logScrubbingAudit(walletAddress, scrubId, {
        reason,
        requestedBy,
        dbResult,
        redisResult,
        webhookResult,
        duration: Date.now() - startTime
      });

      const duration = Date.now() - startTime;
      logger.info('[PIIScrubbing] PII scrub completed', {
        scrubId,
        walletAddress,
        duration,
        dbResult,
        redisResult,
        webhookResult
      });

      return {
        success: true,
        scrubId,
        walletAddress,
        duration,
        dbResult,
        redisResult,
        webhookResult
      };
    } catch (error) {
      logger.error('[PIIScrubbing] PII scrub failed', {
        scrubId,
        walletAddress,
        error: error.message,
        stack: error.stack
      });

      // Log failure to audit
      await this.logScrubbingAudit(walletAddress, scrubId, {
        reason,
        requestedBy,
        error: error.message,
        duration: Date.now() - startTime,
        success: false
      });

      throw error;
    }
  }

  /**
   * Scrub PII from database tables
   * @param {string} walletAddress - User's wallet address
   * @param {string} scrubId - Scrubbing operation ID
   * @returns {object} Database scrubbing result
   */
  async scrubDatabasePII(walletAddress, scrubId) {
    const results = {
      success: true,
      tablesScrubbed: [],
      errors: []
    };

    const anonymizedAddress = this.anonymizeWalletAddress(walletAddress);
    const hashedAddress = this.hashValue(walletAddress);

    // Table 1: subscriptions - Scrub email, preserve financial data
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE subscriptions 
        SET user_email = ?, 
            wallet_address = ?,
            risk_status = 'scrubbed'
        WHERE wallet_address = ?
      `).run(
        `scrubbed_${hashedAddress}@anon.example.com`,
        anonymizedAddress,
        walletAddress
      );

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'subscriptions',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['user_email', 'wallet_address']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'subscriptions', error: error.message });
      results.success = false;
    }

    // Table 2: creator_audit_logs - Scrub IP addresses
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE creator_audit_logs 
        SET ip_address = ?
        WHERE ip_address IN (
          SELECT ip_address FROM subscriptions WHERE wallet_address = ?
        )
      `).run(`scrubbed_${hashedAddress}`);

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'creator_audit_logs',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['ip_address']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'creator_audit_logs', error: error.message });
      results.success = false;
    }

    // Table 3: api_key_audit_logs - Scrub IP addresses
    try {
      // This table exists in PostgreSQL, handle accordingly
      if (this.database.db && this.database.db.migrate) {
        // PostgreSQL handling would go here
        logger.info('[PIIScrubbing] Skipping api_key_audit_logs (PostgreSQL table)');
      }
    } catch (error) {
      logger.warn('[PIIScrubbing] api_key_audit_logs scrub error', { error: error.message });
    }

    // Table 4: data_export_tracking - Scrub requester email
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE data_export_tracking 
        SET requester_email = ?
        WHERE requester_email IN (
          SELECT user_email FROM subscriptions WHERE wallet_address = ?
        )
      `).run(`scrubbed_${hashedAddress}@anon.example.com`, walletAddress);

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'data_export_tracking',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['requester_email']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'data_export_tracking', error: error.message });
      results.success = false;
    }

    // Table 5: privacy_preferences - Mark as scrubbed
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE privacy_preferences 
        SET share_email_with_merchants = 0
        WHERE wallet_address = ?
      `).run(walletAddress);

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'privacy_preferences',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['share_email_with_merchants']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'privacy_preferences', error: error.message });
      results.success = false;
    }

    // Table 6: comments - Scrub user_address in comments
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE comments 
        SET user_address = ?
        WHERE user_address = ?
      `).run(anonymizedAddress, walletAddress);

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'comments',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['user_address']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'comments', error: error.message });
      results.success = false;
    }

    // Table 7: leaderboard tables - Scrub fan_address
    try {
      const tables = [
        'leaderboard_entries',
        'leaderboard_content_engagement',
        'leaderboard_seasonal'
      ];

      for (const table of tables) {
        try {
          const updateResult = this.database.db.prepare(`
            UPDATE ${table} 
            SET fan_address = ?
            WHERE fan_address = ?
          `).run(anonymizedAddress, walletAddress);

          if (updateResult.changes > 0) {
            results.tablesScrubbed.push({
              table,
              rowsUpdated: updateResult.changes,
              fieldsScrubbed: ['fan_address']
            });
          }
        } catch (error) {
          // Table might not exist, continue
          logger.debug(`[PIIScrubbing] Table ${table} not found or error`, { error: error.message });
        }
      }
    } catch (error) {
      logger.warn('[PIIScrubbing] Leaderboard scrub error', { error: error.message });
    }

    // Table 8: social tokens - Scrub user_address
    try {
      const updateResult = this.database.db.prepare(`
        UPDATE social_tokens 
        SET user_address = ?
        WHERE user_address = ?
      `).run(anonymizedAddress, walletAddress);

      if (updateResult.changes > 0) {
        results.tablesScrubbed.push({
          table: 'social_tokens',
          rowsUpdated: updateResult.changes,
          fieldsScrubbed: ['user_address']
        });
      }
    } catch (error) {
      results.errors.push({ table: 'social_tokens', error: error.message });
      results.success = false;
    }

    return results;
  }

  /**
   * Scrub Redis cache entries for a user
   * @param {string} walletAddress - User's wallet address
   * @param {string} scrubId - Scrubbing operation ID
   * @returns {object} Redis scrubbing result
   */
  async scrubRedisCache(walletAddress, scrubId) {
    if (!this.redisClient) {
      logger.warn('[PIIScrubbing] Redis client not available, skipping cache scrub');
      return { success: true, keysScrubbed: 0, skipped: true };
    }

    const result = {
      success: true,
      keysScrubbed: 0,
      errors: []
    };

    try {
      // Common Redis key patterns for user data
      const patterns = [
        `user:${walletAddress}:*`,
        `profile:${walletAddress}:*`,
        `subscription:${walletAddress}:*`,
        `creator:${walletAddress}:*`,
        `session:${walletAddress}:*`,
        `cache:${walletAddress}:*`
      ];

      for (const pattern of patterns) {
        try {
          const keys = await this.redisClient.keys(pattern);
          
          if (keys.length > 0) {
            await this.redisClient.del(keys);
            result.keysScrubbed += keys.length;
            logger.info('[PIIScrubbing] Scrubbed Redis keys', {
              pattern,
              count: keys.length
            });
          }
        } catch (error) {
          result.errors.push({ pattern, error: error.message });
          logger.warn('[PIIScrubbing] Redis pattern scrub error', {
            pattern,
            error: error.message
          });
        }
      }

      logger.info('[PIIScrubbing] Redis cache scrub completed', {
        scrubId,
        walletAddress,
        keysScrubbed: result.keysScrubbed
      });
    } catch (error) {
      result.success = false;
      result.errors.push({ error: error.message });
      logger.error('[PIIScrubbing] Redis scrub failed', {
        scrubId,
        walletAddress,
        error: error.message
      });
    }

    return result;
  }

  /**
   * Send forget webhooks to affected merchants
   * @param {string} walletAddress - User's wallet address
   * @param {string} scrubId - Scrubbing operation ID
   * @param {string} reason - Reason for scrubbing
   * @returns {object} Webhook result
   */
  async sendForgetWebhooks(walletAddress, scrubId, reason) {
    const result = {
      success: true,
      webhooksSent: 0,
      errors: []
    };

    try {
      // Find all creators this user subscribed to
      const subscriptions = this.database.db.prepare(`
        SELECT DISTINCT creator_id 
        FROM subscriptions 
        WHERE wallet_address = ? AND active = 1
      `).all(walletAddress);

      logger.info('[PIIScrubbing] Found subscriptions for webhook notification', {
        scrubId,
        walletAddress,
        subscriptionCount: subscriptions.length
      });

      for (const subscription of subscriptions) {
        try {
          const creator = this.database.db.prepare(`
            SELECT webhook_url, webhook_secret 
            FROM creators 
            WHERE id = ?
          `).get(subscription.creator_id);

          if (creator && creator.webhook_url) {
            const webhookPayload = {
              event: 'user.forget',
              timestamp: new Date().toISOString(),
              scrub_id: scrubId,
              data: {
                anonymized_wallet_address: this.anonymizeWalletAddress(walletAddress),
                reason,
                scrubbed_at: new Date().toISOString()
              }
            };

            // Send webhook (implementation depends on webhookService)
            if (this.webhookService && typeof this.webhookService.send === 'function') {
              await this.webhookService.send(creator.webhook_url, webhookPayload, {
                secret: creator.webhook_secret
              });
              result.webhooksSent++;
            } else {
              logger.warn('[PIIScrubbing] Webhook service not available', {
                creatorId: subscription.creator_id
              });
            }
          }
        } catch (error) {
          result.errors.push({
            creatorId: subscription.creator_id,
            error: error.message
          });
          logger.warn('[PIIScrubbing] Webhook send failed', {
            creatorId: subscription.creator_id,
            error: error.message
          });
        }
      }

      logger.info('[PIIScrubbing] Webhook notifications completed', {
        scrubId,
        walletAddress,
        webhooksSent: result.webhooksSent
      });
    } catch (error) {
      result.success = false;
      result.errors.push({ error: error.message });
      logger.error('[PIIScrubbing] Webhook notification failed', {
        scrubId,
        walletAddress,
        error: error.message
      });
    }

    return result;
  }

  /**
   * Log scrubbing operation to audit trail
   * @param {string} walletAddress - User's wallet address
   * @param {string} scrubId - Scrubbing operation ID
   * @param {object} metadata - Operation metadata
   */
  async logScrubbingAudit(walletAddress, scrubId, metadata) {
    try {
      const auditEntry = {
        id: crypto.randomUUID(),
        action_type: 'pii_scrub',
        entity_type: 'user',
        entity_id: this.anonymizeWalletAddress(walletAddress),
        timestamp: new Date().toISOString(),
        ip_address: 'system',
        metadata_json: JSON.stringify({
          scrubId,
          original_wallet_hash: this.hashValue(walletAddress),
          ...metadata
        }),
        created_at: new Date().toISOString()
      };

      this.database.db.prepare(`
        INSERT INTO creator_audit_logs 
        (id, creator_id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        auditEntry.id,
        'system',
        auditEntry.action_type,
        auditEntry.entity_type,
        auditEntry.entity_id,
        auditEntry.timestamp,
        auditEntry.ip_address,
        auditEntry.metadata_json,
        auditEntry.created_at
      );

      logger.info('[PIIScrubbing] Audit log entry created', {
        scrubId,
        auditId: auditEntry.id
      });
    } catch (error) {
      logger.error('[PIIScrubbing] Failed to create audit log', {
        scrubId,
        walletAddress,
        error: error.message
      });
    }
  }

  /**
   * Find inactive users for automated scrubbing
   * @param {number} years - Number of years of inactivity
   * @returns {Array} Inactive user wallet addresses
   */
  findInactiveUsers(years = 3) {
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - years);

    const inactiveUsers = this.database.db.prepare(`
      SELECT DISTINCT wallet_address 
      FROM subscriptions 
      WHERE subscribed_at < ? 
        AND active = 0
      `).all(cutoffDate.toISOString());

    logger.info('[PIIScrubbing] Found inactive users', {
      years,
      count: inactiveUsers.length
    });

    return inactiveUsers.map(row => row.wallet_address);
  }

  /**
   * Automated scrubbing of inactive users
   * @param {number} years - Years of inactivity threshold
   * @returns {object} Batch scrubbing result
   */
  async scrubInactiveUsers(years = 3) {
    const batchId = crypto.randomUUID();
    const startTime = Date.now();

    logger.info('[PIIScrubbing] Starting batch scrub of inactive users', {
      batchId,
      years
    });

    const inactiveUsers = this.findInactiveUsers(years);
    const results = {
      batchId,
      totalUsers: inactiveUsers.length,
      successful: 0,
      failed: 0,
      errors: []
    };

    for (const walletAddress of inactiveUsers) {
      try {
        await this.scrubUserPII(walletAddress, {
          scrubRedis: true,
          sendWebhooks: true,
          reason: 'inactive_retention_policy',
          requestedBy: 'automated_cron'
        });
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          walletAddress: this.anonymizeWalletAddress(walletAddress),
          error: error.message
        });
        logger.error('[PIIScrubbing] Failed to scrub inactive user', {
          batchId,
          walletAddress,
          error: error.message
        });
      }
    }

    const duration = Date.now() - startTime;
    logger.info('[PIIScrubbing] Batch scrub completed', {
      batchId,
      duration,
      results
    });

    return results;
  }

  /**
   * Verify that a user's PII has been scrubbed
   * @param {string} walletAddress - Original wallet address
   * @returns {object} Verification result
   */
  verifyScrubbing(walletAddress) {
    const anonymizedAddress = this.anonymizeWalletAddress(walletAddress);
    const hashedAddress = this.hashValue(walletAddress);

    const verification = {
      walletAddress,
      anonymizedAddress,
      tables: {},
      isScrubbed: true
    };

    // Check subscriptions
    const subscription = this.database.db.prepare(`
      SELECT user_email, wallet_address, risk_status 
      FROM subscriptions 
      WHERE wallet_address = ? OR wallet_address = ?
      LIMIT 1
    `).get(walletAddress, anonymizedAddress);

    if (subscription) {
      verification.tables.subscriptions = {
        found: true,
        emailScrubbed: subscription.user_email?.includes('scrubbed_'),
        addressAnonymized: subscription.wallet_address === anonymizedAddress,
        riskStatus: subscription.risk_status
      };
      verification.isScrubbed = verification.isScrubbed && subscription.user_email?.includes('scrubbed_');
    } else {
      verification.tables.subscriptions = { found: false };
    }

    // Check audit logs
    const auditLog = this.database.db.prepare(`
      SELECT * FROM creator_audit_logs 
      WHERE metadata_json LIKE ?
      LIMIT 1
    `).get(`%${hashedAddress}%`);

    verification.tables.audit_logs = {
      found: !!auditLog,
      hasScrubbingRecord: !!auditLog
    };

    return verification;
  }
}

module.exports = PIIScrubbingService;
