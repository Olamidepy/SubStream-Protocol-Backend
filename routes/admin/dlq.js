const express = require('express');
const router = express.Router();

/**
 * Admin API routes for Dead-Letter Queue management
 */

/**
 * POST /admin/dlq/retry
 * Manually retry a specific DLQ item
 */
router.post('/retry', async (req, res) => {
  try {
    const { dlqId } = req.body;
    
    if (!dlqId) {
      return res.status(400).json({
        success: false,
        error: 'dlqId is required'
      });
    }

    // Get DLQ service from app locals
    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    // Retry the DLQ item
    const result = await dlqService.retryDlqItem(dlqId, 'admin');
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('DLQ retry error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /admin/dlq/batch-retry
 * Manually retry multiple DLQ items
 */
router.post('/batch-retry', async (req, res) => {
  try {
    const { dlqIds } = req.body;
    
    if (!Array.isArray(dlqIds) || dlqIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'dlqIds must be a non-empty array'
      });
    }

    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    const results = [];
    
    for (const dlqId of dlqIds) {
      try {
        const result = await dlqService.retryDlqItem(dlqId, 'admin');
        results.push({
          dlqId,
          success: true,
          data: result
        });
      } catch (error) {
        results.push({
          dlqId,
          success: false,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        results,
        total: dlqIds.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      }
    });
    
  } catch (error) {
    console.error('DLQ batch retry error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /admin/dlq/items
 * List DLQ items with filtering and pagination
 */
router.get('/items', async (req, res) => {
  try {
    const {
      status,
      errorCategory,
      limit = 50,
      offset = 0,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    const items = await dlqService.listDlqItems({
      status,
      errorCategory,
      limit: parseInt(limit),
      offset: parseInt(offset),
      sortBy,
      sortOrder
    });
    
    res.json({
      success: true,
      data: {
        items,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: items.length
        }
      }
    });
    
  } catch (error) {
    console.error('DLQ items list error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /admin/dlq/item/:dlqId
 * Get details of a specific DLQ item
 */
router.get('/item/:dlqId', async (req, res) => {
  try {
    const { dlqId } = req.params;
    
    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    const item = await dlqService.getDlqItem(dlqId);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'DLQ item not found'
      });
    }
    
    // Get retry attempts for this item
    const retryAttempts = await dlqService.getRetryAttempts(dlqId);
    
    res.json({
      success: true,
      data: {
        item,
        retryAttempts
      }
    });
    
  } catch (error) {
    console.error('DLQ item details error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /admin/dlq/stats
 * Get DLQ statistics and health information
 */
router.get('/stats', async (req, res) => {
  try {
    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    const stats = await dlqService.getStats();
    
    res.json({
      success: true,
      data: stats
    });
    
  } catch (error) {
    console.error('DLQ stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /admin/dlq/resolve
 * Manually mark a DLQ item as resolved
 */
router.post('/resolve', async (req, res) => {
  try {
    const { dlqId, resolutionNotes } = req.body;
    
    if (!dlqId) {
      return res.status(400).json({
        success: false,
        error: 'dlqId is required'
      });
    }

    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    await dlqService.markAsResolved(dlqId, 'admin', resolutionNotes || 'Manually resolved by admin');
    
    res.json({
      success: true,
      data: {
        dlqId,
        status: 'resolved',
        resolvedBy: 'admin',
        resolutionNotes
      }
    });
    
  } catch (error) {
    console.error('DLQ resolve error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /admin/dlq/cleanup
 * Manually trigger cleanup of expired items
 */
router.post('/cleanup', async (req, res) => {
  try {
    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    await dlqService.cleanupExpiredItems();
    
    res.json({
      success: true,
      message: 'Cleanup completed'
    });
    
  } catch (error) {
    console.error('DLQ cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /admin/dlq/health
 * Health check for DLQ system
 */
router.get('/health', async (req, res) => {
  try {
    const dlqService = req.app.locals.dlqService;
    
    if (!dlqService) {
      return res.status(503).json({
        success: false,
        error: 'DLQ service not available'
      });
    }

    const stats = await dlqService.getStats();
    const isHealthy = stats.database && stats.database.total_items < 1000; // Arbitrary threshold
    
    res.json({
      success: true,
      data: {
        healthy: isHealthy,
        stats,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('DLQ health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
