const GlobalStatsService = require('./globalStatsService');

/**
 * Background worker that refreshes global stats cache every 60 seconds.
 * Runs independently to prevent blocking the main application.
 */
class GlobalStatsWorker {
  constructor(database, options = {}) {
    this.database = database;
    this.globalStatsService = new GlobalStatsService(database);
    this.refreshInterval = options.refreshInterval || 60000; // 60 seconds
    this.initialDelay = options.initialDelay || 5000; // 5 seconds initial delay
    this.isRunning = false;
    this.intervalId = null;
    this.errorCount = 0;
    this.maxErrors = options.maxErrors || 5;
    this.errorBackoffMultiplier = options.errorBackoffMultiplier || 2;
    this.currentInterval = this.refreshInterval;
  }

  /**
   * Start the background worker.
   */
  start() {
    if (this.isRunning) {
      console.log('GlobalStatsWorker is already running');
      return;
    }

    this.isRunning = true;
    this.errorCount = 0;
    this.currentInterval = this.refreshInterval;

    console.log(`Starting GlobalStatsWorker with ${this.initialDelay}ms initial delay and ${this.refreshInterval}ms refresh interval`);

    // Initial refresh after a short delay
    setTimeout(() => {
      this.refreshCache();
      
      // Set up recurring refresh
      this.intervalId = setInterval(() => {
        this.refreshCache();
      }, this.currentInterval);
    }, this.initialDelay);
  }

  /**
   * Stop the background worker.
   */
  stop() {
    if (!this.isRunning) {
      console.log('GlobalStatsWorker is not running');
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('GlobalStatsWorker stopped');
  }

  /**
   * Refresh the cache with error handling and backoff logic.
   */
  async refreshCache() {
    if (!this.isRunning) {
      return;
    }

    try {
      const startTime = Date.now();
      const stats = await this.globalStatsService.refreshCache();
      const duration = Date.now() - startTime;

      console.log(`Global stats cache refreshed successfully in ${duration}ms`);
      console.log('Stats summary:', {
        totalCreators: stats.totalCreators,
        totalUsers: stats.totalUsers,
        totalVideos: stats.totalVideos,
        totalSubscriptions: stats.totalSubscriptions,
        trendingCreatorsCount: stats.trendingCreators.length
      });

      // Reset error count and interval on success
      this.errorCount = 0;
      if (this.currentInterval !== this.refreshInterval) {
        this.currentInterval = this.refreshInterval;
        this.resetInterval();
      }

    } catch (error) {
      this.errorCount++;
      console.error(`Error refreshing global stats cache (attempt ${this.errorCount}/${this.maxErrors}):`, error);

      // Implement exponential backoff for consecutive errors
      if (this.errorCount >= this.maxErrors) {
        console.error(`Max errors (${this.maxErrors}) reached. Stopping GlobalStatsWorker`);
        this.stop();
        return;
      }

      // Increase interval for next refresh
      this.currentInterval = Math.min(
        this.currentInterval * this.errorBackoffMultiplier,
        300000 // Max 5 minutes
      );
      
      console.log(`Increasing refresh interval to ${this.currentInterval}ms due to errors`);
      this.resetInterval();
    }
  }

  /**
   * Reset the interval with current timing.
   */
  resetInterval() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    if (this.isRunning) {
      this.intervalId = setInterval(() => {
        this.refreshCache();
      }, this.currentInterval);
    }
  }

  /**
   * Get worker status and statistics.
   * @returns {Object} Worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      refreshInterval: this.refreshInterval,
      currentInterval: this.currentInterval,
      errorCount: this.errorCount,
      maxErrors: this.maxErrors,
      nextRefreshIn: this.isRunning && this.intervalId ? this.currentInterval : null
    };
  }

  /**
   * Force an immediate cache refresh.
   * @returns {Promise<Object>} Fresh statistics
   */
  async forceRefresh() {
    console.log('Force refreshing global stats cache...');
    return await this.refreshCache();
  }

  /**
   * Reset error count and restore normal interval.
   */
  resetErrors() {
    this.errorCount = 0;
    this.currentInterval = this.refreshInterval;
    if (this.isRunning) {
      this.resetInterval();
    }
    console.log('GlobalStatsWorker errors reset');
  }
}

module.exports = GlobalStatsWorker;
