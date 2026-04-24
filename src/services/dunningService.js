
const crypto = require('crypto');

/**
 * Dunning Service
 * Orchestrates the 7-day recovery sequence for failed payments
 */
class DunningService {
  constructor(database, notificationService, webhookDispatcher, logger = console) {
    this.database = database;
    this.notificationService = notificationService;
    this.webhookDispatcher = webhookDispatcher;
    this.logger = logger;
  }

  /**
   * Handle PaymentFailedGracePeriodStarted event
   * @param {Object} event 
   */
  async handlePaymentFailed(event) {
    const { walletAddress, creatorId } = event;
    this.logger.info(`Starting dunning sequence for ${walletAddress} (Creator: ${creatorId})`);

    try {
      // 1. Create a new dunning sequence
      const sequenceId = `dun_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const sequence = {
        id: sequenceId,
        wallet_address: walletAddress,
        creator_id: creatorId,
        status: 'active',
        current_day: 1,
        next_notification_at: this.calculateNextDate(3) // Day 4 is 3 days away
      };

      await this.database.createDunningSequence(sequence);

      // 2. Dispatch Day 1 Email
      await this.notificationService.sendEmail({
        to: walletAddress,
        template: 'payment_failed_day_1',
        data: {
          creatorId,
          daysRemaining: 7,
          walletAddress
        }
      });

      await this.database.recordDunningHistory({
        id: crypto.randomUUID(),
        sequence_id: sequenceId,
        event_type: 'email_day_1',
        status: 'success'
      });

    } catch (error) {
      this.logger.error('Error handling payment failed event:', error);
    }
  }

  /**
   * Handle SubscriptionBilled event (Payment successful)
   * This should halt any active dunning sequence
   * @param {Object} event 
   */
  async handleSubscriptionBilled(event) {
    const { walletAddress, creatorId } = event;
    this.logger.info(`Halting dunning sequence for ${walletAddress} due to successful billing`);

    try {
      await this.database.haltDunningSequence(walletAddress, creatorId);
    } catch (error) {
      this.logger.error('Error halting dunning sequence:', error);
    }
  }

  /**
   * Process active dunning sequences
   * This should be called by a cron job or background worker
   */
  async processSequences() {
    this.logger.info('Processing active dunning sequences');
    
    try {
      const activeSequences = await this.database.getActiveDunningSequences();
      const now = new Date();

      for (const sequence of activeSequences) {
        if (new Date(sequence.next_notification_at) <= now) {
          await this.advanceSequence(sequence);
        }
      }
    } catch (error) {
      this.logger.error('Error processing dunning sequences:', error);
    }
  }

  /**
   * Advance a dunning sequence to the next step
   * @param {Object} sequence 
   */
  async advanceSequence(sequence) {
    try {
      if (sequence.current_day === 1) {
        // Move to Day 4
        await this.notificationService.sendEmail({
          to: sequence.wallet_address,
          template: 'payment_failed_day_4',
          data: {
            creatorId: sequence.creator_id,
            daysRemaining: 3,
            walletAddress: sequence.wallet_address
          }
        });

        await this.database.updateDunningSequence(sequence.id, {
          current_day: 4,
          next_notification_at: this.calculateNextDate(3) // Day 7 is 3 days from Day 4
        });

        await this.database.recordDunningHistory({
          id: crypto.randomUUID(),
          sequence_id: sequence.id,
          event_type: 'email_day_4',
          status: 'success'
        });

      } else if (sequence.current_day === 4) {
        // Move to Day 7: Trigger Webhook and complete
        await this.webhookDispatcher.dispatch(
          sequence.creator_id,
          sequence.wallet_address,
          'subscription.interrupted',
          {
            reason: 'payment_failed_grace_period_expired',
            interrupted_at: new Date().toISOString()
          }
        );

        await this.database.updateDunningSequence(sequence.id, {
          current_day: 7,
          status: 'completed',
          next_notification_at: null
        });

        await this.database.recordDunningHistory({
          id: crypto.randomUUID(),
          sequence_id: sequence.id,
          event_type: 'webhook_day_7',
          status: 'success'
        });
      }
    } catch (error) {
      this.logger.error(`Error advancing sequence ${sequence.id}:`, error);
    }
  }

  /**
   * Calculate next notification date
   * @param {number} days 
   * @returns {string} ISO string
   */
  calculateNextDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }
}

module.exports = { DunningService };
