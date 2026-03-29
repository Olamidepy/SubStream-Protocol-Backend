const express = require('express');
const router = express.Router();
const gdprService = require('../services/gdprService');

// Export user data
router.post('/export', async (req, res) => {
  try {
    const { userAddress } = req.body;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const exportResult = await gdprService.exportUserData(userAddress);
    
    res.json({
      success: true,
      data: exportResult,
      message: 'User data export completed successfully'
    });
  } catch (error) {
    console.error('Error exporting user data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export user data'
    });
  }
});

// Download exported data
router.get('/export/download/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({
        success: false,
        error: 'Filename is required'
      });
    }

    const exportStatus = await gdprService.getExportStatus(filename);
    
    if (!exportStatus) {
      return res.status(404).json({
        success: false,
        error: 'Export file not found'
      });
    }

    const filePath = exportStatus.filePath;
    
    // Check if file has expired
    if (new Date() > new Date(exportStatus.expiresAt)) {
      return res.status(410).json({
        success: false,
        error: 'Export file has expired'
      });
    }

    res.download(filePath, filename, (err) => {
      if (err) {
        console.error('Error downloading file:', err);
        res.status(500).json({
          success: false,
          error: 'Failed to download file'
        });
      }
    });
  } catch (error) {
    console.error('Error downloading exported data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download exported data'
    });
  }
});

// Get export status
router.get('/export/status/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({
        success: false,
        error: 'Filename is required'
      });
    }

    const exportStatus = await gdprService.getExportStatus(filename);
    
    if (!exportStatus) {
      return res.status(404).json({
        success: false,
        error: 'Export file not found'
      });
    }

    res.json({
      success: true,
      data: exportStatus
    });
  } catch (error) {
    console.error('Error getting export status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get export status'
    });
  }
});

// Delete user data
router.post('/delete', async (req, res) => {
  try {
    const { userAddress, confirmation } = req.body;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    // Require explicit confirmation
    if (!confirmation || confirmation !== 'DELETE_MY_DATA') {
      return res.status(400).json({
        success: false,
        error: 'Explicit confirmation required. Send "DELETE_MY_DATA" in the confirmation field.'
      });
    }

    const deletionResult = await gdprService.deleteUserData(userAddress);
    
    res.json({
      success: true,
      data: deletionResult,
      message: 'User data deletion completed successfully'
    });
  } catch (error) {
    console.error('Error deleting user data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete user data'
    });
  }
});

// Get user data summary (before export)
router.get('/summary/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const userData = await gdprService.collectAllUserData(userAddress);
    
    const summary = {
      userAddress,
      dataSummary: {
        profile: userData.profile ? 1 : 0,
        comments: userData.comments ? userData.comments.length : 0,
        content: userData.content ? userData.content.length : 0,
        subscriptions: userData.subscriptions ? userData.subscriptions.length : 0,
        transactions: userData.transactions ? userData.transactions.length : 0,
        badges: userData.badges ? userData.badges.length : 0,
        activityRecords: userData.activity ? userData.activity.length : 0
      },
      estimatedSize: JSON.stringify(userData).length,
      generatedAt: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error getting user data summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user data summary'
    });
  }
});

// Cleanup expired exports (admin endpoint)
router.post('/cleanup-exports', async (req, res) => {
  try {
    const expiredFiles = await gdprService.cleanupExpiredExports();
    
    res.json({
      success: true,
      data: {
        cleanedUpFiles: expiredFiles,
        count: expiredFiles.length
      },
      message: 'Expired exports cleaned up successfully'
    });
  } catch (error) {
    console.error('Error cleaning up expired exports:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clean up expired exports'
    });
  }
});

module.exports = router;
