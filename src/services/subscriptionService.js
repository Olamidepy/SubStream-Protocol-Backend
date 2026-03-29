const EventEmitter = require('events');
const { EventPublisherService } = require('./eventPublisherService');

/**
 * SubscriptionService maintains cached subscriber counts and handles
 * subscription events (subscribed, unsubscribed, expired).
 */
class SubscriptionService extends EventEmitter {
  /**
   * @param {{database: import('../db/appDatabase').AppDatabase, auditLogService?: any, config?: any}} options
   */
  /**
   * @param {{database: import('../db/appDatabase').AppDatabase, auditLogService?: any, notificationService?: any, emailUtil?: any}} options
   */
  constructor({ database, auditLogService, notificationService, emailUtil } = {}) {
  constructor({ database, auditLogService, config } = {}) {
    super();
    if (!database) throw new Error('database is required');
    this.database = database;
    this.auditLogService = auditLogService || null;
    this.notificationService = notificationService || null;
    this.emailUtil = emailUtil || null;
    this.config = config;
    this.eventPublisher = config ? new EventPublisherService(config.rabbitmq) : null;
  }

  /**
   * Handle an incoming subscription event.
   * Event shape: { type: 'subscribed'|'unsubscribed'|'expired', creatorId: string, walletAddress?: string, timestamp?: string }
   */
  async handleEvent(event) {
    if (!event || !event.type || !event.creatorId) {
      throw new Error('Invalid subscription event');
    }

    const creatorId = String(event.creatorId);
    const type = String(event.type).toLowerCase();

    let newCount;

    switch (type) {
      case 'subscribed':
        if (event.walletAddress) {
          const result = this.database.createOrActivateSubscription(creatorId, String(event.walletAddress));
          newCount = result.count;
          if (result.changed) this.emit('subscribed', { creatorId, newCount, walletAddress: event.walletAddress });

          // Notify creator (in-app notification)
          if (this.notificationService) {
            this.notificationService.addNotification(creatorId, {
              type: 'new_fan',
              message: `You have a new subscriber! (Tier: Gold)`,
              metadata: { walletAddress: event.walletAddress, tier: 'gold' },
              timestamp: event.timestamp || new Date().toISOString(),
            });
          }

          // Email notification
          if (this.emailUtil) {
            // Lookup creator email (stub: use creatorId as email for demo)
            const to = creatorId.includes('@') ? creatorId : `${creatorId}@example.com`;
            this.emailUtil.sendEmail({
              to,
              subject: 'New Subscriber! (Tier: Gold)',
              text: `Congratulations! You have a new Gold tier subscriber.`,
            }).catch(() => {}); // Don't block on email errors
          }
        } else {
          // fallback to simple increment if wallet address not provided
          newCount = this.database.incrementCreatorSubscriberCount(creatorId);
          this.emit('subscribed', { creatorId, newCount, walletAddress: null });
        }
        break;
      case 'unsubscribed':
      case 'expired':
        if (event.walletAddress) {
          const result = this.database.deactivateSubscription(creatorId, String(event.walletAddress));
          newCount = result.count;
          if (result.changed) this.emit('unsubscribed', { creatorId, newCount, walletAddress: event.walletAddress });
        } else {
          // fallback to simple decrement
          newCount = this.database.decrementCreatorSubscriberCount(creatorId);
          this.emit('unsubscribed', { creatorId, newCount, walletAddress: null });
        }
        break;
      default:
        throw new Error(`Unsupported subscription event type: ${event.type}`);
    }

    // Optionally append an audit log if service provided
    try {
      if (this.auditLogService && typeof this.auditLogService.append === 'function') {
        const timestamp = event.timestamp || new Date().toISOString();
        const action = type === 'subscribed' ? 'SUBSCRIBER_ADDED' : 'SUBSCRIBER_REMOVED';

        this.auditLogService.append({
          creatorId,
          actionType: action,
          entityType: 'subscription',
          entityId: event.walletAddress || 'unknown',
          timestamp,
          ipAddress: event.ipAddress || 'system',
          metadata: { walletAddress: event.walletAddress || null, resulting_count: newCount },
        });
      }
    } catch (err) {
      // Audit failures should not block subscription processing
      // eslint-disable-next-line no-console
      console.warn('Failed to append subscription audit log:', err && err.message);
    }

    // Publish async event to RabbitMQ for background processing
    try {
      if (this.eventPublisher) {
        await this.eventPublisher.publishSubscriptionEvent({
          type,
          creatorId,
          walletAddress: event.walletAddress,
          timestamp: event.timestamp || new Date().toISOString(),
          ipAddress: event.ipAddress,
          metadata: { newCount },
        });
      }
    } catch (err) {
      // Event publishing failures should not block subscription processing
      // eslint-disable-next-line no-console
      console.warn('Failed to publish subscription event:', err && err.message);
    }

    return { creatorId, newCount };
  }
}

module.exports = {
  SubscriptionService,
};
