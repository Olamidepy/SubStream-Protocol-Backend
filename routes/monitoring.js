const express = require('express');
const router = express.Router();
const { authenticateTenant } = require('../middleware/tenantAuth');
const rateLimit = require('express-rate-limit');
const { logger } = require('../src/utils/logger');

// Rate limiting for monitoring endpoints
const monitoringRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // Limit each IP to 200 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all monitoring routes
router.use(monitoringRateLimit);

/**
 * Get global monitoring statistics
 * GET /api/monitoring/stats
 */
router.get('/stats', authenticateTenant, async (req, res) => {
  try {
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    const stats = monitoringService.getGlobalStats();

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    logger.error('Error getting monitoring stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get monitoring stats'
    });
  }
});

/**
 * Get endpoint-specific statistics
 * GET /api/monitoring/endpoint/:endpoint
 */
router.get('/endpoint/:endpoint', authenticateTenant, async (req, res) => {
  try {
    const { endpoint } = req.params;
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    const stats = monitoringService.getEndpointStats(endpoint);

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    logger.error('Error getting endpoint stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get endpoint stats'
    });
  }
});

/**
 * Get all endpoint statistics
 * GET /api/monitoring/endpoints
 */
router.get('/endpoints', authenticateTenant, async (req, res) => {
  try {
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    const stats = monitoringService.getEndpointStats();

    res.json({
      success: true,
      endpoints: stats
    });

  } catch (error) {
    logger.error('Error getting all endpoint stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get endpoint stats'
    });
  }
});

/**
 * Get recent monitoring alerts
 * GET /api/monitoring/alerts
 */
router.get('/alerts', authenticateTenant, async (req, res) => {
  try {
    const { limit = 50, severity, acknowledged } = req.query;
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    let query = db('monitoring_alerts')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit));

    if (severity) {
      query = query.where('severity', severity);
    }

    if (acknowledged !== undefined) {
      query = query.where('acknowledged', acknowledged === 'true');
    }

    const alerts = await query.select([
      'id',
      'endpoint',
      'severity',
      'alert_type',
      'error_count',
      'threshold',
      'monitoring_window',
      'acknowledged',
      'acknowledged_by',
      'acknowledged_at',
      'acknowledgment_notes',
      'created_at',
      'alert_data'
    ]);

    res.json({
      success: true,
      alerts,
      total: alerts.length
    });

  } catch (error) {
    logger.error('Error getting monitoring alerts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get alerts'
    });
  }
});

/**
 * Acknowledge an alert
 * POST /api/monitoring/alerts/:alertId/acknowledge
 */
router.post('/alerts/:alertId/acknowledge', authenticateTenant, async (req, res) => {
  try {
    const { alertId } = req.params;
    const { notes } = req.body;
    const tenant_id = req.tenant.id;

    await db('monitoring_alerts')
      .where({ id: alertId })
      .update({
        acknowledged: true,
        acknowledged_by: tenant_id,
        acknowledged_at: new Date(),
        acknowledgment_notes: notes
      });

    logger.info('Monitoring alert acknowledged', {
      alertId,
      acknowledged_by: tenant_id,
      notes
    });

    res.json({
      success: true,
      message: 'Alert acknowledged successfully'
    });

  } catch (error) {
    logger.error('Error acknowledging alert:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to acknowledge alert'
    });
  }
});

/**
 * Get monitoring dashboard data
 * GET /api/monitoring/dashboard
 */
router.get('/dashboard', authenticateTenant, async (req, res) => {
  try {
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    const globalStats = monitoringService.getGlobalStats();
    const endpointStats = monitoringService.getEndpointStats();
    
    // Get recent alerts
    const recentAlerts = await monitoringService.getRecentAlerts(10);
    
    // Get performance metrics for the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const performanceMetrics = await db('endpoint_performance_metrics')
      .where('window_start', '>=', oneHourAgo)
      .orderBy('window_start', 'desc')
      .limit(100)
      .select([
        'endpoint',
        'method',
        'total_requests',
        'total_errors',
        'total_5xx_errors',
        'avg_response_time',
        'error_rate',
        'window_start'
      ]);

    // Calculate dashboard metrics
    const dashboard = {
      overview: {
        total_requests: globalStats.totalRequests,
        total_errors: globalStats.totalErrors,
        total_5xx_errors: globalStats.total5xxErrors,
        error_rate: globalStats.totalRequests > 0 
          ? (globalStats.totalErrors / globalStats.totalRequests) * 100 
          : 0,
        active_endpoints: globalStats.activeEndpoints,
        endpoints_with_errors: globalStats.endpointsWithErrors,
        current_error_rate: globalStats.currentErrorRate,
        last_error_time: globalStats.lastErrorTime
      },
      recent_alerts: recentAlerts.map(alert => ({
        id: alert.id,
        endpoint: alert.endpoint,
        severity: alert.severity,
        alert_type: alert.alert_type,
        error_count: alert.error_count,
        threshold: alert.threshold,
        created_at: alert.created_at,
        acknowledged: alert.acknowledged
      })),
      top_error_endpoints: Object.entries(endpointStats)
        .map(([endpoint, stats]) => ({
          endpoint,
          total_errors: stats.stats.totalErrors || 0,
          total_5xx_errors: stats.stats.total5xxErrors || 0,
          error_rate: stats.stats.totalRequests > 0 
            ? (stats.stats.totalErrors / stats.stats.totalRequests) * 100 
            : 0,
          last_error_time: stats.stats.lastErrorTime
        }))
        .filter(ep => ep.total_errors > 0)
        .sort((a, b) => b.total_5xx_errors - a.total_5xx_errors)
        .slice(0, 10),
      performance_trends: performanceMetrics
    };

    res.json({
      success: true,
      ...dashboard
    });

  } catch (error) {
    logger.error('Error getting monitoring dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get dashboard data'
    });
  }
});

/**
 * Create monitoring notification configuration
 * POST /api/monitoring/notifications
 */
router.post('/notifications', authenticateTenant, async (req, res) => {
  try {
    const {
      name,
      notification_type,
      recipient,
      endpoint_patterns,
      severity_filter,
      webhook_secret,
      notification_config
    } = req.body;

    const tenant_id = req.tenant.id;

    const [notification] = await db('monitoring_notifications')
      .insert({
        name,
        notification_type,
        recipient,
        endpoint_patterns,
        severity_filter,
        webhook_secret,
        notification_config: JSON.stringify(notification_config || {}),
        active: true
      })
      .returning('*');

    logger.info('Monitoring notification created', {
      notification_id: notification.id,
      name,
      notification_type,
      created_by: tenant_id
    });

    res.json({
      success: true,
      notification
    });

  } catch (error) {
    logger.error('Error creating monitoring notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create notification'
    });
  }
});

/**
 * Get monitoring notifications
 * GET /api/monitoring/notifications
 */
router.get('/notifications', authenticateTenant, async (req, res) => {
  try {
    const notifications = await db('monitoring_notifications')
      .where({ active: true })
      .orderBy('created_at', 'desc')
      .select([
        'id',
        'name',
        'notification_type',
        'recipient',
        'endpoint_patterns',
        'severity_filter',
        'active',
        'created_at',
        'updated_at'
      ]);

    res.json({
      success: true,
      notifications
    });

  } catch (error) {
    logger.error('Error getting monitoring notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get notifications'
    });
  }
});

/**
 * Update monitoring notification
 * PUT /api/monitoring/notifications/:notificationId
 */
router.put('/notifications/:notificationId', authenticateTenant, async (req, res) => {
  try {
    const { notificationId } = req.params;
    const {
      name,
      notification_type,
      recipient,
      endpoint_patterns,
      severity_filter,
      webhook_secret,
      notification_config,
      active
    } = req.body;

    await db('monitoring_notifications')
      .where({ id: notificationId })
      .update({
        name,
        notification_type,
        recipient,
        endpoint_patterns,
        severity_filter,
        webhook_secret,
        notification_config: JSON.stringify(notification_config || {}),
        active,
        updated_at: new Date()
      });

    const notification = await db('monitoring_notifications')
      .where({ id: notificationId })
      .first();

    logger.info('Monitoring notification updated', {
      notification_id: notificationId,
      updated_by: req.tenant.id
    });

    res.json({
      success: true,
      notification
    });

  } catch (error) {
    logger.error('Error updating monitoring notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notification'
    });
  }
});

/**
 * Delete monitoring notification
 * DELETE /api/monitoring/notifications/:notificationId
 */
router.delete('/notifications/:notificationId', authenticateTenant, async (req, res) => {
  try {
    const { notificationId } = req.params;

    await db('monitoring_notifications')
      .where({ id: notificationId })
      .update({ active: false });

    logger.info('Monitoring notification deleted', {
      notification_id: notificationId,
      deleted_by: req.tenant.id
    });

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });

  } catch (error) {
    logger.error('Error deleting monitoring notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete notification'
    });
  }
});

/**
 * Force trigger an alert (admin only)
 * POST /api/monitoring/force-alert
 */
router.post('/force-alert', authenticateTenant, async (req, res) => {
  try {
    // Only allow admin tenants
    if (!req.tenant.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { endpoint, severity, message } = req.body;
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    monitoringService.forceAlert(endpoint, severity, message);

    logger.info('Manual alert triggered', {
      endpoint,
      severity,
      message,
      triggered_by: req.tenant.id
    });

    res.json({
      success: true,
      message: 'Alert triggered successfully'
    });

  } catch (error) {
    logger.error('Error forcing alert:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger alert'
    });
  }
});

/**
 * Reset monitoring statistics (admin only)
 * POST /api/monitoring/reset
 */
router.post('/reset', authenticateTenant, async (req, res) => {
  try {
    // Only allow admin tenants
    if (!req.tenant.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { endpoint } = req.body;
    const monitoringService = req.app.get('endpointMonitoringService');
    
    if (!monitoringService) {
      return res.status(503).json({
        success: false,
        error: 'Monitoring service not available'
      });
    }

    monitoringService.resetEndpointStats(endpoint);

    logger.info('Monitoring statistics reset', {
      endpoint,
      reset_by: req.tenant.id
    });

    res.json({
      success: true,
      message: `Statistics reset for ${endpoint || 'all endpoints'}`
    });

  } catch (error) {
    logger.error('Error resetting monitoring stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset statistics'
    });
  }
});

module.exports = router;
