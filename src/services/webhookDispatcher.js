
const axios = require('axios');
const { PrivacyService } = require('./privacyService');

/**
 * Webhook Dispatcher
 * Handles sending webhooks to merchants with privacy scrubbing
 */
class WebhookDispatcher {
  constructor(database, logger = console) {
    this.database = database;
    this.logger = logger;
    this.privacyService = new PrivacyService(database);
  }

  /**
   * Dispatch a webhook event to a merchant
   * @param {string} creatorId 
   * @param {string} walletAddress 
   * @param {string} eventType 
   * @param {Object} payload 
   */
  async dispatch(creatorId, walletAddress, eventType, payload) {
    try {
      // 1. Get merchant's webhook URL
      // We assume creators/merchants have a webhook_url configured in their profile
      const merchant = await this.database.getCreator(creatorId);
      if (!merchant || !merchant.webhook_url) {
        this.logger.debug(`No webhook URL configured for merchant ${creatorId}`);
        return;
      }

      // 2. Scrub payload based on user's privacy preferences
      const scrubbedPayload = await this.privacyService.scrubPayload(walletAddress, {
        ...payload,
        event_type: eventType,
        wallet_address: walletAddress
      });

      // 3. Send the webhook
      this.logger.info(`Sending webhook to ${merchant.webhook_url}`, {
        creatorId,
        eventType,
        walletAddress
      });

      const response = await axios.post(merchant.webhook_url, scrubbedPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-SubStream-Event': eventType,
          'X-SubStream-Signature': this.generateSignature(scrubbedPayload, merchant.webhook_secret)
        },
        timeout: 5000 // 5 seconds timeout
      });

      this.logger.info(`Webhook sent successfully to ${merchant.webhook_url}`, {
        status: response.status
      });

      return { success: true, status: response.status };
    } catch (error) {
      this.logger.error(`Failed to send webhook for ${creatorId}`, {
        error: error.message,
        url: error.config?.url
      });
      // Optionally queue for retry or alert
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate HMAC signature for webhook payload verification
   * @param {Object} payload 
   * @param {string} secret 
   * @returns {string}
   */
  generateSignature(payload, secret) {
    if (!secret) return 'unsigned';
    const crypto = require('crypto');
    return crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }
}

module.exports = { WebhookDispatcher };
