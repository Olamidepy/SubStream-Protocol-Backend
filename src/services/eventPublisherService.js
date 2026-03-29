const { RabbitMQConnection } = require('../config/rabbitmq');

/**
 * Event publisher service for sending asynchronous events to RabbitMQ
 */
class EventPublisherService {
  constructor(config) {
    this.config = config;
    this.rabbitmq = new RabbitMQConnection(config);
    this.isInitialized = false;
  }

  /**
   * Initialize the event publisher
   */
  async initialize() {
    try {
      await this.rabbitmq.connect();
      await this.rabbitmq.setupTopology();
      this.isInitialized = true;
      console.log('EventPublisherService initialized successfully');
    } catch (error) {
      console.error('Failed to initialize EventPublisherService:', error);
      throw error;
    }
  }

  /**
   * Publish a subscription event
   * @param {Object} event - The event data
   * @param {string} event.type - Event type (subscribed, unsubscribed, expired)
   * @param {string} event.creatorId - Creator ID
   * @param {string} event.walletAddress - Wallet address
   * @param {string} event.timestamp - Event timestamp
   * @param {string} event.ipAddress - IP address
   */
  async publishSubscriptionEvent(event) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const channel = await this.rabbitmq.getChannel();
      const routingKey = `subscription.${event.type}`;
      
      const message = {
        id: this.generateEventId(),
        type: event.type,
        creatorId: event.creatorId,
        walletAddress: event.walletAddress,
        timestamp: event.timestamp || new Date().toISOString(),
        ipAddress: event.ipAddress || 'system',
        metadata: event.metadata || {},
      };

      const published = channel.publish(
        this.config.eventExchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId: message.id,
          timestamp: Date.now(),
          headers: {
            eventType: 'subscription',
            source: 'substream-backend',
          },
        }
      );

      if (published) {
        console.log(`Published subscription event: ${routingKey}`, message.id);
      } else {
        console.warn(`Failed to publish subscription event: ${routingKey}`);
      }

      return { success: published, eventId: message.id };
    } catch (error) {
      console.error('Error publishing subscription event:', error);
      throw error;
    }
  }

  /**
   * Publish a notification event
   * @param {Object} notification - The notification data
   * @param {string} notification.type - Notification type
   * @param {string} notification.userId - User ID
   * @param {string} notification.title - Notification title
   * @param {string} notification.message - Notification message
   * @param {Object} notification.data - Additional data
   */
  async publishNotificationEvent(notification) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const channel = await this.rabbitmq.getChannel();
      const routingKey = `notification.${notification.type}`;
      
      const message = {
        id: this.generateEventId(),
        type: notification.type,
        userId: notification.userId,
        title: notification.title,
        message: notification.message,
        data: notification.data || {},
        timestamp: new Date().toISOString(),
        metadata: notification.metadata || {},
      };

      const published = channel.publish(
        this.config.eventExchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId: message.id,
          timestamp: Date.now(),
          headers: {
            eventType: 'notification',
            source: 'substream-backend',
          },
        }
      );

      if (published) {
        console.log(`Published notification event: ${routingKey}`, message.id);
      } else {
        console.warn(`Failed to publish notification event: ${routingKey}`);
      }

      return { success: published, eventId: message.id };
    } catch (error) {
      console.error('Error publishing notification event:', error);
      throw error;
    }
  }

  /**
   * Publish an email event
   * @param {Object} email - The email data
   * @param {string} email.type - Email type
   * @param {string} email.to - Recipient email
   * @param {string} email.subject - Email subject
   * @param {string} email.template - Email template
   * @param {Object} email.data - Template data
   */
  async publishEmailEvent(email) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const channel = await this.rabbitmq.getChannel();
      const routingKey = `email.${email.type}`;
      
      const message = {
        id: this.generateEventId(),
        type: email.type,
        to: email.to,
        subject: email.subject,
        template: email.template,
        data: email.data || {},
        timestamp: new Date().toISOString(),
        metadata: email.metadata || {},
      };

      const published = channel.publish(
        this.config.eventExchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId: message.id,
          timestamp: Date.now(),
          headers: {
            eventType: 'email',
            source: 'substream-backend',
          },
        }
      );

      if (published) {
        console.log(`Published email event: ${routingKey}`, message.id);
      } else {
        console.warn(`Failed to publish email event: ${routingKey}`);
      }

      return { success: published, eventId: message.id };
    } catch (error) {
      console.error('Error publishing email event:', error);
      throw error;
    }
  }

  /**
   * Publish a leaderboard update event
   * @param {Object} leaderboard - The leaderboard data
   * @param {string} leaderboard.type - Update type
   * @param {string} leaderboard.creatorId - Creator ID
   * @param {number} leaderboard.newCount - New subscriber count
   * @param {Object} leaderboard.metadata - Additional metadata
   */
  async publishLeaderboardEvent(leaderboard) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const channel = await this.rabbitmq.getChannel();
      const routingKey = `leaderboard.${leaderboard.type}`;
      
      const message = {
        id: this.generateEventId(),
        type: leaderboard.type,
        creatorId: leaderboard.creatorId,
        newCount: leaderboard.newCount,
        timestamp: new Date().toISOString(),
        metadata: leaderboard.metadata || {},
      };

      const published = channel.publish(
        this.config.eventExchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId: message.id,
          timestamp: Date.now(),
          headers: {
            eventType: 'leaderboard',
            source: 'substream-backend',
          },
        }
      );

      if (published) {
        console.log(`Published leaderboard event: ${routingKey}`, message.id);
      } else {
        console.warn(`Failed to publish leaderboard event: ${routingKey}`);
      }

      return { success: published, eventId: message.id };
    } catch (error) {
      console.error('Error publishing leaderboard event:', error);
      throw error;
    }
  }

  /**
   * Generate a unique event ID
   */
  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Close the connection
   */
  async close() {
    if (this.rabbitmq) {
      await this.rabbitmq.close();
    }
  }
}

module.exports = { EventPublisherService };
