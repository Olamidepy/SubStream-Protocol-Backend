const cron = require('node-cron');
const PreBillingHealthCheck = require('../services/preBillingHealthCheck');

/**
 * Pre-Billing Health Check Worker
 * Runs daily cron job to check subscription health 3 days before billing
 */
class PreBillingHealthWorker {
  constructor(config = {}) {
    this.config = config;
    this.healthCheck = null;
    this.isRunning = false;
    this.lastRun = null;
    this.runHistory = [];
    this.maxHistorySize = 30; // Keep last 30 runs
    
    this.initialize();
  }

  /**
   * Initialize the worker
   */
  initialize() {
    try {
      // Initialize health check service
      this.healthCheck = new PreBillingHealthCheck(this.config);
      
      // Schedule daily run at 2:00 AM UTC
      const cronSchedule = this.config.cronSchedule || '0 2 * * *';
      
      console.log(`Scheduling pre-billing health check with cron: ${cronSchedule}`);
      
      // Schedule the cron job
      this.cronJob = cron.schedule(cronSchedule, async () => {
        await this.runHealthCheck();
      }, {
        scheduled: false,
        timezone: 'UTC'
      });

      // Set up graceful shutdown
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());
      
      console.log('Pre-billing health check worker initialized');
      
    } catch (error) {
      console.error('Failed to initialize pre-billing health check worker:', error);
      throw error;
    }
  }

  /**
   * Start the worker
   */
  start() {
    if (this.cronJob) {
      this.cronJob.start();
      console.log('Pre-billing health check worker started');
      
      // Optional: Run immediately on start for testing
      if (this.config.runOnStart) {
        console.log('Running health check immediately on start...');
        setTimeout(() => this.runHealthCheck(), 5000);
      }
    } else {
      throw new Error('Cron job not initialized');
    }
  }

  /**
   * Stop the worker
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log('Pre-billing health check worker stopped');
    }
  }

  /**
   * Run the health check manually
   * @param {Object} options - Options for the health check
   * @returns {Promise<Object>} Health check results
   */
  async runHealthCheck(options = {}) {
    if (this.isRunning) {
      console.log('Health check is already running, skipping...');
      return {
        skipped: true,
        reason: 'Already running',
        timestamp: new Date().toISOString()
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      console.log('Starting pre-billing health check...');
      
      const results = await this.healthCheck.runDailyHealthCheck(options);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Record the run
      const runRecord = {
        timestamp: new Date().toISOString(),
        duration,
        results,
        success: true
      };
      
      this.recordRun(runRecord);
      
      console.log(`Pre-billing health check completed in ${duration}ms:`, results);
      
      return runRecord;
      
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      console.error('Pre-billing health check failed:', error);
      
      // Record the failed run
      const runRecord = {
        timestamp: new Date().toISOString(),
        duration,
        error: error.message,
        success: false
      };
      
      this.recordRun(runRecord);
      
      throw error;
      
    } finally {
      this.isRunning = false;
      this.lastRun = new Date().toISOString();
    }
  }

  /**
   * Record a run in history
   * @param {Object} runRecord - Run record to store
   */
  recordRun(runRecord) {
    this.runHistory.unshift(runRecord);
    
    // Keep only the most recent runs
    if (this.runHistory.length > this.maxHistorySize) {
      this.runHistory = this.runHistory.slice(0, this.maxHistorySize);
    }
  }

  /**
   * Get worker status
   * @returns {Object} Worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      runHistory: this.runHistory,
      config: {
        cronSchedule: this.config.cronSchedule || '0 2 * * *',
        warningThresholdDays: this.config.warningThresholdDays || 3,
        batchSize: this.config.batchSize || 50
      },
      healthCheckStats: this.healthCheck ? this.healthCheck.getStats() : null
    };
  }

  /**
   * Get upcoming subscriptions that will be checked
   * @param {number} daysAhead - Number of days ahead to check
   * @returns {Array} Array of upcoming subscriptions
   */
  getUpcomingSubscriptions(daysAhead = 3) {
    if (!this.healthCheck) {
      return [];
    }
    
    return this.healthCheck.getSubscriptionsNeedingWarnings(daysAhead);
  }

  /**
   * Test health check for a specific wallet
   * @param {string} walletAddress - Wallet address to test
   * @param {number} requiredAmount - Required amount for payment
   * @returns {Promise<Object>} Test result
   */
  async testWallet(walletAddress, requiredAmount = 0) {
    if (!this.healthCheck) {
      throw new Error('Health check service not initialized');
    }
    
    return this.healthCheck.testHealthCheck(walletAddress, requiredAmount);
  }

  /**
   * Trigger health check for a specific date
   * @param {Date} targetDate - Target date to check
   * @returns {Promise<Object>} Health check results
   */
  async triggerForDate(targetDate) {
    if (!this.healthCheck) {
      throw new Error('Health check service not initialized');
    }
    
    return this.healthCheck.triggerHealthCheckForDate(targetDate);
  }

  /**
   * Get performance metrics
   * @returns {Object} Performance metrics
   */
  getMetrics() {
    const successfulRuns = this.runHistory.filter(run => run.success);
    const failedRuns = this.runHistory.filter(run => !run.success);
    
    const avgDuration = successfulRuns.length > 0 
      ? successfulRuns.reduce((sum, run) => sum + run.duration, 0) / successfulRuns.length 
      : 0;
    
    const totalProcessed = successfulRuns.reduce((sum, run) => sum + (run.results?.processed || 0), 0);
    const totalWarnings = successfulRuns.reduce((sum, run) => sum + (run.results?.warningsSent || 0), 0);
    const totalErrors = failedRuns.length;
    
    return {
      totalRuns: this.runHistory.length,
      successfulRuns: successfulRuns.length,
      failedRuns: failedRuns.length,
      successRate: this.runHistory.length > 0 ? (successfulRuns.length / this.runHistory.length) * 100 : 0,
      avgDuration: Math.round(avgDuration),
      totalProcessed,
      totalWarnings,
      totalErrors,
      lastRun: this.lastRun
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('Shutting down pre-billing health check worker...');
    
    if (this.cronJob) {
      this.cronJob.stop();
    }
    
    // Wait for current run to complete
    if (this.isRunning) {
      console.log('Waiting for current health check to complete...');
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.isRunning) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);
      });
    }
    
    console.log('Pre-billing health check worker shutdown complete');
    process.exit(0);
  }

  /**
   * Health check endpoint for monitoring
   * @returns {Object} Health status
   */
  health() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      worker: {
        isRunning: this.isRunning,
        lastRun: this.lastRun,
        uptime: process.uptime()
      },
      metrics: this.getMetrics(),
      config: {
        cronSchedule: this.config.cronSchedule || '0 2 * * *',
        warningThresholdDays: this.config.warningThresholdDays || 3
      }
    };
  }
}

module.exports = PreBillingHealthWorker;

// If running directly, start the worker
if (require.main === module) {
  const config = {
    database: require('../src/db/appDatabase'), // This would need to be properly initialized
    emailService: require('../services/emailService'), // This would need to be properly initialized
    soroban: {
      rpcUrl: process.env.SOROBAN_RPC_URL,
      networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
      sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
      contractId: process.env.SUBSTREAM_CONTRACT_ID
    },
    cronSchedule: process.env.PRE_BILLING_CRON_SCHEDULE || '0 2 * * *',
    warningThresholdDays: parseInt(process.env.WARNING_THRESHOLD_DAYS) || 3,
    batchSize: parseInt(process.env.BATCH_SIZE) || 50,
    runOnStart: process.env.RUN_ON_START === 'true'
  };

  const worker = new PreBillingHealthWorker(config);
  
  worker.start();
  
  // Set up graceful shutdown
  process.on('SIGINT', () => worker.shutdown());
  process.on('SIGTERM', () => worker.shutdown());
  
  console.log('Pre-billing health check worker started in standalone mode');
}
