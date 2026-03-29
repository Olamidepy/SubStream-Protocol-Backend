const { logger } = require('../utils/logger');

/**
 * Engagement Leaderboard Service
 * Calculates and caches "Top Fans" leaderboards based on composite engagement scores
 */
class EngagementLeaderboardService {
  constructor(config, database, redisClient) {
    this.config = config;
    this.database = database;
    this.redis = redisClient;
    
    // Scoring weights (configurable)
    this.weights = {
      streamingAmount: 0.4,      // 40% weight for total streaming amount
      subscriptionLength: 0.3,   // 30% weight for subscription longevity
      engagementCount: 0.3       // 30% weight for comments/likes
    };
    
    // Cache configuration
    this.cacheTTL = config.leaderboard?.cacheTTL || 21600; // 6 hours in seconds
    this.prefix = config.leaderboard?.cachePrefix || 'leaderboard:';
    
    // Season configuration
    this.seasonLength = config.leaderboard?.seasonLength || 'monthly'; // monthly, quarterly, yearly
  }

  /**
   * Calculate composite engagement score for a user
   * @param {string} creatorAddress Creator wallet address
   * @param {string} fanAddress Fan wallet address
   * @param {string} season Season identifier (optional)
   * @returns {number} Composite score
   */
  async calculateUserScore(creatorAddress, fanAddress, season = null) {
    try {
      const startDate = this.getSeasonStartDate(season);
      const endDate = new Date();

      // Get streaming metrics
      const streamingMetrics = await this.getStreamingMetrics(creatorAddress, fanAddress, startDate, endDate);
      
      // Get subscription metrics
      const subscriptionMetrics = await this.getSubscriptionMetrics(creatorAddress, fanAddress, startDate, endDate);
      
      // Get engagement metrics
      const engagementMetrics = await this.getEngagementMetrics(creatorAddress, fanAddress, startDate, endDate);

      // Calculate normalized scores (0-100 scale)
      const streamingScore = this.normalizeStreamingScore(streamingMetrics);
      const subscriptionScore = this.normalizeSubscriptionScore(subscriptionMetrics);
      const engagementScore = this.normalizeEngagementScore(engagementMetrics);

      // Calculate weighted composite score
      const compositeScore = 
        (streamingScore * this.weights.streamingAmount) +
        (subscriptionScore * this.weights.subscriptionLength) +
        (engagementScore * this.weights.engagementCount);

      logger.debug('User score calculated', {
        creatorAddress,
        fanAddress,
        season,
        compositeScore,
        components: { streamingScore, subscriptionScore, engagementScore }
      });

      return Math.round(compositeScore * 100) / 100; // Round to 2 decimal places
    } catch (error) {
      logger.error('Failed to calculate user score', {
        error: error.message,
        creatorAddress,
        fanAddress,
        season
      });
      return 0;
    }
  }

  /**
   * Get streaming metrics for a user
   */
  async getStreamingMetrics(creatorAddress, fanAddress, startDate, endDate) {
    const query = `
      SELECT 
        COALESCE(SUM(amount), 0) as totalAmount,
        COUNT(DISTINCT id) as transactionCount,
        MIN(created_at) as firstTransaction,
        MAX(created_at) as lastTransaction
      FROM streaming_payments 
      WHERE creator_address = ? 
        AND fan_address = ? 
        AND created_at >= ? 
        AND created_at <= ?
    `;

    const result = this.database.db.prepare(query).get(
      creatorAddress, 
      fanAddress, 
      startDate.toISOString(), 
      endDate.toISOString()
    );

    return {
      totalAmount: result.totalAmount || 0,
      transactionCount: result.transactionCount || 0,
      firstTransaction: result.firstTransaction,
      lastTransaction: result.lastTransaction,
      streamingDays: result.firstTransaction ? 
        Math.ceil((new Date(result.lastTransaction) - new Date(result.firstTransaction)) / (1000 * 60 * 60 * 24)) : 0
    };
  }

  /**
   * Get subscription metrics for a user
   */
  async getSubscriptionMetrics(creatorAddress, fanAddress, startDate, endDate) {
    const query = `
      SELECT 
        COUNT(*) as activeSubscriptions,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as currentActive,
        MIN(created_at) as firstSubscription,
        MAX(created_at) as lastSubscription,
        SUM(CASE WHEN active = 1 THEN 
          JULIANDAY('now') - JULIANDAY(created_at) 
        ELSE 0 END) as totalSubscriptionDays
      FROM subscriptions 
      WHERE creator_id = ? 
        AND wallet_address = ? 
        AND created_at >= ? 
        AND created_at <= ?
    `;

    const result = this.database.db.prepare(query).get(
      creatorAddress, 
      fanAddress, 
      startDate.toISOString(), 
      endDate.toISOString()
    );

    // Calculate subscription longevity score
    const longevityDays = result.totalSubscriptionDays || 0;
    const currentStreak = this.calculateCurrentStreak(creatorAddress, fanAddress);

    return {
      activeSubscriptions: result.activeSubscriptions || 0,
      currentActive: result.currentActive || 0,
      longevityDays,
      currentStreak,
      firstSubscription: result.firstSubscription,
      lastSubscription: result.lastSubscription
    };
  }

  /**
   * Get engagement metrics for a user
   */
  async getEngagementMetrics(creatorAddress, fanAddress, startDate, endDate) {
    // Get comments
    const commentQuery = `
      SELECT COUNT(*) as commentCount
      FROM comments 
      WHERE creator_id = ? 
        AND user_address = ? 
        AND created_at >= ? 
        AND created_at <= ?
    `;

    const commentResult = this.database.db.prepare(commentQuery).get(
      creatorAddress, 
      fanAddress, 
      startDate.toISOString(), 
      endDate.toISOString()
    );

    // Get likes (assuming likes table exists)
    const likeQuery = `
      SELECT COUNT(*) as likeCount
      FROM content_likes 
      WHERE creator_address = ? 
        AND fan_address = ? 
        AND created_at >= ? 
        AND created_at <= ?
    `;

    let likeCount = 0;
    try {
      const likeResult = this.database.db.prepare(likeQuery).get(
        creatorAddress, 
        fanAddress, 
        startDate.toISOString(), 
        endDate.toISOString()
      );
      likeCount = likeResult.likeCount || 0;
    } catch (error) {
      // Likes table might not exist yet
      logger.debug('Likes table not found, using 0 likes');
    }

    // Get shares/retweets (from ActivityPub engagements)
    const shareQuery = `
      SELECT COUNT(*) as shareCount
      FROM activitypub_engagements 
      WHERE creator_address = ? 
        AND activity_actor LIKE ? 
        AND activity_type IN ('Announce', 'Share')
        AND received_at >= ? 
        AND received_at <= ?
    `;

    let shareCount = 0;
    try {
      const shareResult = this.database.db.prepare(shareQuery).get(
        creatorAddress, 
        `%${fanAddress}%`, 
        startDate.toISOString(), 
        endDate.toISOString()
      );
      shareCount = shareResult.shareCount || 0;
    } catch (error) {
      // ActivityPub table might not exist
      logger.debug('ActivityPub table not found, using 0 shares');
    }

    return {
      commentCount: commentResult.commentCount || 0,
      likeCount,
      shareCount,
      totalEngagement: (commentResult.commentCount || 0) + likeCount + shareCount
    };
  }

  /**
   * Normalize streaming score (0-100)
   */
  normalizeStreamingScore(metrics) {
    if (metrics.totalAmount === 0) return 0;
    
    // Logarithmic scaling for streaming amount
    const maxAmount = 1000; // Maximum expected amount for normalization
    const normalizedAmount = Math.log10(metrics.totalAmount + 1) / Math.log10(maxAmount + 1);
    
    // Factor in consistency (streaming days)
    const consistencyBonus = Math.min(metrics.streamingDays / 30, 1) * 10; // Max 10 points
    
    return Math.min((normalizedAmount * 90) + consistencyBonus, 100);
  }

  /**
   * Normalize subscription score (0-100)
   */
  normalizeSubscriptionScore(metrics) {
    if (metrics.longevityDays === 0) return 0;
    
    // Base score from longevity
    const longevityScore = Math.min((metrics.longevityDays / 365) * 70, 70);
    
    // Bonus for current active subscription
    const activeBonus = metrics.currentActive > 0 ? 20 : 0;
    
    // Bonus for current streak
    const streakBonus = Math.min((metrics.currentStreak / 30) * 10, 10);
    
    return Math.min(longevityScore + activeBonus + streakBonus, 100);
  }

  /**
   * Normalize engagement score (0-100)
   */
  normalizeEngagementScore(metrics) {
    if (metrics.totalEngagement === 0) return 0;
    
    // Weight different types of engagement
    const weightedEngagement = 
      (metrics.commentCount * 3) +      // Comments worth 3x
      (metrics.likeCount * 1) +       // Likes worth 1x
      (metrics.shareCount * 5);        // Shares worth 5x
    
    // Normalize with logarithmic scaling
    const maxEngagement = 100; // Maximum expected engagement
    const normalized = Math.log10(weightedEngagement + 1) / Math.log10(maxEngagement + 1);
    
    return Math.min(normalized * 100, 100);
  }

  /**
   * Calculate current subscription streak
   */
  calculateCurrentStreak(creatorAddress, fanAddress) {
    const query = `
      SELECT created_at, active
      FROM subscriptions 
      WHERE creator_id = ? AND wallet_address = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result = this.database.db.prepare(query).get(creatorAddress, fanAddress);
    
    if (!result || !result.active) return 0;
    
    const subscriptionStart = new Date(result.created_at);
    const now = new Date();
    const daysActive = Math.ceil((now - subscriptionStart) / (1000 * 60 * 60 * 24));
    
    return daysActive;
  }

  /**
   * Generate leaderboard for a creator
   * @param {string} creatorAddress Creator wallet address
   * @param {string} season Season identifier
   * @param {number} limit Maximum number of fans to return
   * @returns {Array} Leaderboard entries
   */
  async generateLeaderboard(creatorAddress, season = null, limit = 100) {
    try {
      const cacheKey = this.getCacheKey(creatorAddress, season);
      
      // Try to get from cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug('Leaderboard found in cache', { creatorAddress, season });
        return JSON.parse(cached);
      }

      logger.info('Generating leaderboard', { creatorAddress, season, limit });

      // Get all fans for the creator
      const fans = await this.getCreatorFans(creatorAddress);
      
      // Calculate scores for each fan
      const leaderboardEntries = [];
      for (const fan of fans) {
        const score = await this.calculateUserScore(creatorAddress, fan.address, season);
        
        if (score > 0) { // Only include fans with non-zero scores
          leaderboardEntries.push({
            fanAddress: fan.address,
            score,
            rank: 0, // Will be assigned after sorting
            metrics: await this.getDetailedMetrics(creatorAddress, fan.address, season),
            lastUpdated: new Date().toISOString()
          });
        }
      }

      // Sort by score (descending) and assign ranks
      leaderboardEntries.sort((a, b) => b.score - a.score);
      leaderboardEntries.forEach((entry, index) => {
        entry.rank = index + 1;
      });

      // Limit results
      const limitedLeaderboard = leaderboardEntries.slice(0, limit);

      // Cache the results
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(limitedLeaderboard));

      logger.info('Leaderboard generated and cached', {
        creatorAddress,
        season,
        totalFans: fans.length,
        rankedFans: limitedLeaderboard.length,
        cacheKey
      });

      return limitedLeaderboard;
    } catch (error) {
      logger.error('Failed to generate leaderboard', {
        error: error.message,
        creatorAddress,
        season
      });
      throw error;
    }
  }

  /**
   * Get all fans for a creator
   */
  async getCreatorFans(creatorAddress) {
    const query = `
      SELECT DISTINCT wallet_address as address
      FROM subscriptions 
      WHERE creator_id = ?
      UNION
      SELECT DISTINCT fan_address as address
      FROM streaming_payments 
      WHERE creator_address = ?
      UNION
      SELECT DISTINCT user_address as address
      FROM comments 
      WHERE creator_id = ?
    `;

    return this.database.db.prepare(query).all(creatorAddress, creatorAddress, creatorAddress);
  }

  /**
   * Get detailed metrics for a fan
   */
  async getDetailedMetrics(creatorAddress, fanAddress, season) {
    const startDate = this.getSeasonStartDate(season);
    const endDate = new Date();

    const [streaming, subscription, engagement] = await Promise.all([
      this.getStreamingMetrics(creatorAddress, fanAddress, startDate, endDate),
      this.getSubscriptionMetrics(creatorAddress, fanAddress, startDate, endDate),
      this.getEngagementMetrics(creatorAddress, fanAddress, startDate, endDate)
    ]);

    return {
      streaming: {
        totalAmount: streaming.totalAmount,
        transactionCount: streaming.transactionCount,
        streamingDays: streaming.streamingDays
      },
      subscription: {
        isActive: subscription.currentActive > 0,
        longevityDays: subscription.longevityDays,
        currentStreak: subscription.currentStreak
      },
      engagement: {
        commentCount: engagement.commentCount,
        likeCount: engagement.likeCount,
        shareCount: engagement.shareCount,
        totalEngagement: engagement.totalEngagement
      }
    };
  }

  /**
   * Get cache key for leaderboard
   */
  getCacheKey(creatorAddress, season) {
    const seasonSuffix = season ? `:${season}` : ':current';
    return `${this.prefix}${creatorAddress}${seasonSuffix}`;
  }

  /**
   * Get season start date
   */
  getSeasonStartDate(season) {
    if (!season) {
      // Default to current season
      season = this.getCurrentSeason();
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    switch (this.seasonLength) {
      case 'monthly':
        return new Date(year, month, 1);
      case 'quarterly':
        const quarter = Math.floor(month / 3);
        return new Date(year, quarter * 3, 1);
      case 'yearly':
        return new Date(year, 0, 1);
      default:
        return new Date(year, month, 1);
    }
  }

  /**
   * Get current season identifier
   */
  getCurrentSeason() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12

    switch (this.seasonLength) {
      case 'monthly':
        return `${year}-${month.toString().padStart(2, '0')}`;
      case 'quarterly':
        const quarter = Math.ceil(month / 3);
        return `${year}-Q${quarter}`;
      case 'yearly':
        return `${year}`;
      default:
        return `${year}-${month.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Get available seasons
   */
  async getAvailableSeasons(creatorAddress) {
    // Get earliest activity date for the creator
    const query = `
      SELECT 
        MIN(created_at) as earliestDate
      FROM (
        SELECT created_at FROM subscriptions WHERE creator_id = ?
        UNION
        SELECT created_at FROM streaming_payments WHERE creator_address = ?
        UNION
        SELECT created_at FROM comments WHERE creator_id = ?
      )
    `;

    const result = this.database.db.prepare(query).get(creatorAddress, creatorAddress, creatorAddress);
    
    if (!result.earliestDate) {
      return [this.getCurrentSeason()];
    }

    const seasons = [];
    const startDate = new Date(result.earliestDate);
    const now = new Date();

    let currentDate = new Date(startDate);
    while (currentDate <= now) {
      const season = this.getSeasonForDate(currentDate);
      if (!seasons.includes(season)) {
        seasons.push(season);
      }
      
      // Move to next season
      switch (this.seasonLength) {
        case 'monthly':
          currentDate.setMonth(currentDate.getMonth() + 1);
          break;
        case 'quarterly':
          currentDate.setMonth(currentDate.getMonth() + 3);
          break;
        case 'yearly':
          currentDate.setFullYear(currentDate.getFullYear() + 1);
          break;
      }
    }

    return seasons.reverse(); // Most recent first
  }

  /**
   * Get season identifier for a specific date
   */
  getSeasonForDate(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    switch (this.seasonLength) {
      case 'monthly':
        return `${year}-${month.toString().padStart(2, '0')}`;
      case 'quarterly':
        const quarter = Math.ceil(month / 3);
        return `${year}-Q${quarter}`;
      case 'yearly':
        return `${year}`;
      default:
        return `${year}-${month.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Invalidate leaderboard cache
   */
  async invalidateCache(creatorAddress, season = null) {
    try {
      const cacheKey = this.getCacheKey(creatorAddress, season);
      await this.redis.del(cacheKey);
      
      logger.info('Leaderboard cache invalidated', { creatorAddress, season, cacheKey });
    } catch (error) {
      logger.error('Failed to invalidate leaderboard cache', {
        error: error.message,
        creatorAddress,
        season
      });
    }
  }

  /**
   * Get fan rank on leaderboard
   */
  async getFanRank(creatorAddress, fanAddress, season = null) {
    try {
      const leaderboard = await this.generateLeaderboard(creatorAddress, season, 1000);
      const entry = leaderboard.find(entry => entry.fanAddress === fanAddress);
      
      return entry || null;
    } catch (error) {
      logger.error('Failed to get fan rank', {
        error: error.message,
        creatorAddress,
        fanAddress,
        season
      });
      return null;
    }
  }

  /**
   * Get leaderboard statistics
   */
  async getLeaderboardStats(creatorAddress, season = null) {
    try {
      const leaderboard = await this.generateLeaderboard(creatorAddress, season, 1000);
      
      if (leaderboard.length === 0) {
        return {
          totalFans: 0,
          averageScore: 0,
          topScore: 0,
          medianScore: 0
        };
      }

      const scores = leaderboard.map(entry => entry.score);
      scores.sort((a, b) => a - b);
      
      const totalFans = leaderboard.length;
      const averageScore = scores.reduce((sum, score) => sum + score, 0) / totalFans;
      const topScore = scores[scores.length - 1];
      const medianScore = scores[Math.floor(scores.length / 2)];

      return {
        totalFans,
        averageScore: Math.round(averageScore * 100) / 100,
        topScore,
        medianScore,
        scoreDistribution: this.getScoreDistribution(scores)
      };
    } catch (error) {
      logger.error('Failed to get leaderboard stats', {
        error: error.message,
        creatorAddress,
        season
      });
      return null;
    }
  }

  /**
   * Get score distribution for statistics
   */
  getScoreDistribution(scores) {
    const ranges = [
      { label: '0-20', min: 0, max: 20, count: 0 },
      { label: '21-40', min: 21, max: 40, count: 0 },
      { label: '41-60', min: 41, max: 60, count: 0 },
      { label: '61-80', min: 61, max: 80, count: 0 },
      { label: '81-100', min: 81, max: 100, count: 0 }
    ];

    scores.forEach(score => {
      const range = ranges.find(r => score >= r.min && score <= r.max);
      if (range) range.count++;
    });

    return ranges.map(range => ({
      ...range,
      percentage: Math.round((range.count / scores.length) * 100)
    }));
  }
}

module.exports = EngagementLeaderboardService;
