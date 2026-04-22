/**
 * Soroban Event Publisher Service
 * Integrates with the existing RabbitMQ Pub/Sub system to notify webhook dispatchers and analytics engines
 */
class SorobanEventPublisher {
  constructor(rabbitmqConnection, logger = console) {
    this.rabbitmq = rabbitmqConnection;
    this.logger = logger;
    this.channel = null;
    this.isInitialized = false;
    
    // Exchange and routing configuration
    this.exchangeName = 'soroban_events';
    this.routingKeys = {
      subscriptionBilled: 'soroban.subscription.billed',
      trialStarted: 'soroban.trial.started',
      paymentFailed: 'soroban.payment.failed',
      generic: 'soroban.event.generic'
    };
  }

  /**
   * Initialize the publisher
   */
  async initialize() {
    try {
      if (!this.rabbitmq.isConnected) {
        throw new Error('RabbitMQ connection is not established');
      }

      this.channel = await this.rabbitmq.getChannel();
      
      // Declare the exchange
      await this.channel.assertExchange(this.exchangeName, 'topic', { durable: true });
      
      this.isInitialized = true;
      this.logger.info('Soroban event publisher initialized', {
        exchange: this.exchangeName
      });
    } catch (error) {
      this.logger.error('Failed to initialize Soroban event publisher', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Publish a Soroban event to the appropriate queue
   */
  async publish(eventType, eventData) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Determine routing key based on event type
      const routingKey = this.getRoutingKey(eventType);
      
      // Prepare the message payload
      const payload = {
        ...eventData,
        publishedAt: new Date().toISOString(),
        publisher: 'soroban-event-indexer'
      };

      // Publish to RabbitMQ
      const published = this.channel.publish(
        this.exchangeName,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          persistent: true, // Make message durable
          messageId: eventData.id,
          timestamp: Date.now(),
          headers: {
            eventType,
            source: 'soroban-indexer',
            contractId: eventData.contractId
          }
        }
      );

      if (published) {
        this.logger.debug('Event published successfully', {
          eventId: eventData.id,
          eventType,
          routingKey
        });
      } else {
        this.logger.warn('Failed to publish event - channel full', {
          eventId: eventData.id,
          eventType
        });
        throw new Error('Failed to publish event - channel full');
      }

    } catch (error) {
      this.logger.error('Failed to publish Soroban event', {
        eventId: eventData.id,
        eventType,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get routing key for event type
   */
  getRoutingKey(eventType) {
    switch (eventType) {
      case 'SubscriptionBilled':
        return this.routingKeys.subscriptionBilled;
      case 'TrialStarted':
        return this.routingKeys.trialStarted;
      case 'PaymentFailed':
        return this.routingKeys.paymentFailed;
      default:
        return this.routingKeys.generic;
    }
  }

  /**
   * Publish subscription billed event with specific formatting
   */
  async publishSubscriptionBilled(eventData) {
    const formattedEvent = {
      type: 'subscription_billed',
      source: 'soroban',
      data: {
        subscriberAddress: eventData.data.subscriberAddress,
        creatorAddress: eventData.data.creatorAddress,
        amount: eventData.data.amount,
        currency: eventData.data.currency,
        billingPeriod: eventData.data.billingPeriod,
        nextBillingDate: eventData.data.nextBillingDate,
        subscriptionId: eventData.data.subscriptionId,
        metadata: eventData.data.metadata
      },
      blockchain: {
        transactionHash: eventData.transactionHash,
        ledgerSequence: eventData.ledgerSequence,
        ledgerTimestamp: eventData.ledgerTimestamp,
        contractId: eventData.contractId
      }
    };

    await this.publish('SubscriptionBilled', formattedEvent);
  }

  /**
   * Publish trial started event with specific formatting
   */
  async publishTrialStarted(eventData) {
    const formattedEvent = {
      type: 'trial_started',
      source: 'soroban',
      data: {
        subscriberAddress: eventData.data.subscriberAddress,
        creatorAddress: eventData.data.creatorAddress,
        trialDuration: eventData.data.trialDuration,
        trialEndDate: eventData.data.trialEndDate,
        subscriptionId: eventData.data.subscriptionId,
        metadata: eventData.data.metadata
      },
      blockchain: {
        transactionHash: eventData.transactionHash,
        ledgerSequence: eventData.ledgerSequence,
        ledgerTimestamp: eventData.ledgerTimestamp,
        contractId: eventData.contractId
      }
    };

    await this.publish('TrialStarted', formattedEvent);
  }

  /**
   * Publish payment failed event with specific formatting
   */
  async publishPaymentFailed(eventData) {
    const formattedEvent = {
      type: 'payment_failed',
      source: 'soroban',
      data: {
        subscriberAddress: eventData.data.subscriberAddress,
        creatorAddress: eventData.data.creatorAddress,
        amount: eventData.data.amount,
        currency: eventData.data.currency,
        reason: eventData.data.reason,
        retryCount: eventData.data.retryCount,
        nextRetryDate: eventData.data.nextRetryDate,
        subscriptionId: eventData.data.subscriptionId,
        metadata: eventData.data.metadata
      },
      blockchain: {
        transactionHash: eventData.transactionHash,
        ledgerSequence: eventData.ledgerSequence,
        ledgerTimestamp: eventData.ledgerTimestamp,
        contractId: eventData.contractId
      }
    };

    await this.publish('PaymentFailed', formattedEvent);
  }

  /**
   * Publish analytics event for monitoring
   */
  async publishAnalyticsEvent(eventData, action = 'processed') {
    const analyticsEvent = {
      type: 'soroban_analytics',
      action,
      data: {
        eventType: eventData.type,
        contractId: eventData.contractId,
        transactionHash: eventData.transactionHash,
        ledgerSequence: eventData.ledgerSequence,
        processingTime: Date.now() - new Date(eventData.ledgerTimestamp).getTime()
      },
      timestamp: new Date().toISOString()
    };

    await this.publish('analytics', analyticsEvent);
  }

  /**
   * Batch publish multiple events
   */
  async publishBatch(events) {
    const results = [];
    
    for (const event of events) {
      try {
        await this.publish(event.type, event);
        results.push({ eventId: event.id, success: true });
      } catch (error) {
        results.push({ 
          eventId: event.id, 
          success: false, 
          error: error.message 
        });
      }
    }

    return results;
  }

  /**
   * Close the publisher
   */
  async close() {
    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }
    this.isInitialized = false;
    this.logger.info('Soroban event publisher closed');
  }

  /**
   * Get publisher status
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      exchangeName: this.exchangeName,
      hasChannel: !!this.channel,
      rabbitmqConnected: this.rabbitmq.isConnected
    };
  }
}

module.exports = { SorobanEventPublisher };
