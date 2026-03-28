const { logger } = require('../utils/logger');

/**
 * Leaderboard Worker - Background processing for engagement leaderboard calculations
 * Automatically recalculates leaderboards every 6 hours and caches results
 */
class LeaderboardWorker {
  constructor(config, database, redisClient, leaderboardService) {
    this.config = config;
    this.database = database;
    this.redis = redisClient;
    this.leaderboardService = leaderboardService;
    this.isRunning = false;
    this.processingInterval = null;
    this.intervalMs = config.leaderboard?.workerInterval || 21600000; // 6 hours
    this.batchSize = config.leaderboard?.batchSize || 10; // Process 10 creators at a time
  }

  /**
   * Start the leaderboard worker
   */
  start() {
    if (this.isRunning) {
      logger.warn('Leaderboard worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting leaderboard worker', { intervalMs: this.intervalMs });

    // Process all leaderboards immediately on start
    this.processAllLeaderboards();

    // Set up recurring processing
    this.processingInterval = setInterval(() => {
      this.processAllLeaderboards();
    }, this.intervalMs);

    logger.info('Leaderboard worker started');
  }

  /**
   * Stop the leaderboard worker
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    logger.info('Leaderboard worker stopped');
  }

  /**
   * Process leaderboards for all creators
   */
  async processAllLeaderboards() {
    if (!this.isRunning) {
      return;
    }

    try {
      logger.info('Starting leaderboard processing cycle');
      
      // Get all active creators
      const creators = await this.getActiveCreators();
      logger.info('Found active creators', { count: creators.length });

      // Process in batches to avoid overwhelming the system
      for (let i = 0; i < creators.length; i += this.batchSize) {
        const batch = creators.slice(i, i + this.batchSize);
        await this.processCreatorBatch(batch);
        
        // Small delay between batches
        if (i + this.batchSize < creators.length) {
          await this.sleep(1000);
        }
      }

      logger.info('Leaderboard processing cycle completed', { 
        totalCreators: creators.length 
      });
    } catch (error) {
      logger.error('Leaderboard processing cycle failed', { 
        error: error.message 
      });
    }
  }

  /**
   * Process a batch of creators
   */
  async processCreatorBatch(creators) {
    const promises = creators.map(creator => 
      this.processCreatorLeaderboards(creator.address).catch(error => {
        logger.error('Failed to process creator leaderboard', {
          error: error.message,
          creatorAddress: creator.address
        });
        return { success: false, creator: creator.address, error: error.message };
      })
    );

    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    logger.debug('Creator batch processed', {
      batchSize: creators.length,
      successful,
      failed
    });
  }

  /**
   * Process leaderboards for a specific creator
   */
  async processCreatorLeaderboards(creatorAddress) {
    try {
      logger.debug('Processing creator leaderboards', { creatorAddress });

      // Get available seasons
      const seasons = await this.leaderboardService.getAvailableSeasons(creatorAddress);
      
      // Process current season and previous season
      const seasonsToProcess = seasons.slice(0, 2); // Current + previous
      
      const results = [];
      for (const season of seasonsToProcess) {
        try {
          const leaderboard = await this.leaderboardService.generateLeaderboard(
            creatorAddress, 
            season, 
            1000 // Generate full leaderboard
          );
          
          results.push({ season, success: true, fanCount: leaderboard.length });
          
          logger.debug('Season leaderboard processed', {
            creatorAddress,
            season,
            fanCount: leaderboard.length
          });
        } catch (error) {
          logger.error('Failed to process season leaderboard', {
            error: error.message,
            creatorAddress,
            season
          });
          results.push({ season, success: false, error: error.message });
        }
      }

      // Update processing metadata
      await this.updateProcessingMetadata(creatorAddress, results);

      return { success: true, creatorAddress, results };
    } catch (error) {
      logger.error('Failed to process creator leaderboards', {
        error: error.message,
        creatorAddress
      });
      throw error;
    }
  }

  /**
   * Get all active creators
   */
  async getActiveCreators() {
    const query = `
      SELECT DISTINCT id as address
      FROM creators c
      WHERE EXISTS (
        SELECT 1 FROM subscriptions s WHERE s.creator_id = c.id AND s.active = 1
      )
      OR EXISTS (
        SELECT 1 FROM streaming_payments sp WHERE sp.creator_address = c.id
      )
      OR EXISTS (
        SELECT 1 FROM comments cm WHERE cm.creator_id = c.id
      )
      ORDER BY address
    `;

    return this.database.db.prepare(query).all();
  }

  /**
   * Update processing metadata
   */
  async updateProcessingMetadata(creatorAddress, results) {
    try {
      const metadata = {
        creatorAddress,
        lastProcessed: new Date().toISOString(),
        results,
        processingTime: Date.now()
      };

      const metadataKey = `leaderboard:metadata:${creatorAddress}`;
      await this.redis.setex(metadataKey, 86400, JSON.stringify(metadata)); // 24 hours TTL

      logger.debug('Processing metadata updated', { creatorAddress });
    } catch (error) {
      logger.error('Failed to update processing metadata', {
        error: error.message,
        creatorAddress
      });
    }
  }

  /**
   * Get processing metadata for a creator
   */
  async getProcessingMetadata(creatorAddress) {
    try {
      const metadataKey = `leaderboard:metadata:${creatorAddress}`;
      const metadata = await this.redis.get(metadataKey);
      return metadata ? JSON.parse(metadata) : null;
    } catch (error) {
      logger.error('Failed to get processing metadata', {
        error: error.message,
        creatorAddress
      });
      return null;
    }
  }

  /**
   * Force recalculation for a specific creator
   */
  async forceRecalculate(creatorAddress, seasons = null) {
    try {
      logger.info('Force recalculating leaderboards', { creatorAddress, seasons });

      // Invalidate existing cache
      if (!seasons) {
        seasons = await this.leaderboardService.getAvailableSeasons(creatorAddress);
      }

      const results = [];
      for (const season of seasons) {
        await this.leaderboardService.invalidateCache(creatorAddress, season);
        const leaderboard = await this.leaderboardService.generateLeaderboard(
          creatorAddress, 
          season, 
          1000
        );
        results.push({ season, fanCount: leaderboard.length });
      }

      await this.updateProcessingMetadata(creatorAddress, results);

      logger.info('Force recalculation completed', { 
        creatorAddress, 
        seasons,
        results 
      });

      return results;
    } catch (error) {
      logger.error('Force recalculation failed', {
        error: error.message,
        creatorAddress,
        seasons
      });
      throw error;
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      nextProcessTime: this.processingInterval ? Date.now() + this.intervalMs : null
    };
  }

  /**
   * Get worker statistics
   */
  async getWorkerStats() {
    try {
      // Get total creators
      const totalCreators = this.database.db.prepare(`
        SELECT COUNT(DISTINCT id) as count FROM creators
      `).get().count;

      // Get active creators
      const activeCreators = (await this.getActiveCreators()).length;

      // Get cache statistics
      const cacheStats = await this.getCacheStats();

      // Get last processing time
      const lastProcessing = await this.getLastProcessingTime();

      return {
        totalCreators,
        activeCreators,
        cacheStats,
        lastProcessing,
        isRunning: this.isRunning,
        intervalMs: this.intervalMs
      };
    } catch (error) {
      logger.error('Failed to get worker stats', { error: error.message });
      return null;
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const keys = await this.redis.keys(`${this.leaderboardService.prefix}*`);
      const leaderboards = keys.filter(key => !key.includes(':metadata:'));
      const metadata = keys.filter(key => key.includes(':metadata:'));

      // Get memory usage
      const info = await this.redis.info('memory');
      const usedMemory = this.parseMemoryInfo(info);

      return {
        totalKeys: keys.length,
        leaderboardKeys: leaderboards.length,
        metadataKeys: metadata.length,
        usedMemoryMB: Math.round(usedMemory / 1024 / 1024)
      };
    } catch (error) {
      logger.error('Failed to get cache stats', { error: error.message });
      return { totalKeys: 0, leaderboardKeys: 0, metadataKeys: 0, usedMemoryMB: 0 };
    }
  }

  /**
   * Parse Redis memory info
   */
  parseMemoryInfo(info) {
    const match = info.match(/used_memory:(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  /**
   * Get last processing time
   */
  async getLastProcessingTime() {
    try {
      const keys = await this.redis.keys(`${this.leaderboardService.prefix}:metadata:*`);
      if (keys.length === 0) return null;

      const metadatas = await Promise.all(
        keys.map(async key => {
          const data = await this.redis.get(key);
          return data ? JSON.parse(data) : null;
        })
      );

      const validMetadatas = metadatas.filter(Boolean);
      if (validMetadatas.length === 0) return null;

      // Find the most recent processing time
      const mostRecent = validMetadatas.reduce((latest, current) => {
        return current.lastProcessed > latest.lastProcessed ? current : latest;
      });

      return mostRecent.lastProcessed;
    } catch (error) {
      logger.error('Failed to get last processing time', { error: error.message });
      return null;
    }
  }

  /**
   * Clean up old cache entries
   */
  async cleanupOldCache(daysToKeep = 30) {
    try {
      const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
      const keys = await this.redis.keys(`${this.leaderboardService.prefix}*`);
      
      let deletedCount = 0;
      for (const key of keys) {
        const ttl = await this.redis.ttl(key);
        if (ttl === -1) { // No expiry set
          await this.redis.expire(key, this.leaderboardService.cacheTTL);
        }
      }

      logger.info('Cache cleanup completed', { 
        keysProcessed: keys.length,
        deletedCount 
      });

      return deletedCount;
    } catch (error) {
      logger.error('Cache cleanup failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Export leaderboard data for a creator
   */
  async exportLeaderboard(creatorAddress, season = null, format = 'json') {
    try {
      const leaderboard = await this.leaderboardService.generateLeaderboard(
        creatorAddress, 
        season, 
        1000
      );

      const exportData = {
        creatorAddress,
        season: season || 'current',
        exportedAt: new Date().toISOString(),
        totalFans: leaderboard.length,
        fans: leaderboard.map(entry => ({
          rank: entry.rank,
          fanAddress: entry.fanAddress,
          score: entry.score,
          metrics: entry.metrics,
          lastUpdated: entry.lastUpdated
        }))
      };

      if (format === 'csv') {
        return this.convertToCSV(exportData);
      }

      return exportData;
    } catch (error) {
      logger.error('Failed to export leaderboard', {
        error: error.message,
        creatorAddress,
        season,
        format
      });
      throw error;
    }
  }

  /**
   * Convert leaderboard data to CSV
   */
  convertToCSV(data) {
    const headers = [
      'Rank', 'Fan Address', 'Score', 'Streaming Amount', 'Transaction Count',
      'Subscription Active', 'Subscription Days', 'Comment Count', 'Like Count', 'Share Count'
    ];

    const rows = data.fans.map(fan => [
      fan.rank,
      fan.fanAddress,
      fan.score,
      fan.metrics.streaming.totalAmount,
      fan.metrics.streaming.transactionCount,
      fan.metrics.subscription.isActive,
      fan.metrics.subscription.longevityDays,
      fan.metrics.engagement.commentCount,
      fan.metrics.engagement.likeCount,
      fan.metrics.engagement.shareCount
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');

    return csvContent;
  }

  /**
   * Sleep utility for delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = LeaderboardWorker;
