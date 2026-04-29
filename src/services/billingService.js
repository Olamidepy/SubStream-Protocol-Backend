const crypto = require('crypto');
const db = require('../database/connection');
const usageQuotaService = require('./usageQuota');

class BillingService {
  constructor() {
    this.webhookSecret = process.env.BILLING_WEBHOOK_SECRET;
    this.chainRpcUrl = process.env.CHAIN_RPC_URL;
  }

  // Verify webhook signature for billing events
  verifyWebhookSignature(payload, signature) {
    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  // Handle billing webhook from payment processor
  async handleBillingWebhook(eventType, data, signature) {
    try {
      // Verify webhook signature
      const payload = JSON.stringify(data);
      if (!this.verifyWebhookSignature(payload, signature)) {
        throw new Error('Invalid webhook signature');
      }

      console.log(`Processing billing webhook: ${eventType}`, data);

      switch (eventType) {
        case 'subscription.created':
          await this.handleSubscriptionCreated(data);
          break;
        case 'subscription.updated':
          await this.handleSubscriptionUpdated(data);
          break;
        case 'subscription.cancelled':
          await this.handleSubscriptionCancelled(data);
          break;
        case 'payment.succeeded':
          await this.handlePaymentSucceeded(data);
          break;
        case 'payment.failed':
          await this.handlePaymentFailed(data);
          break;
        default:
          console.log(`Unhandled billing event type: ${eventType}`);
      }

      return { success: true };
    } catch (error) {
      console.error('Billing webhook processing failed:', error);
      throw error;
    }
  }

  // Handle new subscription creation
  async handleSubscriptionCreated(data) {
    const { customer_id, subscription_id, plan_id, wallet_address } = data;
    
    // Map plan_id to tier
    const tier = this.mapPlanToTier(plan_id);
    
    // Update developer subscription status
    const query = `
      UPDATE developers 
      SET subscription_status = $1, wallet_address = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id
    `;
    
    const result = await db.query(query, [tier, wallet_address, customer_id]);
    
    if (result.rows.length > 0) {
      // Update API key tier
      await this.updateApiKeyTier(customer_id, tier);
      
      // Log billing event
      await this.logBillingEvent(customer_id, 'subscription_created', null, 'USD', subscription_id, 'completed');
      
      console.log(`Subscription created for developer ${customer_id}, tier: ${tier}`);
    }
  }

  // Handle subscription updates
  async handleSubscriptionUpdated(data) {
    const { customer_id, subscription_id, plan_id } = data;
    
    const tier = this.mapPlanToTier(plan_id);
    
    // Update developer subscription status
    const query = `
      UPDATE developers 
      SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id
    `;
    
    const result = await db.query(query, [tier, customer_id]);
    
    if (result.rows.length > 0) {
      // Update API key tier
      await this.updateApiKeyTier(customer_id, tier);
      
      // Log billing event
      await this.logBillingEvent(customer_id, 'subscription_updated', null, 'USD', subscription_id, 'completed');
      
      console.log(`Subscription updated for developer ${customer_id}, new tier: ${tier}`);
    }
  }

  // Handle subscription cancellation
  async handleSubscriptionCancelled(data) {
    const { customer_id, subscription_id } = data;
    
    // Downgrade to free tier
    const query = `
      UPDATE developers 
      SET subscription_status = 'free', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id
    `;
    
    const result = await db.query(query, [customer_id]);
    
    if (result.rows.length > 0) {
      // Update API key tier to standard
      await this.updateApiKeyTier(customer_id, 'standard');
      
      // Log billing event
      await this.logBillingEvent(customer_id, 'subscription_cancelled', null, 'USD', subscription_id, 'completed');
      
      console.log(`Subscription cancelled for developer ${customer_id}, downgraded to standard tier`);
    }
  }

  // Handle successful payment
  async handlePaymentSucceeded(data) {
    const { customer_id, amount, subscription_id, transaction_hash } = data;
    
    // Log billing event
    await this.logBillingEvent(
      customer_id, 
      'payment_succeeded', 
      amount, 
      'USD', 
      transaction_hash, 
      'completed'
    );
    
    console.log(`Payment succeeded for developer ${customer_id}, amount: ${amount}`);
  }

  // Handle failed payment
  async handlePaymentFailed(data) {
    const { customer_id, amount, subscription_id, transaction_hash } = data;
    
    // Log billing event
    await this.logBillingEvent(
      customer_id, 
      'payment_failed', 
      amount, 
      'USD', 
      transaction_hash, 
      'failed'
    );
    
    // Check if this is a recurring payment failure
    const failureCount = await this.getPaymentFailureCount(customer_id);
    
    if (failureCount >= 3) {
      // Downgrade to free tier after 3 failed payments
      await this.handleSubscriptionCancelled({ customer_id, subscription_id });
      console.log(`Developer ${customer_id} downgraded due to payment failures`);
    }
    
    console.log(`Payment failed for developer ${customer_id}, amount: ${amount}, failures: ${failureCount}`);
  }

  // Update API key tier based on subscription
  async updateApiKeyTier(developerId, tier) {
    const query = `
      UPDATE api_keys 
      SET tier = $1, updated_at = CURRENT_TIMESTAMP
      WHERE developer_id = $2
    `;
    
    await db.query(query, [tier, developerId]);
  }

  // Map billing plan to API tier
  mapPlanToTier(planId) {
    const planMappings = {
      'free': 'standard',
      'basic': 'standard',
      'premium': 'premium',
      'enterprise': 'premium',
    };
    
    return planMappings[planId] || 'standard';
  }

  // Log billing events to database
  async logBillingEvent(developerId, eventType, amount, currency, transactionHash, status) {
    const query = `
      INSERT INTO billing_events (developer_id, event_type, amount, currency, transaction_hash, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    await db.query(query, [developerId, eventType, amount, currency, transactionHash, status]);
  }

  // Get payment failure count for a developer
  async getPaymentFailureCount(developerId) {
    const query = `
      SELECT COUNT(*) as failure_count
      FROM billing_events
      WHERE developer_id = $1 AND event_type = 'payment_failed' AND created_at > NOW() - INTERVAL '30 days'
    `;
    
    const result = await db.query(query, [developerId]);
    return parseInt(result.rows[0].failure_count);
  }

  // Process on-chain payment verification
  async verifyOnChainPayment(transactionHash, expectedAmount, developerId) {
    try {
      // This would integrate with blockchain RPC to verify payment
      // For now, we'll simulate the verification process
      
      console.log(`Verifying on-chain payment: ${transactionHash} for developer ${developerId}`);
      
      // Simulate blockchain verification (in real implementation, use web3.js/ethers.js)
      const isValid = await this.mockBlockchainVerification(transactionHash, expectedAmount);
      
      if (isValid) {
        // Upgrade to premium tier
        await this.handleSubscriptionUpdated({
          customer_id: developerId,
          subscription_id: transactionHash,
          plan_id: 'premium'
        });
        
        return { success: true, tier: 'premium' };
      } else {
        throw new Error('Invalid transaction');
      }
    } catch (error) {
      console.error('On-chain payment verification failed:', error);
      throw error;
    }
  }

  // Mock blockchain verification (replace with actual implementation)
  async mockBlockchainVerification(transactionHash, expectedAmount) {
    // In real implementation, this would:
    // 1. Call blockchain RPC to get transaction details
    // 2. Verify the transaction amount and recipient
    // 3. Check confirmation count
    // 4. Validate payment was sent to correct address
    
    // For demo purposes, we'll assume valid transactions start with "0xvalid"
    return transactionHash.startsWith('0xvalid');
  }

  // Get billing status for a developer
  async getBillingStatus(developerId) {
    const query = `
      SELECT 
        d.subscription_status,
        d.wallet_address,
        COUNT(CASE WHEN be.event_type = 'payment_succeeded' THEN 1 END) as successful_payments,
        COUNT(CASE WHEN be.event_type = 'payment_failed' THEN 1 END) as failed_payments,
        MAX(be.created_at) as last_payment_date
      FROM developers d
      LEFT JOIN billing_events be ON d.id = be.developer_id
      WHERE d.id = $1
      GROUP BY d.id, d.subscription_status, d.wallet_address
    `;
    
    const result = await db.query(query, [developerId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }

  // Generate billing upgrade URL
  generateUpgradeUrl(developerId, tier) {
    const baseUrl = 'https://substream.protocol/billing/upgrade';
    const params = new URLSearchParams({
      developer_id: developerId,
      target_tier: tier,
      timestamp: Date.now().toString(),
    });
    
    return `${baseUrl}?${params.toString()}`;
  }
}

module.exports = new BillingService();
