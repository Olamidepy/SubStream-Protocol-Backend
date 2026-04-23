
const { getRedisClient } = require('../config/redis');

/**
 * Cache Utility
 * Provides a standardized way to cache analytical queries with automated invalidation
 */
class CacheManager {
  constructor(config = {}) {
    this.redis = getRedisClient();
    this.defaultTtl = config.defaultTtl || 900; // 15 minutes in seconds
    this.prefix = config.prefix || 'cache:';
  }

  /**
   * Get or set cache value
   * @param {string} key 
   * @param {Function} fetchFn 
   * @param {number} ttl 
   */
  async wrap(key, fetchFn, ttl = this.defaultTtl) {
    const fullKey = `${this.prefix}${key}`;
    
    try {
      // 1. Try to get from cache
      const cached = await this.redis.get(fullKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // 2. If not found, fetch data
      const data = await fetchFn();

      // 3. Store in cache
      await this.redis.set(fullKey, JSON.stringify(data), 'EX', ttl);

      return data;
    } catch (error) {
      console.error(`Cache error for key ${fullKey}:`, error);
      // Fallback to direct fetch on error
      return await fetchFn();
    }
  }

  /**
   * Invalidate cache for a specific key
   * @param {string} key 
   */
  async invalidate(key) {
    const fullKey = `${this.prefix}${key}`;
    await this.redis.del(fullKey);
  }

  /**
   * Invalidate all analytical caches for a creator
   * Useful when a new BillingEvent arrives
   * @param {string} creatorId 
   */
  async invalidateCreatorAnalytics(creatorId) {
    const pattern = `${this.prefix}analytics:${creatorId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

module.exports = new CacheManager();
