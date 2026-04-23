const { RabbitMQConnection } = require('../config/rabbitmq');
const { RetryHandler, CircuitBreaker, DeadLetterHandler } = require('../utils/resilience');

/**
 * Background worker service for processing asynchronous events
 */
class BackgroundWorkerService {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.rabbitmq = new RabbitMQConnection(config);
    this.isRunning = false;
    this.processors = new Map();
    
    // Initialize resilience components
    this.retryHandler = new RetryHandler({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
    });
    
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 60000,
    });
    
    this.deadLetterHandler = new DeadLetterHandler(this.rabbitmq, config);
    
    // Inject dependencies for testing
    this.emailService = dependencies.emailService || null;
    this.notificationService = dependencies.notificationService || null;
    this.leaderboardService = dependencies.leaderboardService || null;
    this.analyticsService = dependencies.analyticsService || null;
    
    // Initialize new services for protocol enhancements
    const { DunningService } = require('./dunningService');
    const { InvoiceService } = require('./invoiceService');
    const { WebhookDispatcher } = require('./webhookDispatcher');
    const { PrivacyService } = require('./privacyService');
    
    const db = dependencies.database || null;
    this.webhookDispatcher = dependencies.webhookDispatcher || new WebhookDispatcher(db);
    this.dunningService = dependencies.dunningService || new DunningService(db, this.notificationService, this.webhookDispatcher);
    this.invoiceService = dependencies.invoiceService || new InvoiceService(config.invoice || { s3: {} });
    this.privacyService = dependencies.privacyService || new PrivacyService(db);
  }

  /**
   * Initialize the worker service
   */
  async initialize() {
    try {
      await this.rabbitmq.connect();
      await this.rabbitmq.setupTopology();
      await this.deadLetterHandler.setup();
      await this.setupProcessors();
      this.isRunning = true;
      console.log('BackgroundWorkerService initialized successfully');
    } catch (error) {
      console.error('Failed to initialize BackgroundWorkerService:', error);
      throw error;
    }
  }

  /**
   * Setup message processors for different queues
   */
  async setupProcessors() {
    const channel = await this.rabbitmq.getChannel();

    // Subscription event processor
    await channel.consume(this.config.eventQueue, async (msg) => {
      if (msg) {
        try {
          await this.circuitBreaker.execute(async () => {
            await this.retryHandler.execute(async () => {
              const event = JSON.parse(msg.content.toString());
              await this.processSubscriptionEvent(event);
            }, { operation: 'processSubscriptionEvent' });
          }, { operation: 'subscription_event_processing' });
          
          channel.ack(msg);
        } catch (error) {
          console.error('Error processing subscription event:', error);
          await this.deadLetterHandler.sendToDeadLetter(msg, error, 'subscription.error');
          channel.nack(msg, false, false); // Reject and don't requeue
        }
      }
    });

    // Notification processor
    await channel.consume(this.config.notificationQueue, async (msg) => {
      if (msg) {
        try {
          await this.circuitBreaker.execute(async () => {
            await this.retryHandler.execute(async () => {
              const notification = JSON.parse(msg.content.toString());
              await this.processNotification(notification);
            }, { operation: 'processNotification' });
          }, { operation: 'notification_processing' });
          
          channel.ack(msg);
        } catch (error) {
          console.error('Error processing notification:', error);
          await this.deadLetterHandler.sendToDeadLetter(msg, error, 'notification.error');
          channel.nack(msg, false, false); // Reject and don't requeue
        }
      }
    });

    // Email processor
    await channel.consume(this.config.emailQueue, async (msg) => {
      if (msg) {
        try {
          await this.circuitBreaker.execute(async () => {
            await this.retryHandler.execute(async () => {
              const email = JSON.parse(msg.content.toString());
              await this.processEmail(email);
            }, { operation: 'processEmail' });
          }, { operation: 'email_processing' });
          
          channel.ack(msg);
        } catch (error) {
          console.error('Error processing email:', error);
          await this.deadLetterHandler.sendToDeadLetter(msg, error, 'email.error');
          channel.nack(msg, false, false); // Reject and don't requeue
        }
      }
    });

    // Leaderboard processor
    await channel.consume(this.config.leaderboardQueue, async (msg) => {
      if (msg) {
        try {
          await this.circuitBreaker.execute(async () => {
            await this.retryHandler.execute(async () => {
              const leaderboard = JSON.parse(msg.content.toString());
              await this.processLeaderboardUpdate(leaderboard);
            }, { operation: 'processLeaderboardUpdate' });
          }, { operation: 'leaderboard_processing' });
          
          channel.ack(msg);
        } catch (error) {
          console.error('Error processing leaderboard update:', error);
          await this.deadLetterHandler.sendToDeadLetter(msg, error, 'leaderboard.error');
          channel.nack(msg, false, false); // Reject and don't requeue
        }
      }
    });

    console.log('All message processors setup completed');
  }

  async processSubscriptionEvent(event) {
    console.log('Processing subscription event:', event.id, event.type);

    try {
      // Update analytics
      if (this.analyticsService) {
        await this.analyticsService.recordSubscriptionEvent(event);
      }

      // Send notification to creator
      if (this.notificationService) {
        await this.notificationService.sendCreatorNotification({
          type: 'subscription_update',
          creatorId: event.creatorId,
          data: {
            eventType: event.type,
            walletAddress: event.walletAddress,
            timestamp: event.timestamp,
          },
        });
      }

      // Send email notification
      if (this.emailService && event.type === 'subscribed') {
        await this.emailService.sendWelcomeEmail({
          to: event.walletAddress,
          creatorId: event.creatorId,
          timestamp: event.timestamp,
        });
      }
      // ── Protocol Enhancements Integration ──────────────────────────────────────
      
      // 1. Dunning Management (#143)
      if (event.type === 'PaymentFailedGracePeriodStarted') {
        await this.dunningService.handlePaymentFailed(event);
      } else if (event.type === 'SubscriptionBilled') {
        await this.dunningService.handleSubscriptionBilled(event);
      }

      // 2. PDF Invoice Generation (#144)
      if (event.type === 'SubscriptionBilled') {
        const invoiceData = {
          invoiceId: `INV-${Date.now()}`,
          creatorId: event.creatorId,
          walletAddress: event.walletAddress,
          amount: event.amount,
          currency: event.currency || 'XLM',
          timestamp: event.timestamp || new Date().toISOString(),
          transactionHash: event.transactionHash
        };
        const invoiceResult = await this.invoiceService.generateInvoice(invoiceData);
        
        // Add invoice URL to event for webhook
        event.invoiceUrl = invoiceResult.url;
      }

      // 3. Redis Caching Invalidation (#146)
      if (event.type === 'SubscriptionBilled' || event.type === 'SubscriptionCanceled') {
        if (this.analyticsService && this.analyticsService.invalidateAnalytics) {
          await this.analyticsService.invalidateAnalytics(event.creatorId);
        }
      }

      // 4. Webhook Dispatch with Privacy Scrubbing (#145)
      await this.webhookDispatcher.dispatch(
        event.creatorId,
        event.walletAddress,
        `subscription.${event.type.toLowerCase()}`,
        event
      );

      console.log(`Successfully processed subscription event: ${event.id}`);
    } catch (error) {
      console.error(`Failed to process subscription event ${event.id}:`, error);
      throw error;
    }
  }

  /**
   * Process notifications
   */
  async processNotification(notification) {
    console.log('Processing notification:', notification.id, notification.type);

    try {
      // Here you would integrate with your notification service
      // For now, we'll just log the notification
      console.log(`Notification for user ${notification.userId}:`, {
        title: notification.title,
        message: notification.message,
        type: notification.type,
      });

      // Store notification in database if needed
      // await this.storeNotification(notification);

      console.log(`Successfully processed notification: ${notification.id}`);
    } catch (error) {
      console.error(`Failed to process notification ${notification.id}:`, error);
      throw error;
    }
  }

  /**
   * Process email events
   */
  async processEmail(email) {
    console.log('Processing email:', email.id, email.type);

    try {
      // Here you would integrate with your email service (SendGrid, SES, etc.)
      // For now, we'll simulate email sending
      console.log(`Sending email to ${email.to}:`, {
        subject: email.subject,
        template: email.template,
        type: email.type,
      });

      // Simulate email sending delay
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log(`Successfully processed email: ${email.id}`);
    } catch (error) {
      console.error(`Failed to process email ${email.id}:`, error);
      throw error;
    }
  }

  /**
   * Process leaderboard updates
   */
  async processLeaderboardUpdate(leaderboard) {
    console.log('Processing leaderboard update:', leaderboard.id, leaderboard.type);

    try {
      // Update leaderboard rankings
      if (this.leaderboardService) {
        await this.leaderboardService.updateCreatorRanking({
          creatorId: leaderboard.creatorId,
          newCount: leaderboard.newCount,
          updateType: leaderboard.type,
          timestamp: leaderboard.timestamp,
        });
      }

      // Update cache for quick access
      // await this.updateLeaderboardCache(leaderboard);

      console.log(`Successfully processed leaderboard update: ${leaderboard.id}`);
    } catch (error) {
      console.error(`Failed to process leaderboard update ${leaderboard.id}:`, error);
      throw error;
    }
  }

  /**
   * Start the worker service
   */
  async start() {
    if (!this.isRunning) {
      await this.initialize();
    }
    console.log('BackgroundWorkerService started');
  }

  /**
   * Stop the worker service
   */
  async stop() {
    this.isRunning = false;
    if (this.rabbitmq) {
      await this.rabbitmq.close();
    }
    console.log('BackgroundWorkerService stopped');
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      connected: this.rabbitmq.isConnected,
      processors: Array.from(this.processors.keys()),
      circuitBreaker: this.circuitBreaker.getState(),
    };
  }
}

module.exports = { BackgroundWorkerService };
