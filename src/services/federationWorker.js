const { logger } = require('../utils/logger');

/**
 * Federation Worker - Background processing for ActivityPub federation
 * Handles queued federation jobs and processes them asynchronously
 */
class FederationWorker {
  constructor(config, database, federationService) {
    this.config = config;
    this.database = database;
    this.federationService = federationService;
    this.isRunning = false;
    this.processingInterval = null;
    this.intervalMs = config.activityPub?.workerInterval || 30000; // 30 seconds
  }

  /**
   * Start the federation worker
   */
  start() {
    if (this.isRunning) {
      logger.warn('Federation worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting federation worker', { intervalMs: this.intervalMs });

    // Process queue immediately on start
    this.processQueue();

    // Set up recurring processing
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, this.intervalMs);

    logger.info('Federation worker started');
  }

  /**
   * Stop the federation worker
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

    logger.info('Federation worker stopped');
  }

  /**
   * Process the federation queue
   */
  async processQueue() {
    if (!this.isRunning) {
      return;
    }

    try {
      logger.debug('Processing federation queue');
      await this.federationService.processFederationQueue();
    } catch (error) {
      logger.error('Federation queue processing error', { error: error.message });
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      nextProcessTime: this.processingInterval ? Date.now() + this.intervalMs : null
    };
  }

  /**
   * Process single federation job (for testing/manual processing)
   */
  async processJob(queueId) {
    try {
      const item = this.database.db.prepare(`
        SELECT * FROM federation_queue WHERE id = ?
      `).get(queueId);

      if (!item) {
        throw new Error('Federation queue item not found');
      }

      await this.federationService.processFederationItem(item);
      
      logger.info('Federation job processed', { queueId });
      return true;
    } catch (error) {
      logger.error('Failed to process federation job', { 
        error: error.message, 
        queueId 
      });
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    try {
      const stats = this.database.db.prepare(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
          MIN(created_at) as oldest_created,
          MAX(created_at) as newest_created
        FROM federation_queue
      `).get();

      return stats;
    } catch (error) {
      logger.error('Failed to get queue stats', { error: error.message });
      return null;
    }
  }

  /**
   * Clean up old completed jobs
   */
  async cleanupOldJobs(daysToKeep = 7) {
    try {
      const cutoffDate = new Date(Date.now() - (daysToKeep * 24 * 60 * 60 * 1000));
      
      const result = this.database.db.prepare(`
        DELETE FROM federation_queue 
        WHERE status IN ('completed', 'failed') 
        AND processed_at < ?
      `).run(cutoffDate.toISOString());

      logger.info('Old federation jobs cleaned up', { 
        deleted: result.changes,
        cutoffDate: cutoffDate.toISOString()
      });

      return result.changes;
    } catch (error) {
      logger.error('Failed to cleanup old jobs', { error: error.message });
      throw error;
    }
  }

  /**
   * Retry failed jobs
   */
  async retryFailedJobs(maxRetries = 3) {
    try {
      const result = this.database.db.prepare(`
        UPDATE federation_queue 
        SET status = 'pending', 
            retry_count = 0, 
            error_message = NULL,
            scheduled_at = CURRENT_TIMESTAMP
        WHERE status = 'failed' 
        AND retry_count >= ?
      `).run(maxRetries);

      logger.info('Failed jobs queued for retry', { 
        updated: result.changes,
        maxRetries 
      });

      return result.changes;
    } catch (error) {
      logger.error('Failed to retry failed jobs', { error: error.message });
      throw error;
    }
  }
}

module.exports = FederationWorker;
