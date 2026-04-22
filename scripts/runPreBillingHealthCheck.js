#!/usr/bin/env node

/**
 * Standalone Pre-Billing Health Check Runner
 * This script can be run as a cron job or standalone process
 */

const { AppDatabase } = require('../src/db/appDatabase');
const PreBillingEmailService = require('../services/preBillingEmailService');
const PreBillingHealthWorker = require('../workers/preBillingHealthWorker');

// Load environment variables
require('dotenv').config();

// Configuration
const config = {
  database: null, // Will be initialized below
  emailService: null, // Will be initialized below
  soroban: {
    rpcUrl: process.env.SOROBAN_RPC_URL,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
    contractId: process.env.SUBSTREAM_CONTRACT_ID
  },
  cronSchedule: process.env.PRE_BILLING_CRON_SCHEDULE || '0 2 * * *',
  warningThresholdDays: parseInt(process.env.WARNING_THRESHOLD_DAYS) || 3,
  batchSize: parseInt(process.env.BATCH_SIZE) || 50,
  runOnStart: process.env.RUN_ON_START === 'true'
};

// Validate required environment variables
function validateConfig() {
  const required = ['SOROBAN_RPC_URL', 'SOROBAN_SOURCE_SECRET', 'SUBSTREAM_CONTRACT_ID'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    process.exit(1);
  }
}

// Initialize services
function initializeServices() {
  try {
    // Initialize database
    const dbPath = process.env.DATABASE_PATH || './data/app.db';
    config.database = new AppDatabase(dbPath);
    console.log(`Database initialized: ${dbPath}`);
    
    // Initialize email service
    config.emailService = new PreBillingEmailService({
      fromEmail: process.env.FROM_EMAIL,
      baseUrl: process.env.FRONTEND_URL,
      supportEmail: process.env.SUPPORT_EMAIL
    });
    console.log('Email service initialized');
    
  } catch (error) {
    console.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Main execution
async function main() {
  console.log('=== Pre-Billing Health Check Runner ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  
  try {
    // Validate configuration
    validateConfig();
    
    // Initialize services
    initializeServices();
    
    // Create and start worker
    const worker = new PreBillingHealthWorker(config);
    
    console.log('Configuration:');
    console.log(`  - Warning Threshold Days: ${config.warningThresholdDays}`);
    console.log(`  - Batch Size: ${config.batchSize}`);
    console.log(`  - Cron Schedule: ${config.cronSchedule}`);
    console.log(`  - Run On Start: ${config.runOnStart}`);
    
    // Start the worker
    worker.start();
    
    console.log('Pre-billing health check worker started successfully');
    console.log('Press Ctrl+C to stop the worker');
    
    // Set up graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      await worker.shutdown();
    });
    
    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM, shutting down gracefully...');
      await worker.shutdown();
    });
    
    // Keep the process running
    process.stdin.resume();
    
  } catch (error) {
    console.error('Failed to start pre-billing health check worker:', error);
    process.exit(1);
  }
}

// Handle command line arguments
function handleArguments() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Pre-Billing Health Check Runner

Usage: node runPreBillingHealthCheck.js [options]

Options:
  --help, -h              Show this help message
  --run-once              Run health check once and exit
  --test-wallet <address> Test health check for specific wallet
  --status                Show worker status and exit
  --metrics               Show performance metrics and exit

Environment Variables:
  SOROBAN_RPC_URL         Soroban RPC server URL (required)
  SOROBAN_SOURCE_SECRET   Source account secret (required)
  SUBSTREAM_CONTRACT_ID   SubStream contract ID (required)
  STELLAR_NETWORK_PASSPHRASE  Stellar network passphrase
  DATABASE_PATH           Database file path
  FROM_EMAIL              From email address
  FRONTEND_URL            Frontend base URL
  SUPPORT_EMAIL            Support email address
  PRE_BILLING_CRON_SCHEDULE  Cron schedule (default: 0 2 * * *)
  WARNING_THRESHOLD_DAYS  Warning threshold days (default: 3)
  BATCH_SIZE              Batch processing size (default: 50)
  RUN_ON_START            Run on start (default: false)

Examples:
  # Run as daemon with cron scheduling
  node runPreBillingHealthCheck.js

  # Run health check once
  node runPreBillingHealthCheck.js --run-once

  # Test specific wallet
  node runPreBillingHealthCheck.js --test-wallet GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ

  # Show status
  node runPreBillingHealthCheck.js --status
`);
    process.exit(0);
  }
  
  if (args.includes('--run-once')) {
    runOnce();
    return;
  }
  
  const testWalletIndex = args.findIndex(arg => arg === '--test-wallet');
  if (testWalletIndex !== -1 && args[testWalletIndex + 1]) {
    testWallet(args[testWalletIndex + 1]);
    return;
  }
  
  if (args.includes('--status')) {
    showStatus();
    return;
  }
  
  if (args.includes('--metrics')) {
    showMetrics();
    return;
  }
}

// Run health check once
async function runOnce() {
  console.log('Running pre-billing health check once...');
  
  try {
    validateConfig();
    initializeServices();
    
    const worker = new PreBillingHealthWorker(config);
    const result = await worker.runHealthCheck();
    
    console.log('Health check completed:');
    console.log(`  - Processed: ${result.results.processed}`);
    console.log(`  - Warnings Sent: ${result.results.warningsSent}`);
    console.log(`  - Errors: ${result.results.errors}`);
    console.log(`  - Duration: ${result.duration}ms`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('Health check failed:', error);
    process.exit(1);
  }
}

// Test specific wallet
async function testWallet(walletAddress) {
  console.log(`Testing health check for wallet: ${walletAddress}`);
  
  try {
    validateConfig();
    initializeServices();
    
    const worker = new PreBillingHealthWorker(config);
    const result = await worker.testWallet(walletAddress, 10000000); // 1 XLM default
    
    console.log('Health check result:');
    console.log(`  - Wallet: ${result.walletAddress}`);
    console.log(`  - Healthy: ${result.healthCheck.isHealthy}`);
    console.log(`  - Issues: ${result.healthCheck.issues.length}`);
    
    if (result.healthCheck.issues.length > 0) {
      console.log('Issues:');
      result.healthCheck.issues.forEach((issue, index) => {
        console.log(`    ${index + 1}. ${issue.type}: ${issue.message}`);
      });
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('Wallet test failed:', error);
    process.exit(1);
  }
}

// Show worker status
async function showStatus() {
  try {
    validateConfig();
    initializeServices();
    
    const worker = new PreBillingHealthWorker(config);
    const status = worker.getStatus();
    
    console.log('Worker Status:');
    console.log(`  - Is Running: ${status.isRunning}`);
    console.log(`  - Last Run: ${status.lastRun || 'Never'}`);
    console.log(`  - Run History: ${status.runHistory.length} entries`);
    console.log(`  - Warning Threshold: ${status.config.warningThresholdDays} days`);
    console.log(`  - Batch Size: ${status.config.batchSize}`);
    
    if (status.healthCheckStats) {
      console.log('Balance Checker Stats:');
      console.log(`  - RPC URL: ${status.healthCheckStats.rpcUrl}`);
      console.log(`  - Cache Size: ${status.healthCheckStats.cacheSize}`);
      console.log(`  - Rate Limiter Size: ${status.healthCheckStats.rateLimiterSize}`);
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('Failed to get status:', error);
    process.exit(1);
  }
}

// Show performance metrics
async function showMetrics() {
  try {
    validateConfig();
    initializeServices();
    
    const worker = new PreBillingHealthWorker(config);
    const metrics = worker.getMetrics();
    
    console.log('Performance Metrics:');
    console.log(`  - Total Runs: ${metrics.totalRuns}`);
    console.log(`  - Successful Runs: ${metrics.successfulRuns}`);
    console.log(`  - Failed Runs: ${metrics.failedRuns}`);
    console.log(`  - Success Rate: ${metrics.successRate.toFixed(2)}%`);
    console.log(`  - Average Duration: ${metrics.avgDuration}ms`);
    console.log(`  - Total Processed: ${metrics.totalProcessed}`);
    console.log(`  - Total Warnings: ${metrics.totalWarnings}`);
    console.log(`  - Total Errors: ${metrics.totalErrors}`);
    console.log(`  - Last Run: ${metrics.lastRun || 'Never'}`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('Failed to get metrics:', error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the main function or handle arguments
if (require.main === module) {
  handleArguments();
} else {
  module.exports = { main, runOnce, testWallet, showStatus, showMetrics };
}
