const { Queue, Worker } = require('bullmq');
const { AppDatabase } = require('../db/appDatabase');
const { SlackAlertService } = require('./slackAlertService');
const winston = require('winston');

/**
 * Soroban Dead-Letter Queue Service
 * Handles failed events with retry logic and alerting
 */
class SorobanDeadLetterQueue {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.logger = dependencies.logger || winston.createLogger({
      level: config.logLevel || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
    
    this.database = dependencies.database || new AppDatabase(config.database);
    this.alertService = dependencies.alertService || new SlackAlertService(config, this.logger);
    this.indexer = dependencies.indexer || null; // Reference to indexer for reprocessing
    
    // BullMQ configuration
    this.redisConfig = config.redis || {
      host: 'localhost',
      port: 6379
    };
    
    // Queue names
    this.dlqQueueName = 'soroban-dlq';
    this.retryQueueName = 'soroban-retry';
    
    // Initialize queues
    this.dlqQueue = null;
    this.retryQueue = null;
    this.retryWorker = null;
    
    // Configuration
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 5000; // 5 seconds
    this.retentionDays = config.retentionDays || 14;
    
    // Statistics
    this.stats = {
      itemsAdded: 0,
      itemsRetried: 0,
      itemsResolved: 0,
      itemsExpired: 0,
      alertsSent: 0,
      startTime: new Date().toISOString()
    };
  }

  /**
   * Initialize the DLQ service
   */
  async initialize() {
    try {
      this.logger.info('Initializing Soroban Dead-Letter Queue...');
      
      // Initialize BullMQ queues
      this.dlqQueue = new Queue(this.dlqQueueName, {
        connection: this.redisConfig,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 1,
          backoff: {
            type: 'fixed',
            delay: this.retryDelay
          }
        }
      });
      
      this.retryQueue = new Queue(this.retryQueueName, {
        connection: this.redisConfig,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: this.maxRetries,
          backoff: {
            type: 'exponential',
            delay: this.retryDelay
          }
        }
      });
      
      // Initialize retry worker
      this.retryWorker = new Worker(
        this.retryQueueName,
        this.processRetryJob.bind(this),
        {
          connection: this.redisConfig,
          concurrency: 3 // Process up to 3 retries concurrently
        }
      );
      
      // Setup worker event handlers
      this.setupWorkerEvents();
      
      // Start cleanup job
      this.startCleanupJob();
      
      this.logger.info('Soroban Dead-Letter Queue initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize DLQ service', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Add a failed event to the DLQ
   */
  async addFailedEvent(eventData, error, attemptCount = 1) {
    try {
      // Determine error category
      const errorCategory = this.categorizeError(error);
      
      // Create DLQ item
      const dlqItem = {
        id: this.generateDlqId(),
        contractId: eventData.contractId,
        transactionHash: eventData.transactionHash,
        eventIndex: eventData.eventIndex || 0,
        ledgerSequence: eventData.ledgerSequence,
        rawEventPayload: eventData,
        rawXdr: eventData.rawXdr,
        eventType: eventData.type || 'Unknown',
        errorMessage: error.message,
        errorStackTrace: error.stack,
        errorCategory,
        originalAttemptCount: attemptCount,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (this.retentionDays * 24 * 60 * 60 * 1000)).toISOString()
      };
      
      // Store in database
      const dbId = await this.storeDlqItem(dlqItem);
      dlqItem.dbId = dbId;
      
      // Add to BullMQ queue for potential retry
      const job = await this.dlqQueue.add('failed-event', dlqItem, {
        delay: 0, // Process immediately
        priority: this.getPriority(errorCategory)
      });
      
      // Update statistics
      this.stats.itemsAdded++;
      
      // Send alert if this is the first time this event fails
      if (attemptCount >= this.maxRetries) {
        await this.sendAlert(dlqItem, error);
      }
      
      this.logger.warn('Event added to Dead-Letter Queue', {
        dlqId: dlqItem.id,
        transactionHash: eventData.transactionHash,
        eventIndex: eventData.eventIndex,
        errorCategory,
        attemptCount,
        jobId: job.id
      });
      
      return {
        success: true,
        dlqId: dlqItem.id,
        dbId,
        jobId: job.id,
        willRetry: attemptCount < this.maxRetries
      };
      
    } catch (queueError) {
      this.logger.error('Failed to add event to DLQ', {
        error: queueError.message,
        transactionHash: eventData.transactionHash,
        originalError: error.message
      });
      
      // Even if queue fails, try to store in database
      try {
        const dlqItem = {
          id: this.generateDlqId(),
          contractId: eventData.contractId,
          transactionHash: eventData.transactionHash,
          eventIndex: eventData.eventIndex || 0,
          ledgerSequence: eventData.ledgerSequence,
          rawEventPayload: eventData,
          rawXdr: eventData.rawXdr,
          eventType: eventData.type || 'Unknown',
          errorMessage: error.message,
          errorStackTrace: error.stack,
          errorCategory: this.categorizeError(error),
          originalAttemptCount: attemptCount,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + (this.retentionDays * 24 * 60 * 60 * 1000)).toISOString()
        };
        
        const dbId = await this.storeDlqItem(dlqItem);
        
        return {
          success: false,
          dlqId: dlqItem.id,
          dbId,
          queueError: queueError.message
        };
      } catch (dbError) {
        this.logger.error('Critical: Failed to store DLQ item in database', {
          error: dbError.message,
          transactionHash: eventData.transactionHash
        });
        
        throw new Error(`Failed to add event to DLQ: Queue error (${queueError.message}) and Database error (${dbError.message})`);
      }
    }
  }

  /**
   * Store DLQ item in database
   */
  async storeDlqItem(dlqItem) {
    try {
      const stmt = this.database.db.prepare(`
        INSERT INTO soroban_dlq_items (
          id, contract_id, transaction_hash, event_index, ledger_sequence,
          raw_event_payload, raw_xdr, event_type, error_message, error_stack_trace,
          error_category, original_attempt_count, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        dlqItem.id,
        dlqItem.contractId,
        dlqItem.transactionHash,
        dlqItem.eventIndex,
        dlqItem.ledgerSequence,
        JSON.stringify(dlqItem.rawEventPayload),
        dlqItem.rawXdr,
        dlqItem.eventType,
        dlqItem.errorMessage,
        dlqItem.errorStackTrace,
        dlqItem.errorCategory,
        dlqItem.originalAttemptCount,
        dlqItem.expiresAt
      );
      
      return dlqItem.id;
    } catch (error) {
      this.logger.error('Failed to store DLQ item in database', {
        error: error.message,
        dlqId: dlqItem.id
      });
      throw error;
    }
  }

  /**
   * Process retry job from BullMQ
   */
  async processRetryJob(job) {
    const { data } = job;
    const startTime = Date.now();
    
    try {
      this.logger.info('Processing DLQ retry job', {
        dlqId: data.id,
        jobId: job.id,
        attempt: job.attemptsMade + 1
      });
      
      // Record retry attempt
      await this.recordRetryAttempt(data.id, job.attemptsMade + 1, 'system');
      
      // Attempt to reprocess the event
      const result = await this.reprocessEvent(data);
      
      const executionTime = Date.now() - startTime;
      
      if (result.success) {
        // Mark as resolved
        await this.markAsResolved(data.id, 'system', 'Successfully reprocessed');
        
        this.stats.itemsResolved++;
        
        this.logger.info('DLQ item successfully reprocessed', {
          dlqId: data.id,
          executionTime,
          jobId: job.id
        });
        
        return { success: true, executionTime };
      } else {
        // Retry failed
        this.logger.warn('DLQ item retry failed', {
          dlqId: data.id,
          error: result.error,
          executionTime,
          jobId: job.id
        });
        
        throw new Error(result.error);
      }
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      this.logger.error('DLQ retry job failed', {
        dlqId: data.id,
        error: error.message,
        executionTime,
        jobId: job.id,
        attemptsMade: job.attemptsMade
      });
      
      // If this was the final attempt, mark as permanently failed
      if (job.attemptsMade >= this.maxRetries) {
        await this.markAsPermanentlyFailed(data.id, error.message);
      }
      
      throw error;
    }
  }

  /**
   * Manually retry a DLQ item
   */
  async retryDlqItem(dlqId, requestedBy = 'admin') {
    try {
      // Get DLQ item from database
      const dlqItem = await this.getDlqItem(dlqId);
      
      if (!dlqItem) {
        throw new Error(`DLQ item not found: ${dlqId}`);
      }
      
      if (dlqItem.status !== 'failed' && dlqItem.status !== 'retried') {
        throw new Error(`DLQ item is not in a retryable state: ${dlqItem.status}`);
      }
      
      // Update status to retrying
      await this.updateDlqStatus(dlqId, 'retrying');
      
      // Record manual retry attempt
      await this.recordRetryAttempt(dlqId, dlqItem.retry_count + 1, requestedBy);
      
      // Add to retry queue
      const job = await this.retryQueue.add('manual-retry', dlqItem, {
        priority: 10 // Higher priority for manual retries
      });
      
      this.stats.itemsRetried++;
      
      this.logger.info('DLQ item queued for manual retry', {
        dlqId,
        requestedBy,
        jobId: job.id
      });
      
      return {
        success: true,
        dlqId,
        jobId: job.id,
        status: 'retrying'
      };
      
    } catch (error) {
      this.logger.error('Failed to retry DLQ item', {
        dlqId,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Get DLQ item from database
   */
  async getDlqItem(dlqId) {
    try {
      const stmt = this.database.db.prepare(`
        SELECT * FROM soroban_dlq_items WHERE id = ?
      `);
      
      return stmt.get(dlqId);
    } catch (error) {
      this.logger.error('Failed to get DLQ item', {
        dlqId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get retry attempts for a DLQ item
   */
  async getRetryAttempts(dlqId) {
    try {
      const stmt = this.database.db.prepare(`
        SELECT * FROM soroban_dlq_retry_attempts 
        WHERE dlq_item_id = ? 
        ORDER BY attempted_at DESC
      `);
      
      return stmt.all(dlqId);
    } catch (error) {
      this.logger.error('Failed to get retry attempts', {
        dlqId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * List DLQ items with filtering
   */
  async listDlqItems(options = {}) {
    try {
      const {
        status = null,
        errorCategory = null,
        limit = 50,
        offset = 0,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = options;
      
      let query = 'SELECT * FROM soroban_dlq_items WHERE expires_at > NOW()';
      const params = [];
      
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      
      if (errorCategory) {
        query += ' AND error_category = ?';
        params.push(errorCategory);
      }
      
      query += ` ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      const stmt = this.database.db.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      this.logger.error('Failed to list DLQ items', {
        error: error.message,
        options
      });
      throw error;
    }
  }

  /**
   * Get DLQ statistics
   */
  async getStats() {
    try {
      const summaryStmt = this.database.db.prepare(`
        SELECT * FROM soroban_dlq_summary
      `);
      
      const dbStats = summaryStmt.get();
      
      return {
        ...this.stats,
        database: dbStats,
        uptime: Date.now() - new Date(this.stats.startTime).getTime()
      };
    } catch (error) {
      this.logger.error('Failed to get DLQ stats', {
        error: error.message
      });
      
      return this.stats;
    }
  }

  /**
   * Categorize error for better handling
   */
  categorizeError(error) {
    const message = error.message.toLowerCase();
    const stack = error.stack ? error.stack.toLowerCase() : '';
    
    if (message.includes('xdr') || stack.includes('xdr')) {
      return 'xdr_parsing';
    }
    
    if (message.includes('validation') || message.includes('invalid')) {
      return 'validation';
    }
    
    if (message.includes('network') || message.includes('timeout') || message.includes('connection')) {
      return 'network';
    }
    
    if (message.includes('database') || message.includes('sql')) {
      return 'database';
    }
    
    return 'processing';
  }

  /**
   * Get priority based on error category
   */
  getPriority(errorCategory) {
    const priorities = {
      'network': 1,      // Lowest priority - might be temporary
      'processing': 5,   // Medium priority
      'validation': 8,   // High priority - data issues
      'xdr_parsing': 10, // Highest priority - parsing issues
      'database': 9      // Very high priority - storage issues
    };
    
    return priorities[errorCategory] || 5;
  }

  /**
   * Send alert for critical failures
   */
  async sendAlert(dlqItem, error) {
    if (!this.alertService) {
      return;
    }
    
    try {
      // Use Slack alert service directly for DLQ-specific formatting
      if (this.alertService.sendDlqAlert) {
        await this.alertService.sendDlqAlert(dlqItem, error);
      } else {
        // Fallback to generic alert
        const alert = {
          type: 'dlq_item_added',
          severity: this.getAlertSeverity(dlqItem.errorCategory),
          title: `Soroban Event Processing Failed`,
          message: `Event ${dlqItem.transactionHash}:${dlqItem.eventIndex} failed processing after ${dlqItem.originalAttemptCount} attempts`,
          details: {
            dlqId: dlqItem.id,
            contractId: dlqItem.contractId,
            transactionHash: dlqItem.transactionHash,
            eventIndex: dlqItem.eventIndex,
            ledgerSequence: dlqItem.ledgerSequence,
            errorCategory: dlqItem.errorCategory,
            errorMessage: dlqItem.errorMessage,
            originalAttemptCount: dlqItem.originalAttemptCount
          },
          timestamp: new Date().toISOString()
        };
        
        await this.alertService.sendAlert(alert);
      }
      
      this.stats.alertsSent++;
      
      this.logger.info('DLQ alert sent', {
        dlqId: dlqItem.id,
        errorCategory: dlqItem.errorCategory
      });
      
    } catch (alertError) {
      this.logger.error('Failed to send DLQ alert', {
        dlqId: dlqItem.id,
        error: alertError.message
      });
    }
  }

  /**
   * Get alert severity based on error category
   */
  getAlertSeverity(errorCategory) {
    const severities = {
      'network': 'warning',
      'processing': 'warning',
      'validation': 'error',
      'xdr_parsing': 'critical',
      'database': 'critical'
    };
    
    return severities[errorCategory] || 'warning';
  }

  /**
   * Record retry attempt
   */
  async recordRetryAttempt(dlqId, attemptNumber, attemptedBy) {
    try {
      const stmt = this.database.db.prepare(`
        INSERT INTO soroban_dlq_retry_attempts (
          dlq_item_id, attempt_number, attempted_by, attempted_at
        ) VALUES (?, ?, ?, NOW())
      `);
      
      stmt.run(dlqId, attemptNumber, attemptedBy);
      
      // Update retry count on main item
      const updateStmt = this.database.db.prepare(`
        UPDATE soroban_dlq_items 
        SET retry_count = ?, last_retry_at = NOW(), updated_at = NOW()
        WHERE id = ?
      `);
      
      updateStmt.run(attemptNumber, dlqId);
      
    } catch (error) {
      this.logger.error('Failed to record retry attempt', {
        dlqId,
        attemptNumber,
        error: error.message
      });
    }
  }

  /**
   * Mark DLQ item as resolved
   */
  async markAsResolved(dlqId, resolvedBy, resolutionNotes) {
    try {
      const stmt = this.database.db.prepare(`
        UPDATE soroban_dlq_items 
        SET status = 'resolved', 
            resolved_at = NOW(),
            resolved_by = ?,
            resolution_notes = ?,
            updated_at = NOW()
        WHERE id = ?
      `);
      
      stmt.run(resolvedBy, resolutionNotes, dlqId);
      
    } catch (error) {
      this.logger.error('Failed to mark DLQ item as resolved', {
        dlqId,
        error: error.message
      });
    }
  }

  /**
   * Mark DLQ item as permanently failed
   */
  async markAsPermanentlyFailed(dlqId, finalError) {
    try {
      const stmt = this.database.db.prepare(`
        UPDATE soroban_dlq_items 
        SET status = 'failed',
            error_message = ?,
            updated_at = NOW()
        WHERE id = ?
      `);
      
      stmt.run(finalError, dlqId);
      
    } catch (error) {
      this.logger.error('Failed to mark DLQ item as permanently failed', {
        dlqId,
        error: error.message
      });
    }
  }

  /**
   * Update DLQ item status
   */
  async updateDlqStatus(dlqId, status) {
    try {
      const stmt = this.database.db.prepare(`
        UPDATE soroban_dlq_items 
        SET status = ?, updated_at = NOW()
        WHERE id = ?
      `);
      
      stmt.run(status, dlqId);
      
    } catch (error) {
      this.logger.error('Failed to update DLQ status', {
        dlqId,
        status,
        error: error.message
      });
    }
  }

  /**
   * Reprocess event using the indexer
   */
  async reprocessEvent(dlqItem) {
    if (!this.indexer) {
      return {
        success: false,
        error: 'Indexer not available for reprocessing'
      };
    }
    
    try {
      return await this.indexer.reprocessEvent(dlqItem);
    } catch (error) {
      this.logger.error('Indexer reprocessing failed', {
        dlqId: dlqItem.id,
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Setup worker event handlers
   */
  setupWorkerEvents() {
    this.retryWorker.on('completed', (job) => {
      this.logger.info('DLQ retry job completed', {
        jobId: job.id,
        dlqId: job.data.id
      });
    });
    
    this.retryWorker.on('failed', (job, err) => {
      this.logger.error('DLQ retry job failed', {
        jobId: job.id,
        dlqId: job.data?.id,
        error: err.message
      });
    });
    
    this.retryWorker.on('error', (err) => {
      this.logger.error('DLQ retry worker error', {
        error: err.message
      });
    });
  }

  /**
   * Start cleanup job for expired items
   */
  startCleanupJob() {
    // Run cleanup every 6 hours
    setInterval(async () => {
      try {
        await this.cleanupExpiredItems();
      } catch (error) {
        this.logger.error('Cleanup job failed', {
          error: error.message
        });
      }
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Clean up expired items
   */
  async cleanupExpiredItems() {
    try {
      // Mark items as expired
      const expireStmt = this.database.db.prepare(`
        SELECT expire_soroban_dlq_items() as expired_count
      `);
      
      const expireResult = expireStmt.get();
      
      // Clean up very old items (older than 30 days)
      const cleanupStmt = this.database.db.prepare(`
        SELECT cleanup_soroban_dlq_items() as cleanup_count
      `);
      
      const cleanupResult = cleanupStmt.get();
      
      this.stats.itemsExpired += expireResult.expired_count || 0;
      
      if (expireResult.expired_count > 0 || cleanupResult.cleanup_count > 0) {
        this.logger.info('DLQ cleanup completed', {
          expiredCount: expireResult.expired_count,
          cleanupCount: cleanupResult.cleanup_count
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to cleanup expired DLQ items', {
        error: error.message
      });
    }
  }

  /**
   * Generate unique DLQ ID
   */
  generateDlqId() {
    return `dlq_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Close the DLQ service
   */
  async close() {
    try {
      if (this.retryWorker) {
        await this.retryWorker.close();
      }
      
      if (this.dlqQueue) {
        await this.dlqQueue.close();
      }
      
      if (this.retryQueue) {
        await this.retryQueue.close();
      }
      
      this.logger.info('Soroban Dead-Letter Queue closed');
    } catch (error) {
      this.logger.error('Error closing DLQ service', {
        error: error.message
      });
    }
  }
}

module.exports = { SorobanDeadLetterQueue };
