/**
 * PII Scrubbing Worker
 * 
 * Background worker that automatically scrubs PII for inactive users
 * based on retention policies (default: 3 years of inactivity).
 * 
 * Runs as a cron job to ensure compliance with GDPR/CCPA requirements.
 */

const PIIScrubbingService = require('../services/piiScrubbingService');
const logger = require('../utils/logger');
const Database = require('better-sqlite3');

class PIIScrubbingWorker {
  constructor({ databasePath, redisClient, webhookService, auditLogService } = {}) {
    this.databasePath = databasePath || process.env.DATABASE_FILENAME || './data/substream.db';
    this.redisClient = redisClient;
    this.webhookService = webhookService;
    this.auditLogService = auditLogService;
    this.database = null;
    this.piiService = null;
  }

  /**
   * Initialize the worker
   */
  initialize() {
    try {
      this.database = new Database(this.databasePath);
      
      this.piiService = new PIIScrubbingService({
        database: { db: this.database },
        redisClient: this.redisClient,
        webhookService: this.webhookService,
        auditLogService: this.auditLogService
      });

      logger.info('[PIIScrubbingWorker] Worker initialized', {
        databasePath: this.databasePath
      });
    } catch (error) {
      logger.error('[PIIScrubbingWorker] Initialization failed', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Run the scrubbing job
   * @param {object} options - Job options
   * @param {number} options.years - Years of inactivity threshold
   * @param {boolean} options.dryRun - If true, only count without scrubbing
   * @returns {object} Job result
   */
  async run(options = {}) {
    const { years = 3, dryRun = false } = options;

    if (!this.piiService) {
      this.initialize();
    }

    const jobId = require('crypto').randomUUID();
    const startTime = Date.now();

    logger.info('[PIIScrubbingWorker] Starting scrubbing job', {
      jobId,
      years,
      dryRun
    });

    try {
      let result;

      if (dryRun) {
        // Dry run - just count inactive users
        const inactiveUsers = this.piiService.findInactiveUsers(years);
        
        result = {
          jobId,
          dryRun: true,
          years,
          totalUsers: inactiveUsers.length,
          duration: Date.now() - startTime,
          message: 'Dry run completed. No data was scrubbed.'
        };

        logger.info('[PIIScrubbingWorker] Dry run completed', result);
      } else {
        // Actual scrubbing
        result = await this.piiService.scrubInactiveUsers(years);
        result.jobId = jobId;
        result.years = years;
        result.duration = Date.now() - startTime;

        logger.info('[PIIScrubbingWorker] Scrubbing job completed', result);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('[PIIScrubbingWorker] Scrubbing job failed', {
        jobId,
        years,
        duration,
        error: error.message,
        stack: error.stack
      });

      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.database) {
      this.database.close();
      logger.info('[PIIScrubbingWorker] Database connection closed');
    }
  }
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    years: parseInt(args[0]) || 3,
    dryRun: args.includes('--dry-run')
  };

  const worker = new PIIScrubbingWorker();

  worker.run(options)
    .then((result) => {
      console.log('Job completed successfully:', JSON.stringify(result, null, 2));
      worker.cleanup();
      process.exit(0);
    })
    .catch((error) => {
      console.error('Job failed:', error.message);
      worker.cleanup();
      process.exit(1);
    });
}

module.exports = PIIScrubbingWorker;
