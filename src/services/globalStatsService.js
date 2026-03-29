const { getRedisClient } = require('../config/redis');

/**
 * Service for caching and retrieving global statistics with Redis.
 * Implements a 60-second TTL with background refresh to prevent database hammering.
 */
class GlobalStatsService {
  constructor(database, redisClient = null) {
    this.database = database;
    this.redis = redisClient || getRedisClient();
    this.cacheKeys = {
      totalValueLocked: 'global_stats:tvl',
      trendingCreators: 'global_stats:trending_creators',
      totalUsers: 'global_stats:total_users',
      totalCreators: 'global_stats:total_creators',
      totalVideos: 'global_stats:total_videos',
      totalSubscriptions: 'global_stats:total_subscriptions',
      lastUpdated: 'global_stats:last_updated'
    };
    this.ttlSeconds = 60;
  }

  /**
   * Get cached global stats or compute them if cache is empty.
   * @returns {Promise<Object>} Global statistics object
   */
  async getGlobalStats() {
    try {
      const cached = await this.getCachedStats();
      if (cached) {
        return cached;
      }

      return await this.computeAndCacheStats();
    } catch (error) {
      console.error('Error fetching global stats:', error);
      throw new Error('Failed to retrieve global statistics');
    }
  }

  /**
   * Retrieve cached stats from Redis.
   * @returns {Promise<Object|null>} Cached stats or null if not found
   */
  async getCachedStats() {
    try {
      const cached = await this.redis.get(this.cacheKeys.totalValueLocked);
      if (!cached) return null;

      const stats = {
        totalValueLocked: JSON.parse(cached),
        trendingCreators: JSON.parse(await this.redis.get(this.cacheKeys.trendingCreators) || '[]'),
        totalUsers: parseInt(await this.redis.get(this.cacheKeys.totalUsers) || '0'),
        totalCreators: parseInt(await this.redis.get(this.cacheKeys.totalCreators) || '0'),
        totalVideos: parseInt(await this.redis.get(this.cacheKeys.totalVideos) || '0'),
        totalSubscriptions: parseInt(await this.redis.get(this.cacheKeys.totalSubscriptions) || '0'),
        lastUpdated: await this.redis.get(this.cacheKeys.lastUpdated)
      };

      return stats;
    } catch (error) {
      console.error('Error retrieving cached stats:', error);
      return null;
    }
  }

  /**
   * Compute fresh stats and cache them.
   * @returns {Promise<Object>} Freshly computed statistics
   */
  async computeAndCacheStats() {
    const stats = await this.computeFreshStats();
    await this.cacheStats(stats);
    return stats;
  }

  /**
   * Compute fresh statistics from the database.
   * @returns {Promise<Object>} Fresh statistics
   */
  async computeFreshStats() {
    const now = new Date().toISOString();

    const [
      totalValueLocked,
      trendingCreators,
      totalUsers,
      totalCreators,
      totalVideos,
      totalSubscriptions
    ] = await Promise.all([
      this.computeTotalValueLocked(),
      this.computeTrendingCreators(),
      this.computeTotalUsers(),
      this.computeTotalCreators(),
      this.computeTotalVideos(),
      this.computeTotalSubscriptions()
    ]);

    return {
      totalValueLocked,
      trendingCreators,
      totalUsers,
      totalCreators,
      totalVideos,
      totalSubscriptions,
      lastUpdated: now
    };
  }

  /**
   * Cache statistics in Redis with TTL.
   * @param {Object} stats Statistics to cache
   */
  async cacheStats(stats) {
    try {
      const pipeline = this.redis.pipeline();
      
      pipeline.setex(this.cacheKeys.totalValueLocked, this.ttlSeconds, JSON.stringify(stats.totalValueLocked));
      pipeline.setex(this.cacheKeys.trendingCreators, this.ttlSeconds, JSON.stringify(stats.trendingCreators));
      pipeline.setex(this.cacheKeys.totalUsers, this.ttlSeconds, stats.totalUsers.toString());
      pipeline.setex(this.cacheKeys.totalCreators, this.ttlSeconds, stats.totalCreators.toString());
      pipeline.setex(this.cacheKeys.totalVideos, this.ttlSeconds, stats.totalVideos.toString());
      pipeline.setex(this.cacheKeys.totalSubscriptions, this.ttlSeconds, stats.totalSubscriptions.toString());
      pipeline.setex(this.cacheKeys.lastUpdated, this.ttlSeconds, stats.lastUpdated);

      await pipeline.exec();
      console.log('Global stats cached successfully');
    } catch (error) {
      console.error('Error caching stats:', error);
    }
  }

  /**
   * Compute Total Value Locked (sum of all active subscription flow rates).
   * @returns {Promise<number>} Total value locked
   */
  async computeTotalValueLocked() {
    try {
      const query = `
        SELECT SUM(CAST(cs.flow_rate AS REAL)) as totalFlow
        FROM creator_settings cs
        JOIN creators c ON cs.creator_id = c.id
        WHERE c.subscriber_count > 0
      `;
      
      const result = this.database.db.prepare(query).get();
      return result?.totalFlow || 0;
    } catch (error) {
      console.error('Error computing TVL:', error);
      return 0;
    }
  }

  /**
   * Compute trending creators based on subscriber growth and activity.
   * @returns {Promise<Array>} Array of trending creators
   */
  async computeTrendingCreators() {
    try {
      const query = `
        SELECT 
          c.id,
          c.subscriber_count,
          COUNT(v.id) as video_count,
          MAX(v.created_at) as latest_video_date
        FROM creators c
        LEFT JOIN videos v ON c.id = v.creator_id AND v.visibility = 'public'
        WHERE c.subscriber_count > 0
        GROUP BY c.id, c.subscriber_count
        ORDER BY 
          c.subscriber_count DESC,
          video_count DESC,
          latest_video_date DESC
        LIMIT 10
      `;
      
      const creators = this.database.db.prepare(query).all();
      
      return creators.map(creator => ({
        id: creator.id,
        subscriberCount: creator.subscriber_count,
        videoCount: creator.video_count,
        latestVideoDate: creator.latest_video_date,
        trendingScore: this.calculateTrendingScore(creator)
      }));
    } catch (error) {
      console.error('Error computing trending creators:', error);
      return [];
    }
  }

  /**
   * Calculate trending score for a creator.
   * @param {Object} creator Creator data
   * @returns {number} Trending score
   */
  calculateTrendingScore(creator) {
    const subscriberWeight = 0.5;
    const videoWeight = 0.3;
    const recencyWeight = 0.2;
    
    let recencyScore = 0;
    if (creator.latest_video_date) {
      const daysSinceLatestVideo = (Date.now() - new Date(creator.latest_video_date).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0, 1 - daysSinceLatestVideo / 30); // Decay over 30 days
    }
    
    return (
      creator.subscriber_count * subscriberWeight +
      creator.video_count * videoWeight +
      recencyScore * 100 * recencyWeight
    );
  }

  /**
   * Compute total number of unique users (subscribers).
   * @returns {Promise<number>} Total users
   */
  async computeTotalUsers() {
    try {
      const query = `SELECT COUNT(DISTINCT wallet_address) as totalUsers FROM subscriptions WHERE active = 1`;
      const result = this.database.db.prepare(query).get();
      return result?.totalUsers || 0;
    } catch (error) {
      console.error('Error computing total users:', error);
      return 0;
    }
  }

  /**
   * Compute total number of creators.
   * @returns {Promise<number>} Total creators
   */
  async computeTotalCreators() {
    try {
      const query = `SELECT COUNT(*) as totalCreators FROM creators`;
      const result = this.database.db.prepare(query).get();
      return result?.totalCreators || 0;
    } catch (error) {
      console.error('Error computing total creators:', error);
      return 0;
    }
  }

  /**
   * Compute total number of videos.
   * @returns {Promise<number>} Total videos
   */
  async computeTotalVideos() {
    try {
      const query = `SELECT COUNT(*) as totalVideos FROM videos`;
      const result = this.database.db.prepare(query).get();
      return result?.totalVideos || 0;
    } catch (error) {
      console.error('Error computing total videos:', error);
      return 0;
    }
  }

  /**
   * Compute total number of active subscriptions.
   * @returns {Promise<number>} Total subscriptions
   */
  async computeTotalSubscriptions() {
    try {
      const query = `SELECT COUNT(*) as totalSubscriptions FROM subscriptions WHERE active = 1`;
      const result = this.database.db.prepare(query).get();
      return result?.totalSubscriptions || 0;
    } catch (error) {
      console.error('Error computing total subscriptions:', error);
      return 0;
    }
  }

  /**
   * Refresh the cache manually.
   * @returns {Promise<Object>} Fresh statistics
   */
  async refreshCache() {
    console.log('Manually refreshing global stats cache...');
    return await this.computeAndCacheStats();
  }

  /**
   * Clear all cached global stats.
   */
  async clearCache() {
    try {
      const keys = Object.values(this.cacheKeys);
      await this.redis.del(...keys);
      console.log('Global stats cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  /**
   * Get cache status and metadata.
   * @returns {Promise<Object>} Cache status information
   */
  async getCacheStatus() {
    try {
      const lastUpdated = await this.redis.get(this.cacheKeys.lastUpdated);
      const ttl = await this.redis.ttl(this.cacheKeys.totalValueLocked);
      
      return {
        lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        ttlSeconds: ttl,
        cacheKeys: this.cacheKeys,
        ttlConfig: this.ttlSeconds
      };
    } catch (error) {
      console.error('Error getting cache status:', error);
      return null;
    }
  }
}

module.exports = GlobalStatsService;
