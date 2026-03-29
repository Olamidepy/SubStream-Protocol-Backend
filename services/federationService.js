const ActivityPubService = require('./activityPubService');
const { logger } = require('../utils/logger');

/**
 * Federation Service - Handles automatic content federation to Fediverse
 * Integrates with content creation to automatically send announcements
 */
class FederationService {
  constructor(config, database, backgroundWorker) {
    this.config = config;
    this.database = database;
    this.backgroundWorker = backgroundWorker;
    this.activityPubService = new ActivityPubService(config, database);
    this.enabled = config.activityPub?.enabled !== false;
  }

  /**
   * Initialize federation for a creator
   */
  async initializeCreator(creatorAddress) {
    if (!this.enabled) {
      logger.info('ActivityPub federation disabled, skipping initialization');
      return null;
    }

    try {
      // Check if already initialized
      const existing = this.database.db.prepare(`
        SELECT * FROM activitypub_actors WHERE creator_address = ?
      `).get(creatorAddress);

      if (existing) {
        logger.info('Creator already has ActivityPub actor', { creatorAddress });
        return existing;
      }

      // Get creator info
      const creator = this.database.getCreator(creatorAddress);
      if (!creator) {
        throw new Error('Creator not found');
      }

      // Generate key pair
      const { publicKey, privateKey } = this.activityPubService.getCreatorKeyPair(creatorAddress);
      const actorId = this.activityPubService.generateActorId(creatorAddress);

      // Create actor profile
      const actorProfile = this.activityPubService.generateActorProfile(creator);

      // Store in database
      const result = this.database.db.prepare(`
        INSERT INTO activitypub_actors (
          creator_address, public_key, private_key, actor_id,
          inbox_url, outbox_url, followers_url, following_url,
          federation_enabled, actor_profile
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        creatorAddress,
        publicKey,
        privateKey,
        actorId,
        `${actorId}/inbox`,
        `${actorId}/outbox`,
        `${actorId}/followers`,
        `${actorId}/following`,
        true,
        JSON.stringify(actorProfile)
      );

      logger.info('ActivityPub actor created', { 
        creatorAddress, 
        actorId,
        actorId: result.lastInsertRowid 
      });

      return { ...existing, id: result.lastInsertRowid };
    } catch (error) {
      logger.error('Failed to initialize ActivityPub actor', { 
        error: error.message, 
        creatorAddress 
      });
      throw error;
    }
  }

  /**
   * Queue content for federation
   */
  async queueContentForFederation(content) {
    if (!this.enabled) {
      logger.info('ActivityPub federation disabled, skipping federation');
      return null;
    }

    try {
      // Check if creator has federation enabled
      const actor = this.database.db.prepare(`
        SELECT * FROM activitypub_actors 
        WHERE creator_address = ? AND federation_enabled = true
      `).get(content.creator_address);

      if (!actor) {
        logger.info('Creator does not have federation enabled', { 
          creatorAddress: content.creator_address 
        });
        return null;
      }

      // Check if already queued
      const existing = this.database.db.prepare(`
        SELECT * FROM federation_queue 
        WHERE creator_address = ? AND content_id = ? AND status != 'failed'
      `).get(content.creator_address, content.id);

      if (existing) {
        logger.info('Content already queued for federation', { 
          contentId: content.id,
          creatorAddress: content.creator_address 
        });
        return existing;
      }

      // Generate activity data
      const creator = this.database.getCreator(content.creator_address);
      const announcement = this.activityPubService.createContentAnnouncement(creator, content);

      // Queue for background processing
      const result = this.database.db.prepare(`
        INSERT INTO federation_queue (
          creator_address, content_id, activity_type, activity_data
        ) VALUES (?, ?, ?, ?)
      `).run(
        content.creator_address,
        content.id,
        'Announce',
        JSON.stringify(announcement)
      );

      logger.info('Content queued for federation', { 
        contentId: content.id,
        creatorAddress: content.creator_address,
        queueId: result.lastInsertRowid 
      });

      // Queue background job if available
      if (this.backgroundWorker) {
        await this.queueFederationJob(result.lastInsertRowid);
      }

      return { ...existing, id: result.lastInsertRowid };
    } catch (error) {
      logger.error('Failed to queue content for federation', { 
        error: error.message, 
        contentId: content.id 
      });
      throw error;
    }
  }

  /**
   * Process federation queue
   */
  async processFederationQueue() {
    if (!this.enabled) {
      return;
    }

    try {
      // Get pending items
      const pendingItems = this.database.db.prepare(`
        SELECT * FROM federation_queue 
        WHERE status = 'pending' 
        ORDER BY scheduled_at ASC 
        LIMIT 10
      `).all();

      logger.info('Processing federation queue', { 
        pendingCount: pendingItems.length 
      });

      for (const item of pendingItems) {
        await this.processFederationItem(item);
      }
    } catch (error) {
      logger.error('Failed to process federation queue', { 
        error: error.message 
      });
    }
  }

  /**
   * Process individual federation item
   */
  async processFederationItem(item) {
    try {
      // Mark as processing
      this.database.db.prepare(`
        UPDATE federation_queue 
        SET status = 'processing' 
        WHERE id = ?
      `).run(item.id);

      const activityData = JSON.parse(item.activity_data);
      const creator = this.database.getCreator(item.creator_address);

      // Send to followers
      const result = await this.activityPubService.federateContent(creator, {
        id: item.content_id,
        ...JSON.parse(activityData.object || '{}')
      });

      // Mark as completed
      this.database.db.prepare(`
        UPDATE federation_queue 
        SET status = 'completed', processed_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(item.id);

      // Log activity
      this.database.db.prepare(`
        INSERT INTO activitypub_activities (
          creator_address, activity_id, activity_type, object_type,
          object_id, activity_data, status, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.creator_address,
        activityData.id,
        item.activity_type,
        activityData.object?.type || 'Note',
        item.content_id,
        item.activity_data,
        result.failed > 0 ? 'partial' : 'sent',
        new Date().toISOString()
      );

      logger.info('Federation item processed', { 
        queueId: item.id,
        contentId: item.content_id,
        result 
      });

    } catch (error) {
      // Mark as failed and increment retry count
      const retryCount = item.retry_count + 1;
      const maxRetries = 3;
      
      if (retryCount >= maxRetries) {
        this.database.db.prepare(`
          UPDATE federation_queue 
          SET status = 'failed', retry_count = ?, error_message = ? 
          WHERE id = ?
        `).run(item.id, retryCount, error.message);
      } else {
        // Schedule for retry with exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, retryCount), 300000); // Max 5 minutes
        const scheduledAt = new Date(Date.now() + delayMs);
        
        this.database.db.prepare(`
          UPDATE federation_queue 
          SET status = 'pending', retry_count = ?, scheduled_at = ?, error_message = ? 
          WHERE id = ?
        `).run(item.id, retryCount, scheduledAt.toISOString(), error.message);
      }

      logger.error('Failed to process federation item', { 
        queueId: item.id,
        error: error.message,
        retryCount 
      });
    }
  }

  /**
   * Queue federation job in background worker
   */
  async queueFederationJob(queueId) {
    try {
      await this.backgroundWorker.publish('federation', {
        type: 'process_federation',
        data: { queueId },
        priority: 'normal',
        delay: 0
      });

      logger.info('Federation job queued', { queueId });
    } catch (error) {
      logger.error('Failed to queue federation job', { 
        error: error.message, 
        queueId 
      });
    }
  }

  /**
   * Handle incoming follow request
   */
  async handleFollow(followerActor, creatorAddress, followActivity) {
    try {
      // Store follower
      this.database.db.prepare(`
        INSERT OR REPLACE INTO activitypub_followers (
          creator_address, follower_actor, follower_inbox, 
          follower_shared_inbox, follow_activity_id, follower_data
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        creatorAddress,
        followerActor,
        followActivity.inbox || '',
        followActivity.sharedInbox || '',
        followActivity.id,
        JSON.stringify(followerActor)
      );

      logger.info('Follower added', { 
        followerActor, 
        creatorAddress 
      });

      return true;
    } catch (error) {
      logger.error('Failed to handle follow', { 
        error: error.message, 
        followerActor, 
        creatorAddress 
      });
      return false;
    }
  }

  /**
   * Handle unfollow
   */
  async handleUnfollow(followerActor, creatorAddress) {
    try {
      const result = this.database.db.prepare(`
        DELETE FROM activitypub_followers 
        WHERE creator_address = ? AND follower_actor = ?
      `).run(creatorAddress, followerActor);

      logger.info('Follower removed', { 
        followerActor, 
        creatorAddress,
        deleted: result.changes 
      });

      return result.changes > 0;
    } catch (error) {
      logger.error('Failed to handle unfollow', { 
        error: error.message, 
        followerActor, 
        creatorAddress 
      });
      return false;
    }
  }

  /**
   * Get federation statistics
   */
  async getFederationStats(creatorAddress) {
    try {
      const stats = this.database.db.prepare(`
        SELECT 
          COUNT(*) as total_activities,
          COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful_activities,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_activities,
          COUNT(*) as followers
        FROM activitypub_activities a
        LEFT JOIN activitypub_followers f ON a.creator_address = f.creator_address
        WHERE a.creator_address = ?
      `).get(creatorAddress);

      return stats;
    } catch (error) {
      logger.error('Failed to get federation stats', { 
        error: error.message, 
        creatorAddress 
      });
      return null;
    }
  }

  /**
   * Enable/disable federation for creator
   */
  async toggleFederation(creatorAddress, enabled) {
    try {
      const result = this.database.db.prepare(`
        UPDATE activitypub_actors 
        SET federation_enabled = ? 
        WHERE creator_address = ?
      `).run(enabled, creatorAddress);

      logger.info('Federation toggled', { 
        creatorAddress, 
        enabled,
        updated: result.changes 
      });

      return result.changes > 0;
    } catch (error) {
      logger.error('Failed to toggle federation', { 
        error: error.message, 
        creatorAddress, 
        enabled 
      });
      return false;
    }
  }
}

module.exports = FederationService;
