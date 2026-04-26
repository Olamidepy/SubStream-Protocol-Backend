/**
 * Compliance API Routes
 * 
 * Provides endpoints for GDPR/CCPA compliance including:
 * - Right to be Forgotten (data deletion)
 * - Data export requests
 * - Privacy preferences management
 */

const express = require('express');
const router = express.Router();
const PIIScrubbingService = require('../services/piiScrubbingService');
const logger = require('../utils/logger');

/**
 * POST /api/v1/compliance/forget
 * 
 * Initiates the Right to be Forgotten process for a user.
 * This permanently obfuscates PII while preserving financial data for tax compliance.
 * 
 * Request Body:
 * {
 *   "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
 *   "reason": "user_request" | "inactive_retention" | "legal_requirement",
 *   "requestedBy": "user" | "admin" | "system"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "scrubId": "uuid",
 *   "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
 *   "duration": 1234,
 *   "dbResult": { ... },
 *   "redisResult": { ... },
 *   "webhookResult": { ... }
 * }
 */
router.post('/forget', async (req, res) => {
  const { walletAddress, reason = 'user_request', requestedBy = 'user' } = req.body;

  // Validate input
  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      error: 'walletAddress is required'
    });
  }

  // Validate wallet address format (basic Stellar address validation)
  if (!walletAddress.match(/^G[A-Z0-9]{55}$/)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid wallet address format'
    });
  }

  // Validate reason
  const validReasons = ['user_request', 'inactive_retention', 'legal_requirement'];
  if (!validReasons.includes(reason)) {
    return res.status(400).json({
      success: false,
      error: `Invalid reason. Must be one of: ${validReasons.join(', ')}`
    });
  }

  logger.info('[Compliance] Forget request received', {
    walletAddress,
    reason,
    requestedBy,
    ip: req.ip
  });

  try {
    // Initialize PII scrubbing service
    const piiService = new PIIScrubbingService({
      database: req.database,
      redisClient: req.redisClient,
      webhookService: req.webhookService,
      auditLogService: req.auditLogService
    });

    // Execute PII scrubbing
    const result = await piiService.scrubUserPII(walletAddress, {
      scrubRedis: true,
      sendWebhooks: true,
      reason,
      requestedBy
    });

    res.status(200).json({
      success: true,
      message: 'PII scrubbing completed successfully',
      ...result
    });
  } catch (error) {
    logger.error('[Compliance] Forget request failed', {
      walletAddress,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: 'Failed to process forget request',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/compliance/forget/:walletAddress/status
 * 
 * Check the scrubbing status of a user's PII.
 * 
 * Response:
 * {
 *   "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
 *   "anonymizedAddress": "GD5DQ6ZQZ_abc123...",
 *   "tables": {
 *     "subscriptions": { ... },
 *     "audit_logs": { ... }
 *   },
 *   "isScrubbed": true
 * }
 */
router.get('/forget/:walletAddress/status', async (req, res) => {
  const { walletAddress } = req.params;

  // Validate wallet address format
  if (!walletAddress.match(/^G[A-Z0-9]{55}$/)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid wallet address format'
    });
  }

  try {
    const piiService = new PIIScrubbingService({
      database: req.database
    });

    const verification = piiService.verifyScrubbing(walletAddress);

    res.status(200).json({
      success: true,
      ...verification
    });
  } catch (error) {
    logger.error('[Compliance] Status check failed', {
      walletAddress,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to check scrubbing status',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/compliance/forget/batch
 * 
 * Admin-only endpoint to batch scrub inactive users.
 * Requires admin authentication.
 * 
 * Request Body:
 * {
 *   "years": 3,
 *   "dryRun": false
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "batchId": "uuid",
 *   "totalUsers": 100,
 *   "successful": 95,
 *   "failed": 5,
 *   "errors": [ ... ]
 * }
 */
router.post('/forget/batch', async (req, res) => {
  // Admin authentication check (implement based on your auth system)
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { years = 3, dryRun = false } = req.body;

  if (years < 1 || years > 10) {
    return res.status(400).json({
      success: false,
      error: 'Years must be between 1 and 10'
    });
  }

  logger.info('[Compliance] Batch forget request', {
    years,
    dryRun,
    requestedBy: req.user.id
  });

  try {
    const piiService = new PIIScrubbingService({
      database: req.database,
      redisClient: req.redisClient,
      webhookService: req.webhookService,
      auditLogService: req.auditLogService
    });

    if (dryRun) {
      // Just count inactive users without scrubbing
      const inactiveUsers = piiService.findInactiveUsers(years);
      
      return res.status(200).json({
        success: true,
        dryRun: true,
        totalUsers: inactiveUsers.length,
        message: 'Dry run completed. No data was scrubbed.'
      });
    }

    const result = await piiService.scrubInactiveUsers(years);

    res.status(200).json({
      success: true,
      message: 'Batch scrubbing completed',
      ...result
    });
  } catch (error) {
    logger.error('[Compliance] Batch forget failed', {
      years,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to process batch forget request',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/compliance/audit
 * 
 * Retrieve audit logs for PII scrubbing operations.
 * Requires admin authentication.
 * 
 * Query Parameters:
 * - limit: Number of records to return (default: 50)
 * - offset: Offset for pagination (default: 0)
 * 
 * Response:
 * {
 *   "success": true,
 *   "logs": [ ... ],
 *   "total": 100
 * }
 */
router.get('/audit', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  if (limit > 1000) {
    return res.status(400).json({
      success: false,
      error: 'Limit cannot exceed 1000'
    });
  }

  try {
    const logs = req.database.db.prepare(`
      SELECT id, creator_id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json, created_at
      FROM creator_audit_logs
      WHERE action_type = 'pii_scrub'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = req.database.db.prepare(`
      SELECT COUNT(*) as count
      FROM creator_audit_logs
      WHERE action_type = 'pii_scrub'
    `).get().count;

    res.status(200).json({
      success: true,
      logs: logs.map(log => ({
        ...log,
        metadata: JSON.parse(log.metadata_json)
      })),
      total,
      limit,
      offset
    });
  } catch (error) {
    logger.error('[Compliance] Audit log retrieval failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve audit logs',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/compliance/export
 * 
 * Export a user's data for GDPR data portability requests.
 * 
 * Request Body:
 * {
 *   "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "exportId": "uuid",
 *   "data": { ... },
 *   "format": "json"
 * }
 */
router.post('/export', async (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress) {
    return res.status(400).json({
      success: false,
      error: 'walletAddress is required'
    });
  }

  // Validate wallet address format
  if (!walletAddress.match(/^G[A-Z0-9]{55}$/)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid wallet address format'
    });
  }

  logger.info('[Compliance] Data export request', {
    walletAddress,
    ip: req.ip
  });

  try {
    const exportId = require('crypto').randomUUID();
    const exportData = {
      exportId,
      walletAddress,
      exportedAt: new Date().toISOString(),
      subscriptions: [],
      comments: [],
      auditLogs: []
    };

    // Export subscriptions
    const subscriptions = req.database.db.prepare(`
      SELECT creator_id, wallet_address, active, subscribed_at, balance, daily_spend, user_email, risk_status
      FROM subscriptions
      WHERE wallet_address = ?
    `).all(walletAddress);

    exportData.subscriptions = subscriptions;

    // Export comments
    const comments = req.database.db.prepare(`
      SELECT id, post_id, user_address, creator_id, content, created_at, updated_at
      FROM comments
      WHERE user_address = ?
    `).all(walletAddress);

    exportData.comments = comments;

    // Export audit logs (limited to last 100)
    const auditLogs = req.database.db.prepare(`
      SELECT id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json
      FROM creator_audit_logs
      WHERE metadata_json LIKE ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(`%${walletAddress}%`);

    exportData.auditLogs = auditLogs.map(log => ({
      ...log,
      metadata: JSON.parse(log.metadata_json)
    }));

    // Log the export request
    req.database.db.prepare(`
      INSERT INTO data_export_tracking (id, wallet_address, requester_email, export_type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      walletAddress,
      'user@anon.example.com',
      'pii_export',
      'completed',
      new Date().toISOString()
    );

    res.status(200).json({
      success: true,
      message: 'Data export completed',
      ...exportData
    });
  } catch (error) {
    logger.error('[Compliance] Data export failed', {
      walletAddress,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to export data',
      message: error.message
    });
  }
});

module.exports = router;
