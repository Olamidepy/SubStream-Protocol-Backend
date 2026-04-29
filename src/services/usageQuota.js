const redis = require('redis');
const crypto = require('crypto');
const db = require('../database/connection');

class UsageQuotaService {
  constructor() {
    this.redisClient = redis.createClient({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
      retry_delay_on_failover: 100,
      enable_offline_queue: false,
    });

    this.redisClient.on('error', (err) => {
      console.error('Redis connection error:', err);
    });

    this.redisClient.on('connect', () => {
      console.log('Connected to Redis');
    });

    // Rate limits from environment
    this.limits = {
      standard: {
        hourly: parseInt(process.env.STANDARD_HOURLY_LIMIT) || 1000,
        monthly: parseInt(process.env.STANDARD_MONTHLY_LIMIT) || 10000,
      },
      premium: {
        hourly: parseInt(process.env.PREMIUM_HOURLY_LIMIT) || 10000,
        monthly: parseInt(process.env.PREMIUM_MONTHLY_LIMIT) || 100000,
      },
    };
  }

  async initialize() {
    await this.redisClient.connect();
  }

  // Hash API key for secure storage
  hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  // Validate API key and get tier information
  async validateApiKey(apiKey) {
    const keyHash = this.hashApiKey(apiKey);
    
    const query = `
      SELECT ak.*, d.subscription_status 
      FROM api_keys ak 
      JOIN developers d ON ak.developer_id = d.id 
      WHERE ak.key_hash = $1 AND ak.is_active = true
    `;
    
    const result = await db.query(query, [keyHash]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }

  // Check hourly quota using Redis for sub-1ms performance
  async checkHourlyQuota(apiKeyId, tier) {
    const now = new Date();
    const hourKey = `usage:${apiKeyId}:hour:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    
    try {
      const currentCount = await this.redisClient.get(hourKey) || 0;
      const limit = this.limits[tier].hourly;
      
      return {
        allowed: parseInt(currentCount) < limit,
        current: parseInt(currentCount),
        limit,
        remaining: limit - parseInt(currentCount),
      };
    } catch (error) {
      console.error('Redis hourly quota check failed:', error);
      // Fallback to database if Redis fails
      return await this.checkHourlyQuotaDB(apiKeyId, tier);
    }
  }

  // Check monthly quota using Redis for sub-1ms performance
  async checkMonthlyQuota(apiKeyId, tier) {
    const now = new Date();
    const monthKey = `usage:${apiKeyId}:month:${now.getFullYear()}-${now.getMonth()}`;
    
    try {
      const currentCount = await this.redisClient.get(monthKey) || 0;
      const limit = this.limits[tier].monthly;
      
      return {
        allowed: parseInt(currentCount) < limit,
        current: parseInt(currentCount),
        limit,
        remaining: limit - parseInt(currentCount),
      };
    } catch (error) {
      console.error('Redis monthly quota check failed:', error);
      // Fallback to database if Redis fails
      return await this.checkMonthlyQuotaDB(apiKeyId, tier);
    }
  }

  // Database fallback for hourly quota
  async checkHourlyQuotaDB(apiKeyId, tier) {
    const now = new Date();
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
    
    const query = `
      SELECT COALESCE(request_count, 0) as count
      FROM hourly_usage 
      WHERE api_key_id = $1 AND hour_timestamp = $2
    `;
    
    const result = await db.query(query, [apiKeyId, hourStart]);
    const currentCount = result.rows[0]?.count || 0;
    const limit = this.limits[tier].hourly;
    
    return {
      allowed: currentCount < limit,
      current: currentCount,
      limit,
      remaining: limit - currentCount,
    };
  }

  // Database fallback for monthly quota
  async checkMonthlyQuotaDB(apiKeyId, tier) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    
    const query = `
      SELECT COALESCE(request_count, 0) as count
      FROM monthly_usage 
      WHERE api_key_id = $1 AND month_timestamp = $2
    `;
    
    const result = await db.query(query, [apiKeyId, monthStart]);
    const currentCount = result.rows[0]?.count || 0;
    const limit = this.limits[tier].monthly;
    
    return {
      allowed: currentCount < limit,
      current: currentCount,
      limit,
      remaining: limit - currentCount,
    };
  }

  // Increment usage counters (atomic operations)
  async incrementUsage(apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent) {
    const now = new Date();
    
    // Redis increments for real-time tracking
    const hourKey = `usage:${apiKeyId}:hour:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    const monthKey = `usage:${apiKeyId}:month:${now.getFullYear()}-${now.getMonth()}`;
    
    try {
      // Increment counters in Redis (atomic)
      await Promise.all([
        this.redisClient.incr(hourKey),
        this.redisClient.incr(monthKey),
        // Set expiration for hourly keys (2 hours to handle edge cases)
        this.redisClient.expire(hourKey, 7200),
        // Set expiration for monthly keys (35 days to handle edge cases)
        this.redisClient.expire(monthKey, 3024000),
      ]);
    } catch (error) {
      console.error('Redis increment failed:', error);
    }

    // Log detailed usage to database asynchronously
    this.logUsageToDB(apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent)
      .catch(error => console.error('Failed to log usage to DB:', error));
    
    // Update aggregation tables asynchronously
    this.updateAggregations(apiKeyId, now)
      .catch(error => console.error('Failed to update aggregations:', error));
  }

  // Log detailed usage to database
  async logUsageToDB(apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent) {
    const query = `
      INSERT INTO api_usage (api_key_id, endpoint, method, status_code, response_time_ms, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    await db.query(query, [apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent]);
  }

  // Update hourly and monthly aggregation tables
  async updateAggregations(apiKeyId, timestamp) {
    const hourStart = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate(), timestamp.getHours(), 0, 0);
    const monthStart = new Date(timestamp.getFullYear(), timestamp.getMonth(), 1, 0, 0, 0);
    
    // Update hourly usage
    const hourlyQuery = `
      INSERT INTO hourly_usage (api_key_id, hour_timestamp, request_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (api_key_id, hour_timestamp)
      DO UPDATE SET request_count = hourly_usage.request_count + 1
    `;
    
    // Update monthly usage
    const monthlyQuery = `
      INSERT INTO monthly_usage (api_key_id, month_timestamp, request_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (api_key_id, month_timestamp)
      DO UPDATE SET request_count = monthly_usage.request_count + 1
    `;
    
    await Promise.all([
      db.query(hourlyQuery, [apiKeyId, hourStart]),
      db.query(monthlyQuery, [apiKeyId, monthStart]),
    ]);
  }

  // Get usage statistics for a developer
  async getUsageStats(apiKeyId) {
    const now = new Date();
    const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    
    const query = `
      SELECT 
        COALESCE(h.request_count, 0) as hourly_usage,
        COALESCE(m.request_count, 0) as monthly_usage,
        ak.tier
      FROM api_keys ak
      LEFT JOIN hourly_usage h ON ak.id = h.api_key_id AND h.hour_timestamp = $2
      LEFT JOIN monthly_usage m ON ak.id = m.api_key_id AND m.month_timestamp = $3
      WHERE ak.id = $1
    `;
    
    const result = await db.query(query, [apiKeyId, hourStart, monthStart]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const stats = result.rows[0];
    const limits = this.limits[stats.tier];
    
    return {
      tier: stats.tier,
      hourly: {
        used: stats.hourly_usage,
        limit: limits.hourly,
        remaining: limits.hourly - stats.hourly_usage,
      },
      monthly: {
        used: stats.monthly_usage,
        limit: limits.monthly,
        remaining: limits.monthly - stats.monthly_usage,
      },
    };
  }

  async close() {
    await this.redisClient.quit();
  }
}

module.exports = new UsageQuotaService();
