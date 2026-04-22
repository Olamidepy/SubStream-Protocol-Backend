const express = require('express');
const { authenticateToken, getUserId } = require('../middleware/unifiedAuth');
const NotificationService = require('../services/notificationService');

const router = express.Router();

/**
 * Initialize notification service with middleware
 */
router.use((req, res, next) => {
  if (!req.app.get('notificationService')) {
    // Initialize notification service if not already initialized
    const notificationService = new NotificationService({
      defaultProvider: process.env.DEFAULT_EMAIL_PROVIDER || 'ses',
      ses: {
        region: process.env.AWS_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN
      },
      sendgrid: {
        apiKey: process.env.SENDGRID_API_KEY
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB) || 0
      },
      queueName: process.env.NOTIFICATION_QUEUE_NAME || 'notification-queue',
      concurrency: parseInt(process.env.NOTIFICATION_CONCURRENCY) || 5,
      rateLimitMax: parseInt(process.env.NOTIFICATION_RATE_LIMIT_MAX) || 100,
      rateLimitDuration: parseInt(process.env.NOTIFICATION_RATE_LIMIT_DURATION) || 60000
    });
    
    // Create predefined templates
    notificationService.createPredefinedTemplates();
    
    req.app.set('notificationService', notificationService);
  }
  
  next();
});

/**
 * POST /api/v1/notifications/send
 * Send email using template
 */
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      to,
      from,
      subject,
      templateId,
      templateData,
      provider,
      options = {}
    } = req.body;

    // Validate required fields
    if (!to || !templateId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, templateId'
      });
    }

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.sendEmail({
      to,
      from: from || process.env.DEFAULT_FROM_EMAIL,
      subject,
      templateId,
      templateData: templateData || {}
    }, {
      provider,
      attempts: options.attempts,
      delay: options.delay,
      priority: options.priority
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send email'
    });
  }
});

/**
 * POST /api/v1/notifications/send-simple
 * Send simple text/HTML email
 */
router.post('/send-simple', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      to,
      from,
      subject,
      text,
      html,
      provider,
      options = {}
    } = req.body;

    // Validate required fields
    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, subject, and either text or html'
      });
    }

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.sendSimpleEmail({
      to,
      from: from || process.env.DEFAULT_FROM_EMAIL,
      subject,
      text,
      html
    }, {
      provider,
      attempts: options.attempts,
      delay: options.delay,
      priority: options.priority
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send simple email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send simple email'
    });
  }
});

/**
 * POST /api/v1/notifications/send-bulk
 * Send bulk email to multiple recipients
 */
router.post('/send-bulk', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      recipients,
      from,
      subject,
      templateId,
      templateData,
      provider,
      options = {}
    } = req.body;

    // Validate required fields
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: recipients (must be non-empty array)'
      });
    }

    if (!templateId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: templateId'
      });
    }

    // Validate recipients
    const invalidRecipients = recipients.filter(r => !r.email);
    if (invalidRecipients.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipients: missing email field',
        invalidRecipients
      });
    }

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.sendBulkEmail({
      recipients,
      from: from || process.env.DEFAULT_FROM_EMAIL,
      subject,
      templateId,
      templateData: templateData || {},
      options
    }, {
      provider,
      attempts: options.attempts,
      delay: options.delay,
      priority: options.priority
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send bulk email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send bulk email'
    });
  }
});

/**
 * POST /api/v1/notifications/send-template
 * Send email using predefined template
 */
router.post('/send-template', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      templateType,
      to,
      from,
      templateData,
      provider,
      options = {}
    } = req.body;

    // Validate required fields
    if (!templateType || !to) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: templateType, to'
      });
    }

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.sendTemplateEmail(templateType, {
      to,
      from: from || process.env.DEFAULT_FROM_EMAIL,
      templateData: templateData || {}
    }, {
      provider,
      attempts: options.attempts,
      delay: options.delay,
      priority: options.priority
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send template email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send template email'
    });
  }
});

/**
 * GET /api/v1/notifications/job/:jobId
 * Get job status
 */
router.get('/job/:jobId', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { jobId } = req.params;

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.getJobStatus(jobId);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Get job status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get job status'
    });
  }
});

/**
 * GET /api/v1/notifications/queue/stats
 * Get queue statistics
 */
router.get('/queue/stats', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.getQueueStats();

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Get queue stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get queue statistics'
    });
  }
});

/**
 * GET /api/v1/notifications/queue/jobs
 * Get recent jobs
 */
router.get('/queue/jobs', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      state = 'completed',
      start = 0,
      end = 50
    } = req.query;

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.getRecentJobs({
      state,
      start: parseInt(start),
      end: parseInt(end)
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Get recent jobs error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get recent jobs'
    });
  }
});

/**
 * GET /api/v1/notifications/providers
 * Get available providers
 */
router.get('/providers', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    const providers = notificationService.getAvailableProviders();
    const stats = notificationService.getProviderStats();

    res.json({
      success: true,
      data: {
        availableProviders: providers,
        defaultProvider: notificationService.defaultProvider,
        providerStats: stats
      }
    });

  } catch (error) {
    console.error('Get providers error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get providers'
    });
  }
});

/**
 * POST /api/v1/notifications/providers/switch
 * Switch default provider
 */
router.post('/providers/switch', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { provider } = req.body;

    if (!provider) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: provider'
      });
    }

    const notificationService = req.app.get('notificationService');
    const result = notificationService.switchProvider(provider);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Switch provider error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to switch provider'
    });
  }
});

/**
 * POST /api/v1/notifications/providers/test
 * Test provider connection
 */
router.post('/providers/test', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { provider } = req.body;

    const notificationService = req.app.get('notificationService');
    const results = await notificationService.testProviderConnection(provider);

    res.json({
      success: true,
      data: results
    });

  } catch (error) {
    console.error('Test provider error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to test provider'
    });
  }
});

/**
 * GET /api/v1/notifications/templates
 * Get template mappings
 */
router.get('/templates', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    
    // Get all template mappings
    const templates = {};
    for (const [templateId, mapping] of notificationService.templateMappings) {
      templates[templateId] = mapping;
    }

    res.json({
      success: true,
      data: {
        templates,
        count: Object.keys(templates).length
      }
    });

  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get templates'
    });
  }
});

/**
 * POST /api/v1/notifications/templates
 * Add template mapping
 */
router.post('/templates', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { templateId, mapping } = req.body;

    if (!templateId || !mapping) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: templateId, mapping'
      });
    }

    const notificationService = req.app.get('notificationService');
    notificationService.addTemplateMapping(templateId, mapping);

    res.json({
      success: true,
      message: 'Template mapping added successfully',
      data: {
        templateId,
        mapping
      }
    });

  } catch (error) {
    console.error('Add template mapping error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add template mapping'
    });
  }
});

/**
 * DELETE /api/v1/notifications/templates/:templateId
 * Remove template mapping
 */
router.delete('/templates/:templateId', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { templateId } = req.params;

    const notificationService = req.app.get('notificationService');
    notificationService.removeTemplateMapping(templateId);

    res.json({
      success: true,
      message: 'Template mapping removed successfully',
      data: {
        templateId
      }
    });

  } catch (error) {
    console.error('Remove template mapping error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove template mapping'
    });
  }
});

/**
 * GET /api/v1/notifications/health
 * Get service health status
 */
router.get('/health', async (req, res) => {
  try {
    const notificationService = req.app.get('notificationService');
    const health = notificationService.getHealthStatus();

    res.json({
      success: true,
      data: health
    });

  } catch (error) {
    console.error('Get health status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get health status'
    });
  }
});

/**
 * POST /api/v1/notifications/queue/pause
 * Pause queue processing
 */
router.post('/queue/pause', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.queueService.pauseQueue();

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Pause queue error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to pause queue'
    });
  }
});

/**
 * POST /api/v1/notifications/queue/resume
 * Resume queue processing
 */
router.post('/queue/resume', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.queueService.resumeQueue();

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Resume queue error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to resume queue'
    });
  }
});

/**
 * POST /api/v1/notifications/queue/clear
 * Clear queue
 */
router.post('/queue/clear', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { state = 'waiting' } = req.body;

    const notificationService = req.app.get('notificationService');
    const result = await notificationService.queueService.clearQueue({ state });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Clear queue error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear queue'
    });
  }
});

/**
 * POST /api/v1/notifications/test-email
 * Send test email
 */
router.post('/test-email', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      to,
      provider,
      templateType = 'welcome'
    } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: to'
      });
    }

    const notificationService = req.app.get('notificationService');
    
    // Send test email using predefined template
    const result = await notificationService.sendTemplateEmail(templateType, {
      to,
      templateData: {
        name: 'Test User',
        testMode: true,
        timestamp: new Date().toISOString()
      }
    }, {
      provider,
      attempts: 1
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send test email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send test email'
    });
  }
});

/**
 * GET /api/v1/notifications/stats
 * Get comprehensive statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    const notificationService = req.app.get('notificationService');
    
    // Get queue stats
    const queueStats = await notificationService.getQueueStats();
    
    // Get provider stats
    const providerStats = notificationService.getProviderStats();
    
    // Get health status
    const health = notificationService.getHealthStatus();

    res.json({
      success: true,
      data: {
        queue: queueStats,
        providers: providerStats,
        health,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get statistics'
    });
  }
});

module.exports = router;
