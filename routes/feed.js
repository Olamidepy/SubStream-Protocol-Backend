const express = require('express');
const router = express.Router();
const feedService = require('../services/feedService');

// Get secret feed URL for authenticated user
router.post('/secret-url', async (req, res) => {
  try {
    const { userAddress, contentType = 'podcast', format = 'rss' } = req.body;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const token = feedService.generateAccessToken(userAddress);
    const feedUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/feed/${userAddress}/${token}?format=${format}&type=${contentType}`;
    
    res.json({
      success: true,
      data: {
        feedUrl,
        token,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    console.error('Error generating secret feed URL:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate feed URL'
    });
  }
});

// Serve RSS/Atom feed
router.get('/:userAddress/:token', async (req, res) => {
  try {
    const { userAddress, token } = req.params;
    const { format = 'rss', type = 'podcast' } = req.query;
    
    if (!feedService.validateAccessToken(userAddress, token)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    let feedXml;
    if (format === 'atom') {
      feedXml = await feedService.generateAtomFeed(userAddress, type);
      res.set('Content-Type', 'application/atom+xml');
    } else {
      feedXml = await feedService.generateRSSFeed(userAddress, type);
      res.set('Content-Type', 'application/rss+xml');
    }
    
    res.send(feedXml);
  } catch (error) {
    console.error('Error generating feed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate feed'
    });
  }
});

// Rotate access token
router.post('/rotate-token', async (req, res) => {
  try {
    const { userAddress } = req.body;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const newToken = feedService.rotateToken(userAddress);
    
    res.json({
      success: true,
      data: {
        token: newToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    console.error('Error rotating token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to rotate token'
    });
  }
});

// Validate access token
router.post('/validate-token', async (req, res) => {
  try {
    const { userAddress, token } = req.body;
    
    if (!userAddress || !token) {
      return res.status(400).json({
        success: false,
        error: 'User address and token are required'
      });
    }

    const isValid = feedService.validateAccessToken(userAddress, token);
    
    res.json({
      success: true,
      data: {
        valid: isValid
      }
    });
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate token'
    });
  }
});

module.exports = router;
