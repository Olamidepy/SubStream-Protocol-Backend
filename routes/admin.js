const express = require('express');
const router = express.Router();
const cronService = require('../services/cronService');

// Get cron job status
router.get('/cron/status', async (req, res) => {
  try {
    const status = cronService.getJobStatus();
    
    res.json({
      success: true,
      data: {
        jobs: status,
        totalJobs: Object.keys(status).length
      }
    });
  } catch (error) {
    console.error('Error getting cron job status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cron job status'
    });
  }
});

// Execute cron job manually
router.post('/cron/execute/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    
    if (!jobName) {
      return res.status(400).json({
        success: false,
        error: 'Job name is required'
      });
    }

    await cronService.executeJob(jobName);
    
    res.json({
      success: true,
      message: `Job '${jobName}' executed successfully`
    });
  } catch (error) {
    console.error('Error executing cron job:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to execute cron job'
    });
  }
});

// Stop cron job
router.post('/cron/stop/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    
    if (!jobName) {
      return res.status(400).json({
        success: false,
        error: 'Job name is required'
      });
    }

    const stopped = cronService.stopJob(jobName);
    
    if (stopped) {
      res.json({
        success: true,
        message: `Job '${jobName}' stopped successfully`
      });
    } else {
      res.status(404).json({
        success: false,
        error: `Job '${jobName}' not found`
      });
    }
  } catch (error) {
    console.error('Error stopping cron job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop cron job'
    });
  }
});

// Stop all cron jobs
router.post('/cron/stop-all', async (req, res) => {
  try {
    cronService.stopAllJobs();
    
    res.json({
      success: true,
      message: 'All cron jobs stopped successfully'
    });
  } catch (error) {
    console.error('Error stopping all cron jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop all cron jobs'
    });
  }
});

module.exports = router;
