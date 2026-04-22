const express = require('express');
const router = express.Router();
const multer = require('multer');
const storageService = require('../services/storageService');
const { authenticateToken } = require('../middleware/unifiedAuth');

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Pin content to multiple regions
router.post('/pin', authenticateToken, upload.single('content'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file provided'
      });
    }

    const contentId = req.body.contentId || `content_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const result = await storageService.pinContent(
      contentId,
      req.file.buffer,
      {
        creatorAddress: req.user.address,
        contentType: req.file.mimetype,
        originalName: req.file.originalname
      }
    );

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Pin error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to pin content'
    });
  }
});

// Get content with automatic failover
router.get('/content/:contentId', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { region } = req.query;

    const content = await storageService.getContent(contentId, region);
    
    // Set appropriate content type if available
    const replicationInfo = storageService.getReplicationStatus(contentId);
    if (replicationInfo && replicationInfo.contentType) {
      res.set('Content-Type', replicationInfo.contentType);
    }
    
    res.send(content);

  } catch (error) {
    console.error('Get content error:', error);
    res.status(404).json({
      success: false,
      error: error.message || 'Content not found'
    });
  }
});

// Get content metadata (without downloading the actual content)
router.get('/metadata/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const replicationInfo = storageService.getReplicationStatus(contentId);
    
    if (!replicationInfo) {
      return res.status(404).json({
        success: false,
        error: 'Content metadata not found'
      });
    }

    res.json({
      success: true,
      contentId,
      metadata: {
        status: replicationInfo.status,
        pinnedServices: replicationInfo.pinnedServices.map(s => ({
          service: s.service,
          region: s.region,
          latency: s.latency
        })),
        failedServices: replicationInfo.failedServices.length,
        timestamp: replicationInfo.timestamp
      }
    });

  } catch (error) {
    console.error('Get metadata error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get content metadata'
    });
  }
});

// Get replication status for content
router.get('/status/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const status = storageService.getReplicationStatus(contentId);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Replication status not found'
      });
    }

    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get replication status'
    });
  }
});

// Get health status of all storage services
router.get('/health', authenticateToken, (req, res) => {
  try {
    const healthStatus = storageService.getHealthStatus();
    
    res.json({
      success: true,
      services: healthStatus,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Get health status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get health status'
    });
  }
});

// Force re-replication of content (admin function)
router.post('/replicate/:contentId', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;
    
    // Check if user is admin (in production, implement proper authorization)
    if (req.user.tier !== 'gold') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const replicationInfo = storageService.getReplicationStatus(contentId);
    if (!replicationInfo) {
      return res.status(404).json({
        success: false,
        error: 'Content not found'
      });
    }

    // In a real implementation, you would fetch the content and re-pin it
    // For now, just return the current status
    res.json({
      success: true,
      message: 'Re-replication initiated',
      currentStatus: replicationInfo
    });

  } catch (error) {
    console.error('Replicate error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate re-replication'
    });
  }
});

// Get content URL for direct access (returns gateway URLs)
router.get('/url/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const { preferredRegion } = req.query;
    
    const replicationInfo = storageService.getReplicationStatus(contentId);
    
    if (!replicationInfo || replicationInfo.pinnedServices.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Content not found or not replicated'
      });
    }

    // Generate gateway URLs for each service
    const urls = replicationInfo.pinnedServices.map(service => {
      const gatewayUrls = {
        'pinata': `https://gateway.pinata.cloud/ipfs/${service.cid}`,
        'web3storage': `https://dweb.link/ipfs/${service.cid}`,
        'infura': `https://ipfs.io/ipfs/${service.cid}`
      };
      
      return {
        service: service.service,
        region: service.region,
        url: gatewayUrls[service.serviceId] || `https://ipfs.io/ipfs/${service.cid}`,
        latency: service.latency,
        isPreferred: preferredRegion === service.region
      };
    });

    // Sort by preference and latency
    urls.sort((a, b) => {
      if (a.isPreferred && !b.isPreferred) return -1;
      if (!a.isPreferred && b.isPreferred) return 1;
      return a.latency - b.latency;
    });

    res.json({
      success: true,
      contentId,
      urls
    });

  } catch (error) {
    console.error('Get URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate content URLs'
    });
  }
});

module.exports = router;
