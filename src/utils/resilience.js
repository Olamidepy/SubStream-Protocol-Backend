/**
 * Retry utility for handling failed operations with exponential backoff
 */
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000; // 1 second
    this.maxDelay = options.maxDelay || 30000; // 30 seconds
    this.backoffMultiplier = options.backoffMultiplier || 2;
  }

  /**
   * Execute a function with retry logic
   * @param {Function} fn - Function to execute
   * @param {Object} context - Context for error messages
   * @returns {Promise} Result of the function execution
   */
  async execute(fn, context = {}) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (attempt === this.maxRetries) {
          console.error(`Max retries reached for ${context.operation || 'operation'}:`, error);
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        console.warn(`Attempt ${attempt} failed for ${context.operation || 'operation'}, retrying in ${delay}ms:`, error.message);
        
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Calculate delay with exponential backoff
   */
  calculateDelay(attempt) {
    const delay = this.baseDelay * Math.pow(this.backoffMultiplier, attempt - 1);
    return Math.min(delay, this.maxDelay);
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Circuit breaker pattern for handling cascading failures
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
    this.monitoringPeriod = options.monitoringPeriod || 10000; // 10 seconds
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute(fn, context = {}) {
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker is OPEN for ${context.operation || 'operation'}`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= 3) {
        this.state = 'CLOSED';
        console.log('Circuit breaker reset to CLOSED');
      }
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      console.warn(`Circuit breaker opened due to ${this.failureCount} failures`);
    }
  }

  shouldAttemptReset() {
    return Date.now() - this.lastFailureTime >= this.resetTimeout;
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * Dead letter queue handler for failed messages
 */
class DeadLetterHandler {
  constructor(rabbitmqConnection, config) {
    this.rabbitmq = rabbitmqConnection;
    this.config = config;
    this.deadLetterExchange = config.deadLetterExchange || 'substream_dead_letters';
    this.deadLetterQueue = config.deadLetterQueue || 'substream_dead_letters_queue';
  }

  /**
   * Setup dead letter exchange and queue
   */
  async setup() {
    const channel = await this.rabbitmq.getChannel();
    
    await channel.assertExchange(this.deadLetterExchange, 'topic', {
      durable: true,
    });

    await channel.assertQueue(this.deadLetterQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000, // 7 days TTL
      },
    });

    await channel.bindQueue(
      this.deadLetterQueue,
      this.deadLetterExchange,
      '#'
    );

    console.log('Dead letter queue setup completed');
  }

  /**
   * Send failed message to dead letter queue
   */
  async sendToDeadLetter(originalMessage, error, routingKey) {
    try {
      const channel = await this.rabbitmq.getChannel();
      
      const deadLetterMessage = {
        originalMessage: JSON.parse(originalMessage.content.toString()),
        error: {
          message: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString(),
        },
        originalRoutingKey: routingKey,
        originalQueue: originalMessage.fields.routingKey,
        deathCount: (originalMessage.properties.headers?.['x-death']?.[0]?.count || 0) + 1,
      };

      channel.publish(
        this.deadLetterExchange,
        routingKey,
        Buffer.from(JSON.stringify(deadLetterMessage)),
        {
          persistent: true,
          timestamp: Date.now(),
          headers: {
            source: 'substream-backend',
            originalQueue: originalMessage.fields.routingKey,
          },
        }
      );

      console.log(`Message sent to dead letter queue: ${routingKey}`);
    } catch (error) {
      console.error('Failed to send message to dead letter queue:', error);
    }
  }
}

module.exports = {
  RetryHandler,
  CircuitBreaker,
  DeadLetterHandler,
};
