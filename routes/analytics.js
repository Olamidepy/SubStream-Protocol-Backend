const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const { authenticateToken } = require('../middleware/auth');

// Record view-time event
router.post('/view-event', authenticateToken, (req, res) => {
  try {
    const { videoId, watchTime, totalDuration } = req.body;
    
    if (!videoId || watchTime === undefined || !totalDuration) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: videoId, watchTime, totalDuration'
      });
    }
    
    analyticsService.recordViewEvent(
      videoId,
      req.user.address,
      parseFloat(watchTime),
      parseFloat(totalDuration)
    );
    
    res.json({
      success: true,
      message: 'View event recorded'
    });
    
  } catch (error) {
    console.error('View event error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Record withdrawal event (typically called by blockchain listener)
router.post('/withdrawal-event', (req, res) => {
  try {
    const { videoId, fromAddress, amount, timestamp } = req.body;
    
    if (!videoId || !fromAddress || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: videoId, fromAddress, amount'
      });
    }
    
    analyticsService.recordWithdrawalEvent(
      videoId,
      fromAddress,
      amount,
      timestamp || Date.now()
    );
    
    res.json({
      success: true,
      message: 'Withdrawal event recorded'
    });
    
  } catch (error) {
    console.error('Withdrawal event error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get heatmap data for a video
router.get('/heatmap/:videoId', authenticateToken, (req, res) => {
  try {
    const { videoId } = req.params;
    const heatmap = analyticsService.getHeatmap(videoId);
    
    res.json({
      success: true,
      videoId,
      heatmap,
      totalDrips: analyticsService.getTotalDrips(videoId)
    });
    
  } catch (error) {
    console.error('Heatmap error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get creator analytics summary
router.get('/creator/:creatorAddress', authenticateToken, (req, res) => {
  try {
    const { creatorAddress } = req.params;
    
    // In production, fetch video IDs from database based on creator address
    // For now, return mock data
    const videoIds = req.query.videoIds ? req.query.videoIds.split(',') : [];
    
    if (videoIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No video IDs provided'
      });
    }
    
    const analytics = analyticsService.getCreatorAnalytics(videoIds);
    
    res.json({
      success: true,
      creatorAddress,
      analytics
    });
    
  } catch (error) {
    console.error('Creator analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get real-time analytics updates (Server-Sent Events)
router.get('/stream/:videoId', authenticateToken, (req, res) => {
  const { videoId } = req.params;
  
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Send initial data
  const heatmap = analyticsService.getHeatmap(videoId);
  res.write(`data: ${JSON.stringify({
    type: 'initial',
    videoId,
    heatmap,
    totalDrips: analyticsService.getTotalDrips(videoId)
  })}\n\n`);
  
  // Listen for updates
  const updateHandler = (data) => {
    if (data.videoId === videoId) {
      res.write(`data: ${JSON.stringify({
        type: 'update',
        ...data
      })}\n\n`);
    }
  };
  
  analyticsService.on('analyticsUpdate', updateHandler);
  
  // Clean up on disconnect
  req.on('close', () => {
    analyticsService.off('analyticsUpdate', updateHandler);
  });
});

module.exports = router;
