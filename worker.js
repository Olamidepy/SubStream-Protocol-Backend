#!/usr/bin/env node

const { loadConfig } = require('./src/config');
const { BackgroundWorkerService } = require('./src/services/backgroundWorkerService');

/**
 * Standalone background worker process
 * This can be run as a separate service from the main API
 */
async function startWorker() {
  console.log('Starting SubStream Background Worker...');
  
  const config = loadConfig();
  
  // Check if RabbitMQ is configured
  if (!config.rabbitmq || (!config.rabbitmq.url && !config.rabbitmq.host)) {
    console.error('RabbitMQ configuration is missing. Please set RABBITMQ_URL or RABBITMQ_HOST environment variables.');
    process.exit(1);
  }

  const worker = new BackgroundWorkerService(config.rabbitmq);

  // Handle graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      await worker.stop();
      console.log('Background worker stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the worker
  try {
    await worker.start();
    console.log('Background worker started successfully');
    console.log('Processing events from queues:');
    console.log(`  - Events: ${config.rabbitmq.eventQueue}`);
    console.log(`  - Notifications: ${config.rabbitmq.notificationQueue}`);
    console.log(`  - Emails: ${config.rabbitmq.emailQueue}`);
    console.log(`  - Leaderboard: ${config.rabbitmq.leaderboardQueue}`);
    
    // Keep the process alive
    process.stdin.resume();
  } catch (error) {
    console.error('Failed to start background worker:', error);
    process.exit(1);
  }
}

// Health check endpoint for monitoring
if (process.argv.includes('--health')) {
  const config = loadConfig();
  const worker = new BackgroundWorkerService(config.rabbitmq);
  
  worker.start()
    .then(() => {
      const status = worker.getStatus();
      console.log(JSON.stringify(status, null, 2));
      process.exit(status.isRunning && status.connected ? 0 : 1);
    })
    .catch((error) => {
      console.error('Health check failed:', error);
      process.exit(1);
    });
} else {
  startWorker();
}
