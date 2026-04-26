/**
 * Soroban Indexer Failover Handler
 * 
 * This module ensures the Soroban event indexer correctly resumes from the last known ledger
 * on the newly promoted database during a disaster recovery failover.
 */

const { SorobanIndexerWorker } = require('./sorobanIndexerWorker');
const { AppDatabase } = require('../db/appDatabase');

class SorobanIndexerFailoverHandler {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.indexer = null;
    this.lastProcessedLedger = null;
    this.isRunning = false;
  }

  /**
   * Initialize the failover handler
   */
  async initialize() {
    try {
      this.db = new AppDatabase(this.config.database.filename);
      
      // Get the last processed ledger from the database
      this.lastProcessedLedger = await this.getLastProcessedLedger();
      
      console.log(`[SorobanFailover] Last processed ledger: ${this.lastProcessedLedger}`);
      
      // Initialize the Soroban indexer
      this.indexer = new SorobanIndexerWorker(this.config);
      
      console.log('[SorobanFailover] Initialized successfully');
    } catch (error) {
      console.error('[SorobanFailover] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Get the last processed ledger from the database
   */
  async getLastProcessedLedger() {
    try {
      const result = this.db.db.prepare(`
        SELECT value
        FROM indexer_state
        WHERE key = 'last_processed_ledger'
      `).get();

      if (!result) {
        console.warn('[SorobanFailover] No last processed ledger found, starting from genesis');
        return 0;
      }

      return parseInt(result.value, 10);
    } catch (error) {
      console.error('[SorobanFailover] Failed to get last processed ledger:', error.message);
      // Default to genesis if table doesn't exist
      return 0;
    }
  }

  /**
   * Validate the last processed ledger
   */
  async validateLastProcessedLedger() {
    try {
      // Check if the ledger sequence is valid
      if (this.lastProcessedLedger < 0) {
        throw new Error('Invalid ledger sequence: negative value');
      }

      // Check if the ledger is too old (more than 30 days)
      const thirtyDaysInLedgers = 30 * 24 * 60 * 60 / 5; // Approximate 5s per ledger
      const currentLedger = await this.getCurrentLedger();
      
      if (currentLedger - this.lastProcessedLedger > thirtyDaysInLedgers) {
        console.warn('[SorobanFailover] Last processed ledger is very old, might need manual intervention');
      }

      console.log('[SorobanFailover] Ledger validation successful');
      return true;
    } catch (error) {
      console.error('[SorobanFailover] Ledger validation failed:', error.message);
      return false;
    }
  }

  /**
   * Get the current ledger from Soroban RPC
   */
  async getCurrentLedger() {
    try {
      const response = await fetch(`${this.config.soroban.rpcUrl}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestLedger',
        }),
      });

      const data = await response.json();
      return data.result.sequence;
    } catch (error) {
      console.error('[SorobanFailover] Failed to get current ledger:', error.message);
      throw error;
    }
  }

  /**
   * Check for missing ledgers between last processed and current
   */
  async checkForMissingLedgers() {
    try {
      const currentLedger = await this.getCurrentLedger();
      const gap = currentLedger - this.lastProcessedLedger;

      if (gap <= 0) {
        console.log('[SorobanFailover] No missing ledgers');
        return [];
      }

      if (gap > 10000) {
        console.warn(`[SorobanFailover] Large ledger gap detected: ${gap} ledgers`);
      }

      // In a real implementation, we might query Soroban for missing ledgers
      // For now, we'll return the range
      return {
        start: this.lastProcessedLedger + 1,
        end: currentLedger,
        count: gap
      };
    } catch (error) {
      console.error('[SorobanFailover] Failed to check for missing ledgers:', error.message);
      throw error;
    }
  }

  /**
   * Resume indexing from the last known ledger
   */
  async resumeIndexing() {
    try {
      console.log('[SorobanFailover] Starting indexing resume process...');

      // Validate the last processed ledger
      const isValid = await this.validateLastProcessedLedger();
      if (!isValid) {
        throw new Error('Ledger validation failed, cannot resume safely');
      }

      // Check for missing ledgers
      const missingLedgers = await this.checkForMissingLedgers();
      if (missingLedgers.count > 0) {
        console.log(`[SorobanFailover] Processing ${missingLedgers.count} missing ledgers from ${missingLedgers.start} to ${missingLedgers.end}`);
      }

      // Start the indexer with the last processed ledger
      this.indexer.startLedger = this.lastProcessedLedger + 1;
      await this.indexer.start();

      this.isRunning = true;
      console.log('[SorobanFailover] Indexing resumed successfully');
      
      return {
        success: true,
        startLedger: this.lastProcessedLedger + 1,
        currentLedger: await this.getCurrentLedger(),
        missingLedgers: missingLedgers.count || 0
      };
    } catch (error) {
      console.error('[SorobanFailover] Failed to resume indexing:', error.message);
      throw error;
    }
  }

  /**
   * Force resume from a specific ledger (manual intervention)
   */
  async forceResumeFromLedger(ledgerSequence) {
    try {
      console.log(`[SorobanFailover] Forcing resume from ledger ${ledgerSequence}`);

      // Update the database state
      this.db.db.prepare(`
        INSERT OR REPLACE INTO indexer_state (key, value)
        VALUES ('last_processed_ledger', ?)
      `).run(ledgerSequence.toString());

      this.lastProcessedLedger = ledgerSequence;

      // Resume indexing
      return await this.resumeIndexing();
    } catch (error) {
      console.error('[SorobanFailover] Failed to force resume:', error.message);
      throw error;
    }
  }

  /**
   * Get indexer status
   */
  async getStatus() {
    try {
      const currentLedger = await this.getCurrentLedger();
      const processedLedger = this.lastProcessedLedger;
      const gap = currentLedger - processedLedger;

      return {
        isRunning: this.isRunning,
        lastProcessedLedger: processedLedger,
        currentLedger: currentLedger,
        ledgerGap: gap,
        indexerStatus: this.indexer ? this.indexer.getStatus() : null,
        healthy: gap < 1000 && this.isRunning
      };
    } catch (error) {
      console.error('[SorobanFailover] Failed to get status:', error.message);
      return {
        isRunning: false,
        healthy: false,
        error: error.message
      };
    }
  }

  /**
   * Stop the indexer
   */
  async stop() {
    try {
      if (this.indexer) {
        await this.indexer.stop();
      }
      this.isRunning = false;
      console.log('[SorobanFailover] Indexer stopped');
    } catch (error) {
      console.error('[SorobanFailover] Failed to stop indexer:', error.message);
      throw error;
    }
  }

  /**
   * Handle failover event
   */
  async handleFailover() {
    console.log('[SorobanFailover] Handling failover event...');

    try {
      // 1. Stop current indexer if running
      if (this.isRunning) {
        await this.stop();
      }

      // 2. Re-initialize with new database connection
      await this.initialize();

      // 3. Validate ledger state
      const isValid = await this.validateLastProcessedLedger();
      if (!isValid) {
        console.error('[SorobanFailover] Ledger validation failed, requiring manual intervention');
        return {
          success: false,
          requiresManualIntervention: true,
          reason: 'Ledger validation failed'
        };
      }

      // 4. Resume indexing
      const result = await this.resumeIndexing();

      console.log('[SorobanFailover] Failover handled successfully');
      return {
        success: true,
        ...result
      };
    } catch (error) {
      console.error('[SorobanFailover] Failed to handle failover:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const status = await this.getStatus();

      return {
        healthy: status.healthy,
        lastProcessedLedger: status.lastProcessedLedger,
        currentLedger: status.currentLedger,
        ledgerGap: status.ledgerGap,
        isRunning: status.isRunning,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Singleton instance
let failoverHandlerInstance = null;

/**
 * Get or create the SorobanIndexerFailoverHandler singleton
 */
function getSorobanIndexerFailoverHandler(config) {
  if (!failoverHandlerInstance) {
    failoverHandlerInstance = new SorobanIndexerFailoverHandler(config);
  }
  return failoverHandlerInstance;
}

/**
 * Reset the singleton (useful for testing)
 */
function resetSorobanIndexerFailoverHandler() {
  if (failoverHandlerInstance) {
    failoverHandlerInstance.stop().catch(err => {
      console.error('[SorobanFailover] Error during cleanup:', err.message);
    });
  }
  failoverHandlerInstance = null;
}

module.exports = {
  SorobanIndexerFailoverHandler,
  getSorobanIndexerFailoverHandler,
  resetSorobanIndexerFailoverHandler
};
