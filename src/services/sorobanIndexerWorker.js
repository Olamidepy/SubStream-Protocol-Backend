const { loadConfig } = require('../config');
const { SorobanEventIndexer } = require('./sorobanEventIndexer');
const { SorobanEventPublisher } = require('./sorobanEventPublisher');
const { RabbitMQConnection } = require('../config/rabbitmq');
const { AppDatabase } = require('../db/appDatabase');
const winston = require('winston');

/**
 * Soroban Indexer Worker
 * Main worker process that runs the Soroban event indexer continuously
 */
class SorobanIndexerWorker {
  constructor(config = null) {
    this.config = config || loadConfig();
    this.isRunning = false;
    this.indexer = null;
    this.publisher = null;
    this.rabbitmq = null;
    this.database = null;
    this.logger = null;
    
    // Graceful shutdown handling
    this.shutdownSignals = ['SIGINT', 'SIGTERM'];
    this.isShuttingDown = false;
  }

  /**
   * Initialize the worker
   */
  async initialize() {
    try {
      // Setup logger
      this.setupLogger();
      
      this.logger.info('Initializing Soroban Indexer Worker...');
      
      // Validate configuration
      this.validateConfig();
      
      // Initialize database
      this.database = new AppDatabase(this.config.database);
      
      // Initialize RabbitMQ connection for publishing
      this.rabbitmq = new RabbitMQConnection(this.config.rabbitmq);
      await this.rabbitmq.connect();
      
      // Initialize event publisher
      this.publisher = new SorobanEventPublisher(this.rabbitmq, this.logger);
      await this.publisher.initialize();
      
      // Initialize the event indexer
      this.indexer = new SorobanEventIndexer(this.config, {
        logger: this.logger,
        database: this.database,
        eventPublisher: this.publisher
      });
      
      // Setup graceful shutdown handlers
      this.setupGracefulShutdown();
      
      this.logger.info('Soroban Indexer Worker initialized successfully');
      
    } catch (error) {
      this.logger.error('Failed to initialize Soroban Indexer Worker', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Setup Winston logger
   */
  setupLogger() {
    this.logger = winston.createLogger({
      level: this.config.logLevel || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { 
        service: 'soroban-indexer-worker',
        version: '1.0.0'
      },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        new winston.transports.File({ 
          filename: 'logs/soroban-indexer-error.log', 
          level: 'error' 
        }),
        new winston.transports.File({ 
          filename: 'logs/soroban-indexer.log' 
        })
      ]
    });
  }

  /**
   * Validate required configuration
   */
  validateConfig() {
    const required = [
      'soroban.rpcUrl',
      'soroban.contractId',
      'soroban.networkPassphrase'
    ];
    
    const missing = required.filter(path => {
      const keys = path.split('.');
      let value = this.config;
      for (const key of keys) {
        value = value?.[key];
        if (value === undefined) return true;
      }
      return !value;
    });
    
    if (missing.length > 0) {
      throw new Error(`Missing required configuration: ${missing.join(', ')}`);
    }
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Soroban Indexer Worker is already running');
      return;
    }

    try {
      await this.initialize();
      
      this.isRunning = true;
      this.logger.info('Starting Soroban Indexer Worker...');
      
      // Start the event indexer
      await this.indexer.start();
      
      this.logger.info('Soroban Indexer Worker started successfully');
      
      // Start health monitoring
      this.startHealthMonitoring();
      
      // Keep the process alive
      this.keepAlive();
      
    } catch (error) {
      this.logger.error('Failed to start Soroban Indexer Worker', {
        error: error.message,
        stack: error.stack
      });
      await this.shutdown();
      process.exit(1);
    }
  }

  /**
   * Keep the process alive and handle periodic tasks
   */
  keepAlive() {
    // Log statistics periodically
    const statsInterval = setInterval(() => {
      if (this.isRunning && this.indexer) {
        const stats = this.indexer.getStats();
        this.logger.info('Indexer Statistics', stats);
      }
    }, 60000); // Every minute

    // Clean up on shutdown
    process.on('beforeExit', () => {
      clearInterval(statsInterval);
    });
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    const healthInterval = setInterval(async () => {
      if (this.isRunning && this.indexer) {
        try {
          const health = await this.indexer.getHealthStatus();
          
          if (!health.healthy) {
            this.logger.warn('Indexer health check failed', health);
          }
        } catch (error) {
          this.logger.error('Health monitoring error', {
            error: error.message
          });
        }
      }
    }, 30000); // Every 30 seconds

    // Clean up on shutdown
    process.on('beforeExit', () => {
      clearInterval(healthInterval);
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupGracefulShutdown() {
    this.shutdownSignals.forEach(signal => {
      process.on(signal, async () => {
        this.logger.info(`Received ${signal}, shutting down gracefully...`);
        await this.shutdown();
        process.exit(0);
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      this.logger.error('Uncaught Exception', {
        error: error.message,
        stack: error.stack
      });
      await this.shutdown();
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', async (reason, promise) => {
      this.logger.error('Unhandled Promise Rejection', {
        reason: reason.toString(),
        promise: promise.toString()
      });
      await this.shutdown();
      process.exit(1);
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.isShuttingDown) {
      this.logger.info('Shutdown already in progress...');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info('Shutting down Soroban Indexer Worker...');

    try {
      // Stop the indexer
      if (this.indexer) {
        await this.indexer.stop();
        this.logger.info('Event indexer stopped');
      }

      // Close publisher
      if (this.publisher) {
        await this.publisher.close();
        this.logger.info('Event publisher closed');
      }

      // Close RabbitMQ connection
      if (this.rabbitmq) {
        await this.rabbitmq.close();
        this.logger.info('RabbitMQ connection closed');
      }

      // Close database
      if (this.database) {
        this.database.db.close();
        this.logger.info('Database connection closed');
      }

      this.isRunning = false;
      this.logger.info('Soroban Indexer Worker shutdown complete');

    } catch (error) {
      this.logger.error('Error during shutdown', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isShuttingDown: this.isShuttingDown,
      indexer: this.indexer ? this.indexer.getStats() : null,
      publisher: this.publisher ? this.publisher.getStatus() : null,
      rabbitmq: this.rabbitmq ? { connected: this.rabbitmq.isConnected } : null,
      config: {
        contractId: this.config.soroban.contractId,
        rpcUrl: this.config.soroban.rpcUrl
      }
    };
  }

  /**
   * Health check endpoint
   */
  async healthCheck() {
    try {
      const status = this.getStatus();
      const indexerHealth = this.indexer ? await this.indexer.getHealthStatus() : null;
      
      return {
        healthy: this.isRunning && !this.isShuttingDown && (indexerHealth?.healthy || false),
        status,
        indexerHealth,
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

// Export for use in other modules
module.exports = { SorobanIndexerWorker };

// Run worker if this file is executed directly
if (require.main === module) {
  const worker = new SorobanIndexerWorker();
  
  // Handle command line arguments
  const args = process.argv.slice(2);
  
  if (args.includes('--health')) {
    worker.healthCheck()
      .then(health => {
        console.log(JSON.stringify(health, null, 2));
        process.exit(health.healthy ? 0 : 1);
      })
      .catch(error => {
        console.error('Health check failed:', error.message);
        process.exit(1);
      });
  } else {
    worker.start().catch(error => {
      console.error('Failed to start worker:', error.message);
      process.exit(1);
    });
  }
}
