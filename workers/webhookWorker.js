#!/usr/bin/env node

const axios = require('axios');
const { Worker } = require('bullmq');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const knex = require('knex')(require('../../knexfile')[process.env.NODE_ENV || 'development']);
const { getRedisConnection } = require('../config/redis'); // We'll create this if not exists

const WEBHOOK_TIMEOUT_MS = 5000; // 5 seconds
const MAX_RESPONSE_LOG_LENGTH = 1000;

/**
 * Process a single webhook job with retry support
 */
async function processWebhook(job) {
  const { 
    eventType, 
    payload, 
    webhookUrl, 
    merchantId, 
    subscriptionId 
  } = job.data;

  const attempt = job.attemptsMade || 1;

  console.log(`[Webhook] Attempt ${attempt}/5 → ${eventType} to ${webhookUrl}`);

  let statusCode = null;
  let responseBody = null;
  let errorMessage = null;
  let success = false;

  const headers = {
  'Content-Type': 'application/json',
  'User-Agent': 'SubStream-Webhook-Dispatcher/1.0',
  'X-Substream-Event': eventType,
  'X-Substream-Timestamp': timestamp.toString(),
  'X-Substream-Signature': signature   // ← HMAC signature
    };

  try {
    const response = await axios.post(webhookUrl, payload, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SubStream-Webhook-Dispatcher/1.0',
        'X-Substream-Event': eventType,
        'X-Substream-Attempt': attempt.toString()
      },
      validateStatus: () => true // Allow all status codes so we can log them
    });

    statusCode = response.status;
    responseBody = response.data 
      ? JSON.stringify(response.data).slice(0, MAX_RESPONSE_LOG_LENGTH) 
      : null;

    success = statusCode >= 200 && statusCode < 300;

    if (success) {
      console.log(`[Webhook] SUCCESS (${statusCode}) → ${eventType} | Merchant: ${merchantId}`);
    } else {
      console.warn(`[Webhook] FAILED (${statusCode}) → ${eventType} | Merchant: ${merchantId}`);
      throw new Error(`Merchant returned non-2xx status: ${statusCode}`);
    }

  } catch (error) {
    success = false;
    statusCode = error.response?.status || null;
    errorMessage = error.message || 'Request failed';

    if (error.code === 'ECONNABORTED') {
      errorMessage = 'Webhook request timed out after 5 seconds';
    } else if (error.response) {
      responseBody = error.response.data 
        ? JSON.stringify(error.response.data).slice(0, MAX_RESPONSE_LOG_LENGTH) 
        : null;
    }

    console.error(`[Webhook] ERROR (Attempt ${attempt}) → ${eventType}: ${errorMessage}`);
    throw error; // Re-throw to let BullMQ handle retry logic
  } 
  finally {
    // Always log the attempt for audit and merchant dashboard
    await logWebhookAttempt({
      subscriptionId,
      merchantId,
      eventType,
      webhookUrl,
      attemptNumber: attempt,
      statusCode,
      responseBody,
      success,
      errorMessage,
      payload: payload
    });
  }
}

/**
 * Log every webhook attempt to the database
 */
async function logWebhookAttempt(logData) {
  try {
    await knex('webhook_logs').insert({
      subscription_id: logData.subscriptionId,
      merchant_id: logData.merchantId,
      event_type: logData.eventType,
      webhook_url: logData.webhookUrl,
      attempt_number: logData.attemptNumber,
      status_code: logData.statusCode,
      response_body: logData.responseBody,
      success: logData.success,
      error_message: logData.errorMessage,
      payload: logData.payload,
      delivered_at: knex.fn.now()
    });
  } catch (dbError) {
    console.error('[Webhook] Failed to log attempt to database:', dbError.message);
    // Do not throw — we don't want logging failure to break the retry flow
  }
}

/**
 * Initialize BullMQ Worker
 */
const webhookWorker = new Worker(
  'merchant-webhooks',
  processWebhook,
  {
    connection: getRedisConnection(),
    concurrency: 8,                    // Process up to 8 webhooks concurrently
    limiter: {
      max: 50,                         // Max 50 jobs per 10 seconds (rate limiting)
      duration: 10000,
    },
    settings: {
      backoffStrategy: (attemptsMade) => {
        return Math.min(attemptsMade * 10000, 3600000); // Max 1 hour delay
      }
    }
  }
);

// Event listeners for monitoring
webhookWorker.on('ready', () => {
  console.log('[WebhookWorker] Merchant Webhook Dispatcher is ready and listening');
});

webhookWorker.on('error', (err) => {
  console.error('[WebhookWorker] Critical error:', err);
});

webhookWorker.on('failed', (job, err) => {
  console.error(`[WebhookWorker] Job failed after ${job.attemptsMade} attempts | Event: ${job.data?.eventType}`);
});

webhookWorker.on('completed', (job) => {
  console.log(`[WebhookWorker] Job completed successfully | Event: ${job.data?.eventType}`);
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('[WebhookWorker] Shutting down gracefully...');
  await webhookWorker.close();
  await knex.destroy();
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

console.log('[WebhookWorker] Merchant Webhook Dispatcher started successfully');

module.exports = webhookWorker;