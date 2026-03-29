const express = require('express');
const router = express.Router();
const GlobalStatsService = require('../src/services/globalStatsService');

/**
 * Create global stats router with injected dependencies.
 * @param {Object} dependencies - Service dependencies
 * @returns {express.Router} Express router
 */
function createGlobalStatsRouter(dependencies = {}) {
  const database = dependencies.database;
  const globalStatsService = dependencies.globalStatsService || new GlobalStatsService(database);

  // Get all global statistics
  router.get('/', async (req, res) => {
    try {
      const stats = await globalStatsService.getGlobalStats();
      
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching global stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve global statistics',
        message: error.message
      });
    }
  });

  // Get Total Value Locked (TVL)
  router.get('/tvl', async (req, res) => {
    try {
      const stats = await globalStatsService.getGlobalStats();
      
      res.json({
        success: true,
        data: {
          totalValueLocked: stats.totalValueLocked,
          lastUpdated: stats.lastUpdated
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching TVL:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve Total Value Locked',
        message: error.message
      });
    }
  });

  // Get trending creators
  router.get('/trending-creators', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const stats = await globalStatsService.getGlobalStats();
      
      const limitedCreators = stats.trendingCreators.slice(0, limit);
      
      res.json({
        success: true,
        data: {
          trendingCreators: limitedCreators,
          totalAvailable: stats.trendingCreators.length,
          lastUpdated: stats.lastUpdated
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching trending creators:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve trending creators',
        message: error.message
      });
    }
  });

  // Get platform overview statistics
  router.get('/overview', async (req, res) => {
    try {
      const stats = await globalStatsService.getGlobalStats();
      
      const overview = {
        totalUsers: stats.totalUsers,
        totalCreators: stats.totalCreators,
        totalVideos: stats.totalVideos,
        totalSubscriptions: stats.totalSubscriptions,
        totalValueLocked: stats.totalValueLocked,
        lastUpdated: stats.lastUpdated
      };
      
      res.json({
        success: true,
        data: overview,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching platform overview:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve platform overview',
        message: error.message
      });
    }
  });

  // Get cache status (for monitoring/debugging)
  router.get('/cache-status', async (req, res) => {
    try {
      const cacheStatus = await globalStatsService.getCacheStatus();
      
      res.json({
        success: true,
        data: cacheStatus,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error fetching cache status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cache status',
        message: error.message
      });
    }
  });

  // Force refresh cache (admin endpoint)
  router.post('/refresh', async (req, res) => {
    try {
      const stats = await globalStatsService.refreshCache();
      
      res.json({
        success: true,
        message: 'Global stats cache refreshed successfully',
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error refreshing cache:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh cache',
        message: error.message
      });
    }
  });

  // Clear cache (admin endpoint)
  router.delete('/cache', async (req, res) => {
    try {
      await globalStatsService.clearCache();
      
      res.json({
        success: true,
        message: 'Global stats cache cleared successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error clearing cache:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear cache',
        message: error.message
      });
    }
  });

  return router;
}

module.exports = createGlobalStatsRouter;
