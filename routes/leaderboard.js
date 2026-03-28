const express = require('express');
const router = express.Router();
const { authenticateToken, requireCreator } = require('../middleware/auth');
const { logger } = require('../utils/logger');

/**
 * Engagement Leaderboard API Routes
 * Provides endpoints for accessing "Top Fans" leaderboards and analytics
 */

/**
 * Get leaderboard for a creator
 * GET /api/leaderboard/:creatorAddress
 */
router.get('/:creatorAddress', authenticateToken, async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const { 
      season, 
      limit = 50, 
      includeMetrics = false,
      offset = 0 
    } = req.query;

    // Validate parameters
    const limitNum = Math.min(parseInt(limit) || 50, 200); // Max 200 results
    const offsetNum = parseInt(offset) || 0;

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    // Generate leaderboard
    const leaderboard = await leaderboardService.generateLeaderboard(
      creatorAddress, 
      season, 
      limitNum + offsetNum // Get extra for pagination
    );

    // Apply pagination
    const paginatedLeaderboard = leaderboard.slice(offsetNum, offsetNum + limitNum);

    // Remove detailed metrics if not requested
    if (includeMetrics !== 'true') {
      paginatedLeaderboard.forEach(entry => {
        delete entry.metrics;
      });
    }

    // Get pagination metadata
    const hasMore = offsetNum + limitNum < leaderboard.length;
    const totalCount = leaderboard.length;

    res.json({
      success: true,
      data: {
        creatorAddress,
        season: season || 'current',
        leaderboard: paginatedLeaderboard,
        pagination: {
          offset: offsetNum,
          limit: limitNum,
          totalCount,
          hasMore,
          currentPage: Math.floor(offsetNum / limitNum) + 1,
          totalPages: Math.ceil(totalCount / limitNum)
        }
      }
    });

  } catch (error) {
    logger.error('Get leaderboard error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get leaderboard'
    });
  }
});

/**
 * Get fan's rank on a creator's leaderboard
 * GET /api/leaderboard/:creatorAddress/fan/:fanAddress
 */
router.get('/:creatorAddress/fan/:fanAddress', authenticateToken, async (req, res) => {
  try {
    const { creatorAddress, fanAddress } = req.params;
    const { season } = req.query;

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    const fanRank = await leaderboardService.getFanRank(creatorAddress, fanAddress, season);

    if (!fanRank) {
      return res.status(404).json({
        success: false,
        error: 'Fan not found on leaderboard'
      });
    }

    res.json({
      success: true,
      data: {
        creatorAddress,
        fanAddress,
        season: season || 'current',
        rank: fanRank.rank,
        score: fanRank.score,
        metrics: fanRank.metrics,
        lastUpdated: fanRank.lastUpdated
      }
    });

  } catch (error) {
    logger.error('Get fan rank error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress,
      fanAddress: req.params.fanAddress
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get fan rank'
    });
  }
});

/**
 * Get available seasons for a creator
 * GET /api/leaderboard/:creatorAddress/seasons
 */
router.get('/:creatorAddress/seasons', authenticateToken, async (req, res) => {
  try {
    const { creatorAddress } = req.params;

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    const seasons = await leaderboardService.getAvailableSeasons(creatorAddress);

    res.json({
      success: true,
      data: {
        creatorAddress,
        seasons,
        currentSeason: leaderboardService.getCurrentSeason()
      }
    });

  } catch (error) {
    logger.error('Get seasons error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get seasons'
    });
  }
});

/**
 * Get leaderboard statistics
 * GET /api/leaderboard/:creatorAddress/stats
 */
router.get('/:creatorAddress/stats', authenticateToken, async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const { season } = req.query;

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    const stats = await leaderboardService.getLeaderboardStats(creatorAddress, season);

    if (!stats) {
      return res.status(404).json({
        success: false,
        error: 'No leaderboard data available'
      });
    }

    res.json({
      success: true,
      data: {
        creatorAddress,
        season: season || 'current',
        ...stats
      }
    });

  } catch (error) {
    logger.error('Get leaderboard stats error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get leaderboard statistics'
    });
  }
});

/**
 * Force recalculation of leaderboard (creator only)
 * POST /api/leaderboard/:creatorAddress/recalculate
 */
router.post('/:creatorAddress/recalculate', authenticateToken, requireCreator, async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const { seasons } = req.body;

    const leaderboardWorker = req.app.get('leaderboardWorker');
    if (!leaderboardWorker) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard worker not available'
      });
    }

    // Verify creator is requesting their own leaderboard
    if (req.user.address !== creatorAddress) {
      return res.status(403).json({
        success: false,
        error: 'Can only recalculate your own leaderboard'
      });
    }

    const results = await leaderboardWorker.forceRecalculate(creatorAddress, seasons);

    res.json({
      success: true,
      data: {
        creatorAddress,
        recalculatedAt: new Date().toISOString(),
        results
      }
    });

  } catch (error) {
    logger.error('Recalculate leaderboard error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to recalculate leaderboard'
    });
  }
});

/**
 * Export leaderboard data (creator only)
 * GET /api/leaderboard/:creatorAddress/export
 */
router.get('/:creatorAddress/export', authenticateToken, requireCreator, async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const { season, format = 'json' } = req.query;

    // Verify creator is requesting their own data
    if (req.user.address !== creatorAddress) {
      return res.status(403).json({
        success: false,
        error: 'Can only export your own leaderboard'
      });
    }

    const leaderboardWorker = req.app.get('leaderboardWorker');
    if (!leaderboardWorker) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard worker not available'
      });
    }

    const exportData = await leaderboardWorker.exportLeaderboard(
      creatorAddress, 
      season, 
      format
    );

    // Set appropriate headers
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `leaderboard-${creatorAddress.slice(0, 8)}-${season || 'current'}-${timestamp}`;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(exportData);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.json(exportData);
    }

  } catch (error) {
    logger.error('Export leaderboard error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to export leaderboard'
    });
  }
});

/**
 * Get leaderboard worker status (admin only)
 * GET /api/leaderboard/worker/status
 */
router.get('/worker/status', authenticateToken, async (req, res) => {
  try {
    // This should be restricted to admins in production
    const leaderboardWorker = req.app.get('leaderboardWorker');
    if (!leaderboardWorker) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard worker not available'
      });
    }

    const status = leaderboardWorker.getStatus();
    const stats = await leaderboardWorker.getWorkerStats();

    res.json({
      success: true,
      data: {
        ...status,
        ...stats
      }
    });

  } catch (error) {
    logger.error('Get worker status error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get worker status'
    });
  }
});

/**
 * Force recalculation for all creators (admin only)
 * POST /api/leaderboard/worker/recalculate-all
 */
router.post('/worker/recalculate-all', authenticateToken, async (req, res) => {
  try {
    // This should be restricted to admins in production
    const leaderboardWorker = req.app.get('leaderboardWorker');
    if (!leaderboardWorker) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard worker not available'
      });
    }

    // Trigger full processing cycle
    await leaderboardWorker.processAllLeaderboards();

    res.json({
      success: true,
      data: {
        message: 'All leaderboards queued for recalculation',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Recalculate all leaderboards error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to recalculate all leaderboards'
    });
  }
});

/**
 * Clean up old cache entries (admin only)
 * POST /api/leaderboard/worker/cleanup
 */
router.post('/worker/cleanup', authenticateToken, async (req, res) => {
  try {
    // This should be restricted to admins in production
    const { daysToKeep = 30 } = req.body;

    const leaderboardWorker = req.app.get('leaderboardWorker');
    if (!leaderboardWorker) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard worker not available'
      });
    }

    const deletedCount = await leaderboardWorker.cleanupOldCache(daysToKeep);

    res.json({
      success: true,
      data: {
        deletedCount,
        daysToKeep,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Cache cleanup error', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup cache'
    });
  }
});

/**
 * Get user's rankings across all creators they follow
 * GET /api/leaderboard/user/rankings
 */
router.get('/user/rankings', authenticateToken, async (req, res) => {
  try {
    const userAddress = req.user.address;
    const { season, limit = 20 } = req.query;

    const database = req.database;
    
    // Get all creators the user follows/subscribes to
    const query = `
      SELECT DISTINCT creator_id as creatorAddress
      FROM subscriptions 
      WHERE wallet_address = ? AND active = 1
      LIMIT ?
    `;

    const creators = database.db.prepare(query).all(userAddress, parseInt(limit) || 20);

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    // Get user's rank on each creator's leaderboard
    const rankings = [];
    for (const creator of creators) {
      try {
        const rank = await leaderboardService.getFanRank(
          creator.creatorAddress, 
          userAddress, 
          season
        );
        
        if (rank) {
          rankings.push({
            creatorAddress: creator.creatorAddress,
            rank: rank.rank,
            score: rank.score,
            metrics: rank.metrics
          });
        }
      } catch (error) {
        // Skip creators where leaderboard isn't available
        logger.debug('Failed to get user rank for creator', {
          creatorAddress: creator.creatorAddress,
          error: error.message
        });
      }
    }

    // Sort by rank (best first)
    rankings.sort((a, b) => a.rank - b.rank);

    res.json({
      success: true,
      data: {
        userAddress,
        season: season || 'current',
        rankings,
        totalCreators: creators.length,
        rankedCreators: rankings.length
      }
    });

  } catch (error) {
    logger.error('Get user rankings error', { 
      error: error.message, 
      userAddress: req.user.address 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get user rankings'
    });
  }
});

/**
 * Get leaderboard trends/changes over time
 * GET /api/leaderboard/:creatorAddress/trends
 */
router.get('/:creatorAddress/trends', authenticateToken, async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const { seasons = 3 } = req.query; // Number of recent seasons to compare

    const leaderboardService = req.app.get('leaderboardService');
    if (!leaderboardService) {
      return res.status(503).json({
        success: false,
        error: 'Leaderboard service not available'
      });
    }

    const availableSeasons = await leaderboardService.getAvailableSeasons(creatorAddress);
    const recentSeasons = availableSeasons.slice(0, parseInt(seasons) || 3);

    const trends = [];
    for (const season of recentSeasons) {
      try {
        const stats = await leaderboardService.getLeaderboardStats(creatorAddress, season);
        if (stats) {
          trends.push({
            season,
            ...stats
          });
        }
      } catch (error) {
        logger.debug('Failed to get season stats for trends', {
          season,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      data: {
        creatorAddress,
        trends,
        seasonsAnalyzed: recentSeasons.length
      }
    });

  } catch (error) {
    logger.error('Get leaderboard trends error', { 
      error: error.message, 
      creatorAddress: req.params.creatorAddress 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get leaderboard trends'
    });
  }
});

module.exports = router;
