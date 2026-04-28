const express = require('express');
const router = express.Router();
const db = require('../src/db/knex');
const GlobalReputationService = require('../services/globalReputationService');
const { authenticateTenant } = require('../middleware/tenantAuth');
const rateLimit = require('express-rate-limit');
const { logger } = require('../src/utils/logger');

const reputationService = new GlobalReputationService();

// Rate limiting for reputation endpoints
const reputationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all reputation routes
router.use(reputationRateLimit);

/**
 * Flag a user for malicious behavior
 * POST /api/reputation/flag
 */
router.post('/flag', authenticateTenant, async (req, res) => {
  try {
    const {
      wallet_address,
      flag_type,
      reason,
      flagged_by_user_id,
      pii_data,
      metadata
    } = req.body;

    const tenant_id = req.tenant.id;

    const result = await reputationService.flagUser({
      tenant_id,
      wallet_address,
      flag_type,
      reason,
      flagged_by_user_id,
      pii_data,
      metadata
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Error flagging user:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Check user reputation before subscription
 * GET /api/reputation/check/:wallet_address
 */
router.get('/check/:wallet_address', authenticateTenant, async (req, res) => {
  try {
    const { wallet_address } = req.params;
    const tenant_id = req.tenant.id;

    const result = await reputationService.checkUserReputation(wallet_address, tenant_id);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Error checking user reputation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check reputation'
    });
  }
});

/**
 * Get reputation history for a user
 * GET /api/reputation/history/:wallet_address
 */
router.get('/history/:wallet_address', authenticateTenant, async (req, res) => {
  try {
    const { wallet_address } = req.params;
    const { limit = 50 } = req.query;

    const history = await reputationService.getReputationHistory(wallet_address, parseInt(limit));

    res.json({
      success: true,
      ...history
    });

  } catch (error) {
    logger.error('Error getting reputation history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get reputation history'
    });
  }
});

/**
 * Get tenant reputation analytics
 * GET /api/reputation/analytics
 */
router.get('/analytics', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;

    const analytics = await reputationService.getTenantReputationAnalytics(tenant_id);

    res.json({
      success: true,
      ...analytics
    });

  } catch (error) {
    logger.error('Error getting reputation analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get analytics'
    });
  }
});

/**
 * Get global reputation statistics (admin only)
 * GET /api/reputation/global-stats
 */
router.get('/global-stats', authenticateTenant, async (req, res) => {
  try {
    // Only allow admin tenants to access global stats
    if (!req.tenant.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const stats = await reputationService.getGlobalReputationStats();

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    logger.error('Error getting global stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get global stats'
    });
  }
});

/**
 * Manual review and adjustment
 * POST /api/reputation/review
 */
router.post('/review', authenticateTenant, async (req, res) => {
  try {
    const {
      wallet_address,
      review_decision,
      adjustment_score,
      review_notes,
      reviewed_by_user_id
    } = req.body;

    const tenant_id = req.tenant.id;

    const result = await reputationService.reviewAndAdjust({
      tenant_id,
      wallet_address,
      review_decision,
      adjustment_score,
      review_notes,
      reviewed_by_user_id
    });

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Error in reputation review:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get review queue for tenant
 * GET /api/reputation/review-queue
 */
router.get('/review-queue', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;
    const { status = 'pending', limit = 20, offset = 0 } = req.query;

    const queue = await db('reputation_review_queue')
      .where('assigned_to_tenant_id', tenant_id)
      .where('status', status)
      .orderBy('priority', 'desc')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .select([
        'id',
        'global_reputation_id',
        'priority',
        'status',
        'review_reason',
        'assigned_at',
        'review_started_at',
        'review_completed_at'
      ]);

    // Get reputation details for each queue item
    const queueWithDetails = await Promise.all(
      queue.map(async (item) => {
        const reputation = await db('global_reputation_scores')
          .where({ id: item.global_reputation_id })
          .first([
            'wallet_address',
            'reputation_score',
            'risk_level',
            'total_flags',
            'last_flagged_at'
          ]);

        return {
          ...item,
          reputation
        };
      })
    );

    res.json({
      success: true,
      queue: queueWithDetails,
      total: queueWithDetails.length
    });

  } catch (error) {
    logger.error('Error getting review queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get review queue'
    });
  }
});

/**
 * Update tenant reputation settings
 * PUT /api/reputation/settings
 */
router.put('/settings', authenticateTenant, async (req, res) => {
  try {
    const {
      global_reputation_enabled,
      warning_threshold,
      blocking_threshold,
      auto_rejection_enabled,
      custom_flag_weights,
      share_flags_with_global,
      receive_global_flags,
      flags_required_for_review,
      rejection_message_template
    } = req.body;

    const tenant_id = req.tenant.id;

    await db('tenant_reputation_settings')
      .where({ tenant_id })
      .update({
        global_reputation_enabled,
        warning_threshold,
        blocking_threshold,
        auto_rejection_enabled,
        custom_flag_weights: JSON.stringify(custom_flag_weights || {}),
        share_flags_with_global,
        receive_global_flags,
        flags_required_for_review,
        rejection_message_template,
        updated_at: new Date()
      });

    const settings = await reputationService.getTenantSettings(tenant_id);

    res.json({
      success: true,
      settings
    });

  } catch (error) {
    logger.error('Error updating reputation settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update settings'
    });
  }
});

/**
 * Get tenant reputation settings
 * GET /api/reputation/settings
 */
router.get('/settings', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;

    const settings = await reputationService.getTenantSettings(tenant_id);

    res.json({
      success: true,
      settings
    });

  } catch (error) {
    logger.error('Error getting reputation settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get settings'
    });
  }
});

/**
 * Get reputation events for monitoring
 * GET /api/reputation/events
 */
router.get('/events', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;
    const { 
      event_type, 
      wallet_address, 
      limit = 50, 
      offset = 0,
      start_date,
      end_date
    } = req.query;

    let query = db('reputation_events')
      .where({ tenant_id });

    if (event_type) {
      query = query.where('event_type', event_type);
    }

    if (wallet_address) {
      query = query.where('wallet_address', wallet_address.toLowerCase());
    }

    if (start_date) {
      query = query.where('created_at', '>=', new Date(start_date));
    }

    if (end_date) {
      query = query.where('created_at', '<=', new Date(end_date));
    }

    const events = await query
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .select([
        'id',
        'wallet_address',
        'event_type',
        'score_impact',
        'previous_score',
        'new_score',
        'reason',
        'created_at',
        'flagged_by_tenant_name'
      ]);

    res.json({
      success: true,
      events,
      total: events.length
    });

  } catch (error) {
    logger.error('Error getting reputation events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get events'
    });
  }
});

/**
 * Bulk flag users (for batch processing)
 * POST /api/reputation/bulk-flag
 */
router.post('/bulk-flag', authenticateTenant, async (req, res) => {
  try {
    const { flags } = req.body; // Array of flag objects
    const tenant_id = req.tenant.id;

    if (!Array.isArray(flags) || flags.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Flags array is required'
      });
    }

    const results = [];
    const errors = [];

    for (const flag of flags) {
      try {
        const result = await reputationService.flagUser({
          tenant_id,
          ...flag
        });
        results.push({
          wallet_address: flag.wallet_address,
          success: true,
          ...result
        });
      } catch (error) {
        errors.push({
          wallet_address: flag.wallet_address,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      processed: results.length,
      errors: errors.length,
      results,
      errors
    });

  } catch (error) {
    logger.error('Error in bulk flagging:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk flags'
    });
  }
});

/**
 * Export reputation data (CSV)
 * GET /api/reputation/export
 */
router.get('/export', authenticateTenant, async (req, res) => {
  try {
    const tenant_id = req.tenant.id;
    const { format = 'csv', start_date, end_date } = req.query;

    let query = db('reputation_events')
      .where({ tenant_id });

    if (start_date) {
      query = query.where('created_at', '>=', new Date(start_date));
    }

    if (end_date) {
      query = query.where('created_at', '<=', new Date(end_date));
    }

    const events = await query
      .orderBy('created_at', 'desc')
      .select([
        'wallet_address',
        'event_type',
        'score_impact',
        'previous_score',
        'new_score',
        'reason',
        'created_at',
        'flagged_by_tenant_name'
      ]);

    if (format === 'csv') {
      // Convert to CSV
      const csvHeader = 'Wallet Address,Event Type,Score Impact,Previous Score,New Score,Reason,Created At,Flagged By\n';
      const csvData = events.map(event => 
        `"${event.wallet_address}","${event.event_type}",${event.score_impact},${event.previous_score},${event.new_score},"${event.reason}","${event.created_at}","${event.flagged_by_tenant_name}"`
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="reputation-export-${tenant_id}-${Date.now()}.csv"`);
      res.send(csvHeader + csvData);
    } else {
      res.json({
        success: true,
        events
      });
    }

  } catch (error) {
    logger.error('Error exporting reputation data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export data'
    });
  }
});

module.exports = router;
