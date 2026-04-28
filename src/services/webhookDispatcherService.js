const axios = require('axios');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis'); // adjust path

class WebhookDispatcherService {
  constructor() {
    this.queue = new Queue('merchant-webhooks', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5 seconds first retry
        },
        removeOnComplete: { age: 7 * 24 * 3600 }, // keep 7 days
        removeOnFail: { age: 30 * 24 * 3600 },    // keep 30 days
      }
    });

    this.queue.on('completed', (job) => {
      console.log(`[Webhook] Success → ${job.data.webhook_url} | Event: ${job.data.eventType}`);
    });

    this.queue.on('failed', (job, err) => {
      console.error(`[Webhook] Failed after ${job.attemptsMade} attempts → ${job.data.webhook_url}`, err.message);
    });
  }

  /**
   * Dispatch webhook asynchronously
   */
  async dispatch(eventType, payload, merchantId, subscriptionId = null) {
    if (!merchantId) {
      console.warn(`[Webhook] Cannot dispatch: merchantId is missing for event ${eventType}`);
      return;
    }

    // Get merchant's webhook URL from DB
    const merchant = await this.getMerchantWebhook(merchantId);
    if (!merchant || !merchant.webhook_url) {
      console.log(`[Webhook] No webhook URL configured for merchant ${merchantId}`);
      return;
    }

    const jobData = {
      eventType,
      payload,
      webhookUrl: merchant.webhook_url,
      merchantId,
      subscriptionId,
      timestamp: new Date().toISOString()
    };

    await this.queue.add('dispatch-webhook', jobData);
    console.log(`[Webhook] Queued ${eventType} for merchant ${merchantId}`);
  }

  async getMerchantWebhook(merchantId) {
    const knex = require('knex')(require('../knexfile')[process.env.NODE_ENV || 'development']);
    const merchant = await knex('merchants')
      .where({ id: merchantId })
      .select('webhook_url')
      .first();
    
    await knex.destroy();
    return merchant;
  }

  async close() {
    await this.queue.close();
  }
}

module.exports = { WebhookDispatcherService };