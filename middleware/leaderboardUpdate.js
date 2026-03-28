const { logger } = require('../utils/logger');

/**
 * Leaderboard Update Middleware
 * Automatically triggers leaderboard updates when engagement events occur
 */
class LeaderboardUpdateMiddleware {
  constructor(leaderboardService, database) {
    this.leaderboardService = leaderboardService;
    this.database = database;
  }

  /**
   * Middleware to handle streaming payment events
   */
  async handleStreamingPayment(paymentData) {
    try {
      const { creatorAddress, fanAddress, amount } = paymentData;
      
      logger.info('Processing streaming payment for leaderboard', {
        creatorAddress,
        fanAddress,
        amount
      });

      // Invalidate cache for the creator's current leaderboard
      await this.leaderboardService.invalidateCache(creatorAddress);
      
      // Optionally update engagement summary immediately for real-time updates
      await this.updateEngagementSummary(creatorAddress, fanAddress);

      logger.debug('Leaderboard updated for streaming payment', {
        creatorAddress,
        fanAddress
      });
    } catch (error) {
      logger.error('Failed to update leaderboard for streaming payment', {
        error: error.message,
        paymentData
      });
    }
  }

  /**
   * Middleware to handle subscription events
   */
  async handleSubscriptionChange(subscriptionData) {
    try {
      const { creatorId, walletAddress, active, eventType } = subscriptionData;
      
      logger.info('Processing subscription change for leaderboard', {
        creatorId,
        walletAddress,
        active,
        eventType
      });

      // Invalidate cache for the creator's current leaderboard
      await this.leaderboardService.invalidateCache(creatorId);
      
      // Update engagement summary
      await this.updateEngagementSummary(creatorId, walletAddress);

      logger.debug('Leaderboard updated for subscription change', {
        creatorId,
        walletAddress
      });
    } catch (error) {
      logger.error('Failed to update leaderboard for subscription change', {
        error: error.message,
        subscriptionData
      });
    }
  }

  /**
   * Middleware to handle comment events
   */
  async handleComment(commentData) {
    try {
      const { creatorId, userAddress, content } = commentData;
      
      logger.info('Processing comment for leaderboard', {
        creatorId,
        userAddress
      });

      // Invalidate cache for the creator's current leaderboard
      await this.leaderboardService.invalidateCache(creatorId);
      
      // Update engagement summary
      await this.updateEngagementSummary(creatorId, userAddress);

      logger.debug('Leaderboard updated for comment', {
        creatorId,
        userAddress
      });
    } catch (error) {
      logger.error('Failed to update leaderboard for comment', {
        error: error.message,
        commentData
      });
    }
  }

  /**
   * Middleware to handle like events
   */
  async handleLike(likeData) {
    try {
      const { creatorAddress, fanAddress, contentId } = likeData;
      
      logger.info('Processing like for leaderboard', {
        creatorAddress,
        fanAddress,
        contentId
      });

      // Invalidate cache for the creator's current leaderboard
      await this.leaderboardService.invalidateCache(creatorAddress);
      
      // Update engagement summary
      await this.updateEngagementSummary(creatorAddress, fanAddress);

      logger.debug('Leaderboard updated for like', {
        creatorAddress,
        fanAddress
      });
    } catch (error) {
      logger.error('Failed to update leaderboard for like', {
        error: error.message,
        likeData
      });
    }
  }

  /**
   * Update engagement summary for immediate real-time updates
   */
  async updateEngagementSummary(creatorAddress, fanAddress) {
    try {
      const currentSeason = this.leaderboardService.getCurrentSeason();
      const startDate = this.leaderboardService.getSeasonStartDate();
      const endDate = new Date();

      // Get current metrics
      const [streaming, subscription, engagement] = await Promise.all([
        this.leaderboardService.getStreamingMetrics(creatorAddress, fanAddress, startDate, endDate),
        this.leaderboardService.getSubscriptionMetrics(creatorAddress, fanAddress, startDate, endDate),
        this.leaderboardService.getEngagementMetrics(creatorAddress, fanAddress, startDate, endDate)
      ]);

      // Calculate scores
      const streamingScore = this.leaderboardService.normalizeStreamingScore(streaming);
      const subscriptionScore = this.leaderboardService.normalizeSubscriptionScore(subscription);
      const engagementScore = this.leaderboardService.normalizeEngagementScore(engagement);
      const compositeScore = 
        (streamingScore * this.leaderboardService.weights.streamingAmount) +
        (subscriptionScore * this.leaderboardService.weights.subscriptionLength) +
        (engagementScore * this.leaderboardService.weights.engagementCount);

      // Update or insert engagement summary
      const upsertQuery = `
        INSERT OR REPLACE INTO fan_engagement_summary (
          creator_address, fan_address, season,
          total_streaming_amount, streaming_transaction_count, streaming_days,
          subscription_days, current_streak, subscription_active,
          comment_count, like_count, share_count, total_engagement,
          streaming_score, subscription_score, engagement_score, composite_score,
          last_calculated, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.database.db.prepare(upsertQuery).run(
        creatorAddress,
        fanAddress,
        currentSeason,
        streaming.totalAmount,
        streaming.transactionCount,
        streaming.streamingDays,
        subscription.longevityDays,
        subscription.currentStreak,
        subscription.currentActive,
        engagement.commentCount,
        engagement.likeCount,
        engagement.shareCount,
        engagement.totalEngagement,
        streamingScore,
        subscriptionScore,
        engagementScore,
        compositeScore,
        new Date().toISOString(),
        new Date().toISOString()
      );

      logger.debug('Engagement summary updated', {
        creatorAddress,
        fanAddress,
        season: currentSeason,
        compositeScore
      });
    } catch (error) {
      logger.error('Failed to update engagement summary', {
        error: error.message,
        creatorAddress,
        fanAddress
      });
    }
  }

  /**
   * Create leaderboard snapshot for historical tracking
   */
  async createSnapshot(creatorAddress, season = null) {
    try {
      const targetSeason = season || this.leaderboardService.getCurrentSeason();
      
      logger.info('Creating leaderboard snapshot', {
        creatorAddress,
        season: targetSeason
      });

      // Get current leaderboard
      const leaderboard = await this.leaderboardService.generateLeaderboard(
        creatorAddress, 
        targetSeason, 
        1000
      );

      // Clear existing snapshots for this season
      this.database.db.prepare(`
        DELETE FROM leaderboard_snapshots 
        WHERE creator_address = ? AND season = ?
      `).run(creatorAddress, targetSeason);

      // Insert new snapshots
      const insertQuery = `
        INSERT INTO leaderboard_snapshots (
          creator_address, fan_address, season, rank, score, metrics, calculated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      const stmt = this.database.db.prepare(insertQuery);
      
      for (const entry of leaderboard) {
        stmt.run(
          creatorAddress,
          entry.fanAddress,
          targetSeason,
          entry.rank,
          entry.score,
          JSON.stringify(entry.metrics),
          new Date().toISOString()
        );
      }

      logger.info('Leaderboard snapshot created', {
        creatorAddress,
        season: targetSeason,
        entryCount: leaderboard.length
      });

      return leaderboard.length;
    } catch (error) {
      logger.error('Failed to create leaderboard snapshot', {
        error: error.message,
        creatorAddress,
        season
      });
      throw error;
    }
  }

  /**
   * Get leaderboard rank changes between seasons
   */
  async getRankChanges(creatorAddress, fanAddress, fromSeason, toSeason) {
    try {
      const query = `
        SELECT 
          season,
          rank,
          score,
          calculated_at
        FROM leaderboard_snapshots 
        WHERE creator_address = ? AND fan_address = ? AND season IN (?, ?)
        ORDER BY season DESC
      `;

      const results = this.database.db.prepare(query).all(
        creatorAddress, 
        fanAddress, 
        fromSeason, 
        toSeason
      );

      if (results.length < 2) {
        return null;
      }

      const [current, previous] = results;
      const rankChange = previous.rank - current.rank; // Positive = moved up
      const scoreChange = current.score - previous.score;

      return {
        fanAddress,
        creatorAddress,
        fromSeason: previous.season,
        toSeason: current.season,
        previousRank: previous.rank,
        currentRank: current.rank,
        rankChange,
        previousScore: previous.score,
        currentScore: current.score,
        scoreChange,
        lastUpdated: current.calculated_at
      };
    } catch (error) {
      logger.error('Failed to get rank changes', {
        error: error.message,
        creatorAddress,
        fanAddress,
        fromSeason,
        toSeason
      });
      return null;
    }
  }

  /**
   * Batch update multiple creators' leaderboards
   */
  async batchUpdateLeaderboards(creatorAddresses) {
    try {
      logger.info('Starting batch leaderboard update', {
        creatorCount: creatorAddresses.length
      });

      const results = [];
      for (const creatorAddress of creatorAddresses) {
        try {
          await this.leaderboardService.invalidateCache(creatorAddress);
          results.push({ creatorAddress, success: true });
        } catch (error) {
          logger.error('Failed to update creator leaderboard in batch', {
            error: error.message,
            creatorAddress
          });
          results.push({ creatorAddress, success: false, error: error.message });
        }
      }

      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('Batch leaderboard update completed', {
        total: creatorAddresses.length,
        successful,
        failed
      });

      return results;
    } catch (error) {
      logger.error('Batch leaderboard update failed', {
        error: error.message,
        creatorCount: creatorAddresses.length
      });
      throw error;
    }
  }

  /**
   * Express middleware for automatic leaderboard updates
   */
  expressMiddleware() {
    return (req, res, next) => {
      // Store the middleware function on the request for later use
      req.updateLeaderboard = async (eventType, data) => {
        switch (eventType) {
          case 'streaming_payment':
            await this.handleStreamingPayment(data);
            break;
          case 'subscription_change':
            await this.handleSubscriptionChange(data);
            break;
          case 'comment':
            await this.handleComment(data);
            break;
          case 'like':
            await this.handleLike(data);
            break;
          default:
            logger.warn('Unknown leaderboard update event type', { eventType });
        }
      };

      next();
    };
  }
}

module.exports = LeaderboardUpdateMiddleware;
