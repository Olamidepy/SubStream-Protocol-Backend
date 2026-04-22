const axios = require('axios');
const { Server, TransactionBuilder, Networks, xdr } = require('@stellar/stellar-sdk');

/**
 * Soroban RPC Client Service
 * Handles communication with Soroban RPC nodes with retry logic and circuit breaker
 */
class SorobanRpcService {
  constructor(config, logger = console) {
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase || Networks.PUBLIC;
    this.contractId = config.contractId;
    this.logger = logger;
    
    // Initialize Stellar RPC server
    this.server = new Server(this.rpcUrl);
    
    // Retry configuration
    this.maxRetries = config.maxRetries || 5;
    this.baseDelay = config.baseDelay || 1000;
    this.maxDelay = config.maxDelay || 30000;
    
    // Circuit breaker configuration
    this.circuitBreaker = {
      failureThreshold: config.failureThreshold || 5,
      resetTimeout: config.resetTimeout || 60000,
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failureCount: 0,
      lastFailureTime: null
    };
    
    // Rate limiting
    this.rateLimit = {
      requestsPerSecond: config.requestsPerSecond || 10,
      requestTimes: []
    };
  }

  /**
   * Check circuit breaker state before making requests
   */
  checkCircuitBreaker() {
    const now = Date.now();
    
    if (this.circuitBreaker.state === 'OPEN') {
      if (now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.resetTimeout) {
        this.circuitBreaker.state = 'HALF_OPEN';
        this.logger.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN - blocking requests');
      }
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess() {
    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this.circuitBreaker.state = 'CLOSED';
      this.circuitBreaker.failureCount = 0;
      this.logger.info('Circuit breaker transitioning to CLOSED');
    }
  }

  /**
   * Record a failed request
   */
  recordFailure() {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();
    
    if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
      this.circuitBreaker.state = 'OPEN';
      this.logger.warn(`Circuit breaker OPEN after ${this.circuitBreaker.failureCount} failures`);
    }
  }

  /**
   * Check rate limiting
   */
  checkRateLimit() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Remove old request timestamps
    this.rateLimit.requestTimes = this.rateLimit.requestTimes.filter(time => time > oneSecondAgo);
    
    if (this.rateLimit.requestTimes.length >= this.rateLimit.requestsPerSecond) {
      throw new Error('Rate limit exceeded');
    }
    
    this.rateLimit.requestTimes.push(now);
  }

  /**
   * Execute request with exponential backoff retry
   */
  async executeWithRetry(operation, context = {}) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.checkCircuitBreaker();
        this.checkRateLimit();
        
        const result = await operation();
        this.recordSuccess();
        
        if (attempt > 0) {
          this.logger.info(`Operation succeeded after ${attempt} retries`, context);
        }
        
        return result;
      } catch (error) {
        this.recordFailure();
        lastError = error;
        
        if (attempt === this.maxRetries) {
          this.logger.error(`Operation failed after ${this.maxRetries} retries`, {
            ...context,
            error: error.message
          });
          throw error;
        }
        
        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
          this.maxDelay
        );
        
        this.logger.warn(`Operation failed, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`, {
          ...context,
          error: error.message
        });
        
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the latest ledger number
   */
  async getLatestLedger() {
    return this.executeWithRetry(async () => {
      const response = await this.server.getLatestLedger();
      return response.sequence;
    }, { operation: 'getLatestLedger' });
  }

  /**
   * Get events for a specific ledger range
   */
  async getEvents(startLedger, endLedger, filters = {}) {
    return this.executeWithRetry(async () => {
      const events = await this.server.events({
        startLedger,
        endLedger,
        filters: {
          contractIds: [this.contractId],
          ...filters
        }
      });
      
      return events;
    }, { 
      operation: 'getEvents', 
      startLedger, 
      endLedger 
    });
  }

  /**
   * Get transaction details including events
   */
  async getTransaction(transactionHash) {
    return this.executeWithRetry(async () => {
      const transaction = await this.server.getTransaction(transactionHash);
      return transaction;
    }, { 
      operation: 'getTransaction', 
      transactionHash 
    });
  }

  /**
   * Get ledger details including transactions
   */
  async getLedger(ledgerSequence) {
    return this.executeWithRetry(async () => {
      const ledger = await this.server.getLedger(ledgerSequence);
      return ledger;
    }, { 
      operation: 'getLedger', 
      ledgerSequence 
    });
  }

  /**
   * Stream events from a starting ledger
   * Returns an async iterator that yields events as they become available
   */
  async* streamEvents(startLedger, eventTypes = ['SubscriptionBilled', 'TrialStarted', 'PaymentFailed']) {
    let currentLedger = startLedger;
    let latestKnownLedger = await this.getLatestLedger();
    
    while (true) {
      // Check if we've caught up to the latest ledger
      if (currentLedger > latestKnownLedger) {
        // Wait a bit and check for new ledgers
        await this.sleep(2000);
        latestKnownLedger = await this.getLatestLedger();
        continue;
      }
      
      // Fetch events for the current ledger
      try {
        const events = await this.getEvents(currentLedger, currentLedger);
        
        for (const event of events.events) {
          // Filter by event types we care about
          if (this.isRelevantEvent(event, eventTypes)) {
            yield {
              ...event,
              ledgerSequence: currentLedger,
              processedAt: new Date().toISOString()
            };
          }
        }
        
        currentLedger++;
      } catch (error) {
        this.logger.error(`Failed to fetch events for ledger ${currentLedger}`, {
          error: error.message
        });
        
        // Back off on error
        await this.sleep(5000);
      }
    }
  }

  /**
   * Check if an event is relevant to our subscription tracking
   */
  isRelevantEvent(event, relevantTypes) {
    if (!event.type || !event.type.includes('contract')) {
      return false;
    }
    
    // Parse event body to get the event type
    try {
      const eventBody = xdr.ScVal.fromXDR(event.body, 'base64');
      const eventType = this.extractEventType(eventBody);
      return relevantTypes.includes(eventType);
    } catch (error) {
      this.logger.warn('Failed to parse event body', {
        error: error.message,
        eventId: event.id
      });
      return false;
    }
  }

  /**
   * Extract event type from parsed XDR
   */
  extractEventType(eventBody) {
    // This is a simplified implementation
    // In practice, you'd need to parse the specific contract event structure
    if (eventBody.switch().name === 'instance') {
      const instanceVal = eventBody.instance();
      if (instanceVal.switch().name === 'vec') {
        const vec = instanceVal.vec();
        if (vec.length > 0) {
          const firstVal = vec[0];
          if (firstVal.switch().name === 'symbol') {
            return firstVal.symbol().toString();
          }
        }
      }
    }
    
    return 'Unknown';
  }

  /**
   * Get health status of the RPC service
   */
  async getHealthStatus() {
    try {
      const startTime = Date.now();
      await this.getLatestLedger();
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: true,
        responseTime,
        circuitBreakerState: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount,
        rpcUrl: this.rpcUrl
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        circuitBreakerState: this.circuitBreaker.state,
        failureCount: this.circuitBreaker.failureCount,
        rpcUrl: this.rpcUrl
      };
    }
  }

  /**
   * Reset circuit breaker (for testing or manual recovery)
   */
  resetCircuitBreaker() {
    this.circuitBreaker.state = 'CLOSED';
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.lastFailureTime = null;
    this.logger.info('Circuit breaker manually reset');
  }
}

module.exports = { SorobanRpcService };
