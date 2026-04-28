const EventEmitter = require('events');
const { logger } = require('../src/utils/logger');
const promClient = require('prom-client');

class SorobanCircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Circuit breaker configuration
    this.failureThreshold = options.failureThreshold || parseInt(process.env.SOROBAN_FAILURE_THRESHOLD) || 5;
    this.resetTimeout = options.resetTimeout || parseInt(process.env.SOROBAN_RESET_TIMEOUT) || 60000; // 1 minute
    this.monitoringPeriod = options.monitoringPeriod || 10000; // 10 seconds
    this.maxRetries = options.maxRetries || parseInt(process.env.SOROBAN_MAX_RETRIES) || 3;
    this.baseDelay = options.baseDelay || parseInt(process.env.SOROBAN_BASE_DELAY) || 1000;
    this.maxDelay = options.maxDelay || parseInt(process.env.SOROBAN_MAX_DELAY) || 30000;
    this.requestsPerSecond = options.requestsPerSecond || parseInt(process.env.SOROBAN_REQUESTS_PER_SECOND) || 10;
    
    // Circuit breaker state
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
    this.requestCount = 0;
    this.lastRequestTime = Date.now();
    this.circuitOpenedTime = null;
    
    // Rate limiting
    this.requestTimestamps = [];
    
    // Prometheus metrics
    this.setupMetrics();
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Soroban Circuit Breaker initialized', {
      failureThreshold: this.failureThreshold,
      resetTimeout: this.resetTimeout,
      maxRetries: this.maxRetries,
      requestsPerSecond: this.requestsPerSecond
    });
  }
  
  setupMetrics() {
    // Create custom metrics
    this.circuitBreakerState = new promClient.Gauge({
      name: 'soroban_circuit_breaker_state',
      help: 'Current state of the Soroban circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
      registers: [global.register]
    });
    
    this.circuitBreakerFailures = new promClient.Counter({
      name: 'soroban_circuit_breaker_failures_total',
      help: 'Total number of failures recorded by the circuit breaker',
      labelNames: ['method', 'error_type'],
      registers: [global.register]
    });
    
    this.circuitBreakerSuccesses = new promClient.Counter({
      name: 'soroban_circuit_breaker_successes_total',
      help: 'Total number of successful requests through the circuit breaker',
      labelNames: ['method'],
      registers: [global.register]
    });
    
    this.circuitBreakerRetries = new promClient.Counter({
      name: 'soroban_circuit_breaker_retries_total',
      help: 'Total number of retry attempts',
      labelNames: ['method'],
      registers: [global.register]
    });
    
    this.circuitBreakerRequestDuration = new promClient.Histogram({
      name: 'soroban_circuit_breaker_request_duration_seconds',
      help: 'Duration of requests through the circuit breaker',
      labelNames: ['method', 'state'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
      registers: [global.register]
    });
    
    // Update initial state metric
    this.updateStateMetric();
  }
  
  updateStateMetric() {
    const stateValue = this.state === 'CLOSED' ? 0 : this.state === 'OPEN' ? 1 : 2;
    this.circuitBreakerState.set(stateValue);
  }
  
  startMonitoring() {
    setInterval(() => {
      this.checkCircuitState();
      this.cleanupOldTimestamps();
    }, this.monitoringPeriod);
  }
  
  cleanupOldTimestamps() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > oneSecondAgo);
  }
  
  checkCircuitState() {
    if (this.state === 'OPEN' && this.circuitOpenedTime) {
      const timeSinceOpen = Date.now() - this.circuitOpenedTime;
      if (timeSinceOpen >= this.resetTimeout) {
        this.transitionToHalfOpen();
      }
    }
  }
  
  transitionToOpen() {
    if (this.state !== 'OPEN') {
      this.state = 'OPEN';
      this.circuitOpenedTime = Date.now();
      this.emit('stateChange', 'OPEN');
      logger.warn('Soroban Circuit Breaker OPENED - RPC calls are blocked', {
        failureCount: this.failureCount,
        failureThreshold: this.failureThreshold
      });
      this.updateStateMetric();
    }
  }
  
  transitionToHalfOpen() {
    if (this.state === 'OPEN') {
      this.state = 'HALF_OPEN';
      this.successCount = 0;
      this.emit('stateChange', 'HALF_OPEN');
      logger.info('Soroban Circuit Breaker HALF_OPEN - Testing RPC connectivity', {
        timeSinceOpen: Date.now() - this.circuitOpenedTime
      });
      this.updateStateMetric();
    }
  }
  
  transitionToClosed() {
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.successCount = 0;
      this.circuitOpenedTime = null;
      this.emit('stateChange', 'CLOSED');
      logger.info('Soroban Circuit Breaker CLOSED - RPC calls are allowed', {
        previousState: this.state
      });
      this.updateStateMetric();
    }
  }
  
  async execute(operation, context = {}) {
    const startTime = Date.now();
    const method = context.method || 'unknown';
    
    try {
      // Check rate limiting
      if (!this.checkRateLimit()) {
        throw new Error('Rate limit exceeded for Soroban RPC calls');
      }
      
      // Check circuit state
      if (this.state === 'OPEN') {
        throw new Error('Circuit breaker is OPEN - Soroban RPC calls are blocked');
      }
      
      // Execute operation with retries
      const result = await this.executeWithRetries(operation, method, startTime);
      
      // Record success
      this.recordSuccess(method);
      
      // Transition to CLOSED if we're in HALF_OPEN and have enough successes
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= 3) { // Need 3 consecutive successes
          this.transitionToClosed();
        }
      }
      
      return result;
      
    } catch (error) {
      // Record failure
      this.recordFailure(method, error);
      
      // Check if we need to open the circuit
      if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
        this.transitionToOpen();
      } else if (this.state === 'HALF_OPEN') {
        // Any failure in HALF_OPEN state should open the circuit again
        this.transitionToOpen();
      }
      
      throw error;
    } finally {
      // Record request duration
      const duration = (Date.now() - startTime) / 1000;
      this.circuitBreakerRequestDuration
        .labels(method, this.state)
        .observe(duration);
    }
  }
  
  checkRateLimit() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > oneSecondAgo);
    
    // Check if we're at the limit
    if (this.requestTimestamps.length >= this.requestsPerSecond) {
      return false;
    }
    
    // Add current timestamp
    this.requestTimestamps.push(now);
    return true;
  }
  
  async executeWithRetries(operation, method, startTime) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff with jitter
          const delay = Math.min(
            this.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000,
            this.maxDelay
          );
          
          logger.debug(`Retrying Soroban operation (attempt ${attempt + 1})`, {
            method,
            delay,
            lastError: lastError?.message
          });
          
          await this.sleep(delay);
          this.circuitBreakerRetries.labels(method).inc();
        }
        
        return await operation();
        
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw error;
        }
        
        if (attempt === this.maxRetries) {
          throw error;
        }
      }
    }
    
    throw lastError;
  }
  
  isNonRetryableError(error) {
    const nonRetryablePatterns = [
      'invalid contract',
      'invalid argument',
      'authentication failed',
      'unauthorized',
      'forbidden',
      'not found'
    ];
    
    const errorMessage = error.message.toLowerCase();
    return nonRetryablePatterns.some(pattern => errorMessage.includes(pattern));
  }
  
  recordSuccess(method) {
    this.failureCount = 0; // Reset failure count on success
    this.circuitBreakerSuccesses.labels(method).inc();
  }
  
  recordFailure(method, error) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    // Categorize error type
    let errorType = 'unknown';
    if (error.message.includes('timeout')) errorType = 'timeout';
    else if (error.message.includes('network')) errorType = 'network';
    else if (error.message.includes('rate limit')) errorType = 'rate_limit';
    else if (error.message.includes('server')) errorType = 'server_error';
    
    this.circuitBreakerFailures.labels(method, errorType).inc();
    
    logger.warn('Soroban operation failed', {
      method,
      error: error.message,
      errorType,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      circuitState: this.state
    });
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // Health check methods
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      lastFailureTime: this.lastFailureTime,
      circuitOpenedTime: this.circuitOpenedTime,
      successCount: this.successCount,
      requestCount: this.requestCount,
      currentRate: this.requestTimestamps.length,
      maxRate: this.requestsPerSecond
    };
  }
  
  isHealthy() {
    return this.state === 'CLOSED' && this.failureCount < this.failureThreshold;
  }
  
  isDegraded() {
    return this.state === 'HALF_OPEN' || 
           (this.state === 'CLOSED' && this.failureCount > 0);
  }
  
  // Manual control methods
  forceOpen() {
    this.transitionToOpen();
  }
  
  forceClose() {
    this.transitionToClosed();
  }
  
  reset() {
    this.transitionToClosed();
    this.requestTimestamps = [];
    this.requestCount = 0;
  }
  
  // Configuration updates
  updateConfig(newConfig) {
    if (newConfig.failureThreshold !== undefined) {
      this.failureThreshold = newConfig.failureThreshold;
    }
    if (newConfig.resetTimeout !== undefined) {
      this.resetTimeout = newConfig.resetTimeout;
    }
    if (newConfig.maxRetries !== undefined) {
      this.maxRetries = newConfig.maxRetries;
    }
    if (newConfig.baseDelay !== undefined) {
      this.baseDelay = newConfig.baseDelay;
    }
    if (newConfig.maxDelay !== undefined) {
      this.maxDelay = newConfig.maxDelay;
    }
    if (newConfig.requestsPerSecond !== undefined) {
      this.requestsPerSecond = newConfig.requestsPerSecond;
    }
    
    logger.info('Soroban Circuit Breaker configuration updated', newConfig);
  }
}

module.exports = SorobanCircuitBreaker;
