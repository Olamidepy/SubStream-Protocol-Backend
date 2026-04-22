const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

/**
 * Email Queue Service using BullMQ
 * Handles asynchronous email processing with retry logic and rate limiting
 */
class EmailQueueService {
  constructor(config = {}) {
    this.config = config;
    this.redisConfig = config.redis || {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB) || 0,
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true
    };
    
    this.queueName = config.queueName || 'email-queue';
    this.defaultJobOptions = {
      removeOnComplete: 100, // Keep last 100 completed jobs
      removeOnFail: 50,      // Keep last 50 failed jobs
      attempts: 3,           // Default retry attempts
      backoff: {
        type: 'exponential',
        delay: 2000          // Start with 2 seconds
      },
      delay: 0
    };
    
    this.queue = null;
    this.worker = null;
    this.emailProvider = null;
    this.processors = new Map();
    
    this.initialize();
  }

  /**
   * Initialize Redis connection and queue
   */
  initialize() {
    try {
      // Create Redis connection
      this.redis = new Redis(this.redisConfig);
      
      // Create queue
      this.queue = new Queue(this.queueName, {
        connection: this.redis,
        defaultJobOptions: this.defaultJobOptions
      });
      
      console.log(`Email queue initialized: ${this.queueName}`);
      
      // Set up error handlers
      this.queue.on('error', (error) => {
        console.error('Email queue error:', error);
      });
      
      this.queue.on('waiting', (job) => {
        console.log(`Email job waiting: ${job.id}`);
      });
      
      this.queue.on('active', (job) => {
        console.log(`Email job active: ${job.id}`);
      });
      
      this.queue.on('completed', (job) => {
        console.log(`Email job completed: ${job.id}`);
      });
      
      this.queue.on('failed', (job, error) => {
        console.error(`Email job failed: ${job.id}`, error);
      });
      
      this.queue.on('stalled', (job) => {
        console.warn(`Email job stalled: ${job.id}`);
      });
      
    } catch (error) {
      console.error('Failed to initialize email queue:', error);
      throw error;
    }
  }

  /**
   * Set email provider for processing
   * @param {BaseEmailProvider} provider - Email provider instance
   */
  setEmailProvider(provider) {
    this.emailProvider = provider;
    
    if (this.worker) {
      this.worker.close();
    }
    
    this.setupWorker();
  }

  /**
   * Setup worker to process email jobs
   */
  setupWorker() {
    if (!this.emailProvider) {
      throw new Error('Email provider must be set before setting up worker');
    }

    try {
      this.worker = new Worker(
        this.queueName,
        async (job) => {
          return this.processEmailJob(job);
        },
        {
          connection: this.redis,
          concurrency: this.config.concurrency || 5,
          limiter: {
            max: this.config.rateLimitMax || 100,
            duration: this.config.rateLimitDuration || 60000, // 1 minute
          }
        }
      );

      // Set up worker error handlers
      this.worker.on('error', (error) => {
        console.error('Email worker error:', error);
      });

      this.worker.on('completed', (job) => {
        console.log(`Email worker completed job: ${job.id}`);
      });

      this.worker.on('failed', (job, error) => {
        console.error(`Email worker failed job: ${job.id}`, error);
      });

      console.log('Email worker setup completed');
      
    } catch (error) {
      console.error('Failed to setup email worker:', error);
      throw error;
    }
  }

  /**
   * Process individual email job
   * @param {Object} job - BullMQ job object
   * @returns {Promise<Object>} Processing result
   */
  async processEmailJob(job) {
    const { type, data } = job.data;
    
    try {
      switch (type) {
        case 'sendEmail':
          return await this.processSendEmail(job);
        case 'sendSimpleEmail':
          return await this.processSendSimpleEmail(job);
        case 'sendBulkEmail':
          return await this.processSendBulkEmail(job);
        default:
          throw new Error(`Unknown job type: ${type}`);
      }
    } catch (error) {
      console.error(`Failed to process email job ${job.id}:`, error);
      
      // Check if this is a rate limit error
      if (this.emailProvider.isRateLimitError(error)) {
        const retryAfter = this.emailProvider.getRetryAfter(error);
        console.log(`Rate limit detected, retrying after ${retryAfter} seconds`);
        
        // Update job options for rate limit retry
        job.opts.backoff = {
          type: 'fixed',
          delay: retryAfter * 1000 // Convert to milliseconds
        };
        
        throw error; // Re-throw to trigger retry
      }
      
      throw error;
    }
  }

  /**
   * Process sendEmail job
   * @param {Object} job - BullMQ job object
   * @returns {Promise<Object>} Send result
   */
  async processSendEmail(job) {
    const { to, from, subject, templateId, templateData, options } = job.data.data;
    
    const result = await this.emailProvider.sendEmail({
      to,
      from,
      subject,
      templateId,
      templateData,
      options
    });
    
    return {
      success: true,
      messageId: result.messageId,
      provider: result.provider,
      processedAt: new Date().toISOString()
    };
  }

  /**
   * Process sendSimpleEmail job
   * @param {Object} job - BullMQ job object
   * @returns {Promise<Object>} Send result
   */
  async processSendSimpleEmail(job) {
    const { to, from, subject, text, html, options } = job.data.data;
    
    const result = await this.emailProvider.sendSimpleEmail({
      to,
      from,
      subject,
      text,
      html,
      options
    });
    
    return {
      success: true,
      messageId: result.messageId,
      provider: result.provider,
      processedAt: new Date().toISOString()
    };
  }

  /**
   * Process sendBulkEmail job
   * @param {Object} job - BullMQ job object
   * @returns {Promise<Object>} Bulk send result
   */
  async processSendBulkEmail(job) {
    const { recipients, from, subject, templateId, templateData, options } = job.data.data;
    
    const results = [];
    const errors = [];
    
    for (const recipient of recipients) {
      try {
        const result = await this.emailProvider.sendEmail({
          to: recipient.email,
          from,
          subject,
          templateId,
          templateData: {
            ...templateData,
            ...recipient.templateData
          },
          options
        });
        
        results.push({
          email: recipient.email,
          success: true,
          messageId: result.messageId
        });
        
      } catch (error) {
        errors.push({
          email: recipient.email,
          error: error.message,
          success: false
        });
      }
    }
    
    return {
      success: true,
      results,
      errors,
      totalRecipients: recipients.length,
      successfulSends: results.length,
      failedSends: errors.length,
      processedAt: new Date().toISOString()
    };
  }

  /**
   * Add email job to queue
   * @param {Object} emailData - Email data
   * @param {Object} options - Job options
   * @returns {Promise<Object>} Job result
   */
  async addEmailJob(emailData, options = {}) {
    try {
      const jobData = {
        type: 'sendEmail',
        data: emailData
      };

      const jobOptions = {
        ...this.defaultJobOptions,
        ...options,
        // Custom retry logic for rate limits
        backoff: {
          type: 'exponential',
          delay: options.initialDelay || 2000
        }
      };

      const job = await this.queue.add('send-email', jobData, jobOptions);
      
      return {
        success: true,
        jobId: job.id,
        queue: this.queueName,
        addedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to add email job:', error);
      throw error;
    }
  }

  /**
   * Add simple email job to queue
   * @param {Object} emailData - Email data
   * @param {Object} options - Job options
   * @returns {Promise<Object>} Job result
   */
  async addSimpleEmailJob(emailData, options = {}) {
    try {
      const jobData = {
        type: 'sendSimpleEmail',
        data: emailData
      };

      const jobOptions = {
        ...this.defaultJobOptions,
        ...options
      };

      const job = await this.queue.add('send-simple-email', jobData, jobOptions);
      
      return {
        success: true,
        jobId: job.id,
        queue: this.queueName,
        addedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to add simple email job:', error);
      throw error;
    }
  }

  /**
   * Add bulk email job to queue
   * @param {Object} bulkData - Bulk email data
   * @param {Object} options - Job options
   * @returns {Promise<Object>} Job result
   */
  async addBulkEmailJob(bulkData, options = {}) {
    try {
      const jobData = {
        type: 'sendBulkEmail',
        data: bulkData
      };

      const jobOptions = {
        ...this.defaultJobOptions,
        ...options,
        // Bulk jobs may need more time and retries
        attempts: options.attempts || 5,
        backoff: {
          type: 'exponential',
          delay: options.initialDelay || 5000
        }
      };

      const job = await this.queue.add('send-bulk-email', jobData, jobOptions);
      
      return {
        success: true,
        jobId: job.id,
        queue: this.queueName,
        addedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to add bulk email job:', error);
      throw error;
    }
  }

  /**
   * Get job status
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Job status
   */
  async getJobStatus(jobId) {
    try {
      const job = await this.queue.getJob(jobId);
      
      if (!job) {
        return {
          success: false,
          error: 'Job not found'
        };
      }

      const state = await job.getState();
      const progress = job.progress;
      
      return {
        success: true,
        jobId: job.id,
        state,
        progress,
        data: job.data,
        opts: job.opts,
        createdAt: new Date(job.timestamp).toISOString(),
        processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        failedReason: job.failedReason,
        returnvalue: job.returnvalue
      };
      
    } catch (error) {
      console.error('Failed to get job status:', error);
      throw error;
    }
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getQueueStats() {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(),
        this.queue.getFailed(),
        this.queue.getDelayed()
      ]);

      return {
        success: true,
        queueName: this.queueName,
        stats: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length,
          delayed: delayed.length,
          total: waiting.length + active.length + completed.length + failed.length + delayed.length
        },
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      throw error;
    }
  }

  /**
   * Get recent jobs
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Recent jobs
   */
  async getRecentJobs(options = {}) {
    try {
      const { state = 'completed', start = 0, end = 50 } = options;
      
      const jobs = await this.queue.getJobs([state], start, end);
      
      return {
        success: true,
        state,
        jobs: jobs.map(job => ({
          id: job.id,
          state: await job.getState(),
          progress: job.progress,
          data: job.data,
          createdAt: new Date(job.timestamp).toISOString(),
          processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          failedReason: job.failedReason
        })),
        count: jobs.length,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to get recent jobs:', error);
      throw error;
    }
  }

  /**
   * Pause queue processing
   * @returns {Promise<Object>} Pause result
   */
  async pauseQueue() {
    try {
      await this.queue.pause();
      
      return {
        success: true,
        queueName: this.queueName,
        pausedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to pause queue:', error);
      throw error;
    }
  }

  /**
   * Resume queue processing
   * @returns {Promise<Object>} Resume result
   */
  async resumeQueue() {
    try {
      await this.queue.resume();
      
      return {
        success: true,
        queueName: this.queueName,
        resumedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to resume queue:', error);
      throw error;
    }
  }

  /**
   * Clear queue
   * @param {Object} options - Clear options
   * @returns {Promise<Object>} Clear result
   */
  async clearQueue(options = {}) {
    try {
      const { state = 'waiting' } = options;
      
      await this.queue.clean(0, 0, state);
      
      return {
        success: true,
        queueName: this.queueName,
        clearedState: state,
        clearedAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('Failed to clear queue:', error);
      throw error;
    }
  }

  /**
   * Close queue and worker
   */
  async close() {
    try {
      if (this.worker) {
        await this.worker.close();
        this.worker = null;
      }
      
      if (this.queue) {
        await this.queue.close();
        this.queue = null;
      }
      
      if (this.redis) {
        await this.redis.quit();
        this.redis = null;
      }
      
      console.log('Email queue service closed');
      
    } catch (error) {
      console.error('Failed to close email queue service:', error);
      throw error;
    }
  }

  /**
   * Get service health status
   * @returns {Object} Health status
   */
  getHealthStatus() {
    return {
      queueName: this.queueName,
      provider: this.emailProvider ? this.emailProvider.name : 'none',
      redisConnected: this.redis ? this.redis.status === 'ready' : false,
      workerActive: this.worker ? true : false,
      config: {
        concurrency: this.config.concurrency || 5,
        rateLimitMax: this.config.rateLimitMax || 100,
        rateLimitDuration: this.config.rateLimitDuration || 60000
      },
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = EmailQueueService;
