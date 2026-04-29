// src/services/webhookDispatcherService.js
const crypto = require('crypto');
const knexFactory = require('knex');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');

class WebhookDispatcherService {
  constructor() {
    this.queue = new Queue('merchant-webhooks', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      }
    });
    this.knex = knexFactory(require('../../knexfile')[process.env.NODE_ENV || 'development']);
  }

  /**
   * Dispatch webhook with HMAC signature
   */
  async dispatch(eventType, payload, merchantId, subscriptionId = null) {
    if (!merchantId) return;

    const merchant = await this.getMerchantWithSecret(merchantId);
    if (!merchant?.webhook_url || !merchant?.webhook_secret) {
      console.warn(`[Webhook] Merchant ${merchantId} missing webhook_url or webhook_secret`);
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp (seconds)

    // Add timestamp to payload for replay protection
    const signedPayload = {
      ...payload,
      timestamp
    };

    const signature = this.generateHMACSignature(signedPayload, merchant.webhook_secret);

    const jobData = {
      eventType,
      payload: signedPayload,
      webhookUrl: merchant.webhook_url,
      merchantId,
      subscriptionId,
      signature,
      timestamp
    };

    await this.queue.add('dispatch-webhook', jobData);
    console.log(`[Webhook] Queued signed ${eventType} for merchant ${merchantId}`);
  }

  generateHMACSignature(payload, secret) {
    const payloadStr = JSON.stringify(payload);
    return crypto
      .createHmac('sha256', secret)
      .update(payloadStr, 'utf8')
      .digest('hex');
  }

  async getMerchantWithSecret(merchantId) {
    const merchant = await this.knex('merchants')
      .where({ id: merchantId })
      .select('webhook_url', 'webhook_secret')
      .first();
    return merchant;
  }

  async close() {
    await this.queue.close();
    await this.knex.destroy();
  }
}

module.exports = { WebhookDispatcherService };
