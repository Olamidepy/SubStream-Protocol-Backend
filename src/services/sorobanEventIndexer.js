const { SorobanRpcService } = require('./sorobanRpcService');
const { SorobanXdrParser } = require('../utils/sorobanXdrParser');
const { SorobanDeadLetterQueue } = require('./sorobanDeadLetterQueue');
const { AppDatabase } = require('../db/appDatabase');

/**
 * Soroban Event Indexer Service
 * Handles idempotent ingestion of Soroban events with database tracking
 */
class SorobanEventIndexer {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.contractId = config.contractId;
    this.logger = dependencies.logger || console;
    this.database = dependencies.database || new AppDatabase(config.database);
    
    // Initialize services
    this.rpcService = new SorobanRpcService(config.soroban, this.logger);
    this.xdrParser = new SorobanXdrParser(this.logger);
    
    // DLQ integration
    this.dlqService = dependencies.dlqService || new SorobanDeadLetterQueue(config, {
      logger: this.logger,
      database: this.database,
      alertService: dependencies.alertService || null
    });
    
    // Pub/Sub integration
    this.eventPublisher = dependencies.eventPublisher || null;
    
    // Retry configuration
    this.maxRetries = config.maxRetries || 3;
    
    // Indexer state
    this.isRunning = false;
    this.currentLedger = 0;
    this.lastProcessedLedger = 0;
    this.processingInterval = config.processingInterval || 5000; // 5 seconds
    
    // Event types to track
    this.eventTypes = ['SubscriptionBilled', 'TrialStarted', 'PaymentFailed', 'PaymentFailedGracePeriodStarted'];
    
    // Statistics
    this.stats = {
      eventsProcessed: 0,
      eventsFailed: 0,
      duplicatesSkipped: 0,
      dlqItemsAdded: 0,
      dlqItemsRetried: 0,
      dlqItemsResolved: 0,
      ledgersProcessed: 0,
      startTime: null,
      lastEventTime: null
    };
  }

  /**
   * Start the event indexer
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Event indexer is already running');
      return;
    }

    try {
      // Initialize ingestion state
      await this.initializeIngestionState();
      
      // Initialize DLQ service
      await this.dlqService.initialize();
      
      // Start the main indexing loop
      this.isRunning = true;
      this.stats.startTime = new Date().toISOString();
      
      this.logger.info('Starting Soroban event indexer', {
        contractId: this.contractId,
        startLedger: this.currentLedger,
        eventTypes: this.eventTypes
      });
      
      // Run the indexing loop
      await this.runIndexingLoop();
    } catch (error) {
      this.logger.error('Failed to start event indexer', { error: error.message });
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the event indexer
   */
  async stop() {
    this.isRunning = false;
    this.logger.info('Soroban event indexer stopped', {
      finalStats: this.getStats()
    });
  }

  /**
   * Initialize or retrieve ingestion state
   */
  async initializeIngestionState() {
    try {
      // Get the last ingested ledger from database
      const state = await this.getIngestionState();
      
      if (state) {
        this.currentLedger = state.last_ingested_ledger;
        this.lastProcessedLedger = state.last_ingested_ledger;
        this.logger.info('Resumed indexing from saved state', {
          lastLedger: this.currentLedger,
          timestamp: state.last_ingested_timestamp
        });
      } else {
        // Start from the latest ledger if no state exists
        const latestLedger = await this.rpcService.getLatestLedger();
        this.currentLedger = latestLedger;
        this.lastProcessedLedger = latestLedger;
        
        // Save initial state
        await this.updateIngestionState(this.currentLedger);
        
        this.logger.info('Started indexing from latest ledger', {
          startLedger: this.currentLedger
        });
      }
    } catch (error) {
      this.logger.error('Failed to initialize ingestion state', { error: error.message });
      throw error;
    }
  }

  /**
   * Main indexing loop
   */
  async runIndexingLoop() {
    while (this.isRunning) {
      try {
        await this.processNextBatch();
        
        // Wait before next batch
        await this.sleep(this.processingInterval);
      } catch (error) {
        this.logger.error('Error in indexing loop', { error: error.message });
        
        // Back off on error
        await this.sleep(Math.min(this.processingInterval * 2, 30000));
      }
    }
  }

  /**
   * Process the next batch of events
   */
  async processNextBatch() {
    try {
      // Get the latest ledger from the network
      const latestLedger = await this.rpcService.getLatestLedger();
      
      if (this.currentLedger >= latestLedger) {
        // We're caught up, nothing to process
        return;
      }
      
      // Process ledgers in batches to avoid overwhelming the system
      const batchSize = Math.min(10, latestLedger - this.currentLedger);
      const endLedger = this.currentLedger + batchSize;
      
      this.logger.debug('Processing ledger batch', {
        startLedger: this.currentLedger,
        endLedger,
        batchSize
      });
      
      // Fetch events for the batch
      const events = await this.rpcService.getEvents(this.currentLedger, endLedger);
      
      // Process each event
      let eventsInBatch = 0;
      for (const event of events.events) {
        const processed = await this.processEvent(event);
        if (processed) {
          eventsInBatch++;
        }
      }
      
      // Update our position
      this.lastProcessedLedger = endLedger;
      this.currentLedger = endLedger + 1;
      
      // Save ingestion state
      await this.updateIngestionState(this.lastProcessedLedger);
      
      // Update statistics
      this.stats.ledgersProcessed += batchSize;
      
      this.logger.debug('Processed ledger batch', {
        startLedger: this.currentLedger - batchSize - 1,
        endLedger: this.lastProcessedLedger,
        eventsProcessed: eventsInBatch
      });
      
    } catch (error) {
      this.logger.error('Failed to process batch', {
        currentLedger: this.currentLedger,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process a single event with idempotent ingestion and DLQ retry logic
   */
  async processEvent(event, retryCount = 0) {
    try {
      // Parse the event
      const parsedEvent = this.xdrParser.parseEvent(event);
      
      if (!parsedEvent.isValid) {
        const error = new Error(parsedEvent.error || 'Invalid event format');
        return await this.handleEventFailure(event, error, retryCount, 'xdr_parsing');
      }
      
      // Check if this is an event type we care about
      if (!this.eventTypes.includes(parsedEvent.type)) {
        return false;
      }
      
      // Validate parsed data
      const validation = this.xdrParser.validateEventData(parsedEvent);
      if (!validation.isValid) {
        const error = new Error(`Validation failed: ${validation.errors.join(', ')}`);
        return await this.handleEventFailure(event, error, retryCount, 'validation');
      }
      
      // Check for duplicates using idempotent constraint
      const isDuplicate = await this.isDuplicateEvent(parsedEvent);
      if (isDuplicate) {
        this.logger.debug('Skipping duplicate event', {
          transactionHash: parsedEvent.transactionHash,
          eventIndex: parsedEvent.eventIndex
        });
        this.stats.duplicatesSkipped++;
        return false;
      }
      
      // Store the event in database
      const eventId = await this.storeEvent(parsedEvent);
      
      // Publish to internal Pub/Sub if configured
      if (this.eventPublisher) {
        await this.publishEvent(parsedEvent, eventId);
      }
      
      // Update statistics
      this.stats.eventsProcessed++;
      this.stats.lastEventTime = new Date().toISOString();
      
      this.logger.debug('Successfully processed event', {
        eventId,
        eventType: parsedEvent.type,
        transactionHash: parsedEvent.transactionHash,
        eventIndex: parsedEvent.eventIndex
      });
      
      return true;
      
    } catch (error) {
      return await this.handleEventFailure(event, error, retryCount, 'processing');
    }
  }

  /**
   * Handle event processing failure with DLQ integration
   */
  async handleEventFailure(event, error, retryCount, errorCategory) {
    this.logger.warn('Event processing failed', {
      eventId: event.id,
      transactionHash: event.transactionHash,
      errorCategory,
      retryCount,
      error: error.message
    });

    // Increment failure count
    this.stats.eventsFailed++;

    // Check if we should retry or send to DLQ
    if (retryCount < this.maxRetries) {
      this.logger.info('Retrying event processing', {
        eventId: event.id,
        retryCount: retryCount + 1,
        maxRetries: this.maxRetries
      });

      // Retry after a delay
      await this.sleep(Math.min(1000 * Math.pow(2, retryCount), 10000));
      
      try {
        return await this.processEvent(event, retryCount + 1);
      } catch (retryError) {
        // If retry fails, continue to DLQ
        return await this.handleEventFailure(event, retryError, retryCount + 1, errorCategory);
      }
    } else {
      // Max retries exceeded, send to DLQ
      this.logger.error('Event processing failed after max retries, sending to DLQ', {
        eventId: event.id,
        transactionHash: event.transactionHash,
        retryCount,
        errorCategory,
        error: error.message
      });

      try {
        const dlqResult = await this.dlqService.addFailedEvent(event, error, retryCount + 1);
        
        if (dlqResult.success) {
          this.stats.dlqItemsAdded++;
          this.logger.info('Event added to DLQ', {
            eventId: event.id,
            dlqId: dlqResult.dlqId,
            willRetry: dlqResult.willRetry
          });
        } else {
          this.logger.error('Failed to add event to DLQ', {
            eventId: event.id,
            error: dlqResult.queueError || 'Unknown error'
          });
        }
        
        return false;
        
      } catch (dlqError) {
        this.logger.error('Critical error: Failed to add event to DLQ', {
          eventId: event.id,
          error: dlqError.message,
          originalError: error.message
        });
        
        // Even if DLQ fails, we need to advance the ledger to prevent infinite loops
        return false;
      }
    }
  }

  /**
   * Check if an event is a duplicate
   */
  async isDuplicateEvent(parsedEvent) {
    try {
      // Check database for existing event with same transaction_hash and event_index
      const existing = await this.database.db.prepare(`
        SELECT id FROM soroban_events 
        WHERE transaction_hash = ? AND event_index = ?
      `).get(parsedEvent.transactionHash, parsedEvent.eventIndex);
      
      return !!existing;
    } catch (error) {
      this.logger.error('Failed to check for duplicate event', {
        transactionHash: parsedEvent.transactionHash,
        eventIndex: parsedEvent.eventIndex,
        error: error.message
      });
      // If we can't check, assume it's not a duplicate to avoid data loss
      return false;
    }
  }

  /**
   * Store event in database with idempotent constraint
   */
  async storeEvent(parsedEvent) {
    try {
      const eventId = this.generateEventId();
      
      const stmt = this.database.db.prepare(`
        INSERT INTO soroban_events (
          id, contract_id, transaction_hash, event_index, ledger_sequence,
          event_type, event_data, raw_xdr, ledger_timestamp, ingested_at,
          status, retry_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        eventId,
        parsedEvent.contractId,
        parsedEvent.transactionHash,
        parsedEvent.eventIndex,
        parsedEvent.ledgerSequence,
        parsedEvent.type,
        JSON.stringify(parsedEvent.parsedData),
        parsedEvent.rawXdr,
        parsedEvent.ledgerTimestamp,
        new Date().toISOString(),
        'processed',
        0
      );
      
      return eventId;
    } catch (error) {
      // Check if this is a unique constraint violation (duplicate)
      if (error.message.includes('UNIQUE constraint failed') || 
          error.message.includes('duplicate key')) {
        this.logger.debug('Event already exists (idempotent constraint)', {
          transactionHash: parsedEvent.transactionHash,
          eventIndex: parsedEvent.eventIndex
        });
        throw new Error('Duplicate event');
      }
      
      this.logger.error('Failed to store event', {
        transactionHash: parsedEvent.transactionHash,
        eventIndex: parsedEvent.eventIndex,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Publish event to internal Pub/Sub system
   */
  async publishEvent(parsedEvent, eventId) {
    try {
      const eventData = {
        id: eventId,
        type: parsedEvent.type,
        contractId: parsedEvent.contractId,
        transactionHash: parsedEvent.transactionHash,
        eventIndex: parsedEvent.eventIndex,
        ledgerSequence: parsedEvent.ledgerSequence,
        ledgerTimestamp: parsedEvent.ledgerTimestamp,
        data: parsedEvent.parsedData,
        publishedAt: new Date().toISOString()
      };
      
      await this.eventPublisher.publish('soroban.events', eventData);
      
      this.logger.debug('Published event to Pub/Sub', {
        eventId,
        eventType: parsedEvent.type
      });
    } catch (error) {
      this.logger.error('Failed to publish event', {
        eventId,
        error: error.message
      });
      // Don't throw here - event storage is more important than publishing
    }
  }

  /**
   * Get ingestion state from database
   */
  async getIngestionState() {
    try {
      const stmt = this.database.db.prepare(`
        SELECT * FROM soroban_ingestion_state 
        WHERE contract_id = ?
      `);
      
      return stmt.get(this.contractId);
    } catch (error) {
      this.logger.error('Failed to get ingestion state', { error: error.message });
      return null;
    }
  }

  /**
   * Update ingestion state in database
   */
  async updateIngestionState(ledgerSequence) {
    try {
      const stmt = this.database.db.prepare(`
        INSERT INTO soroban_ingestion_state 
        (contract_id, last_ingested_ledger, last_ingested_timestamp)
        VALUES (?, ?, ?)
        ON CONFLICT(contract_id) 
        DO UPDATE SET 
          last_ingested_ledger = excluded.last_ingested_ledger,
          last_ingested_timestamp = excluded.last_ingested_timestamp,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      stmt.run(
        this.contractId,
        ledgerSequence,
        new Date().toISOString()
      );
    } catch (error) {
      this.logger.error('Failed to update ingestion state', {
        ledgerSequence,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Generate unique event ID
   */
  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get indexer statistics
   */
  getStats() {
    const uptime = this.stats.startTime ? 
      Date.now() - new Date(this.stats.startTime).getTime() : 0;
    
    return {
      ...this.stats,
      uptime,
      currentLedger: this.currentLedger,
      lastProcessedLedger: this.lastProcessedLedger,
      isRunning: this.isRunning,
      contractId: this.contractId,
      eventsPerSecond: uptime > 0 ? (this.stats.eventsProcessed / (uptime / 1000)).toFixed(2) : 0
    };
  }

  /**
   * Get health status
   */
  async getHealthStatus() {
    try {
      const rpcHealth = await this.rpcService.getHealthStatus();
      const stats = this.getStats();
      
      return {
        healthy: this.isRunning && rpcHealth.healthy,
        indexer: stats,
        rpc: rpcHealth,
        database: 'connected' // Add actual DB health check if needed
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        indexer: this.getStats()
      };
    }
  }

  /**
   * Reprocess event from DLQ
   */
  async reprocessEvent(dlqItem) {
    try {
      this.logger.info('Reprocessing DLQ event', {
        dlqId: dlqItem.id,
        transactionHash: dlqItem.transaction_hash,
        eventIndex: dlqItem.event_index
      });

      // Reconstruct the original event from the stored payload
      const event = {
        ...dlqItem.raw_event_payload,
        id: dlqItem.id
      };

      // Process the event again
      const result = await this.processEvent(event, 0);
      
      if (result) {
        this.stats.dlqItemsResolved++;
        this.logger.info('DLQ event successfully reprocessed', {
          dlqId: dlqItem.id,
          transactionHash: dlqItem.transaction_hash
        });
        
        return { success: true };
      } else {
        return { 
          success: false, 
          error: 'Event processing returned false during reprocessing' 
        };
      }
      
    } catch (error) {
      this.logger.error('Failed to reprocess DLQ event', {
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
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { SorobanEventIndexer };
