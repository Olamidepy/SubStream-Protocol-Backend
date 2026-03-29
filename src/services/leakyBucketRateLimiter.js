/**
 * Leaky Bucket Rate Limiter backed by Redis.
 *
 * The algorithm models a bucket that:
 *  - Has a fixed capacity (burst size).
 *  - Leaks at a constant rate (requests / second).
 *  - Each incoming request adds 1 unit to the bucket.
 *  - If the bucket is full the request is rejected.
 *
 * All state is stored in Redis so the limiter works across multiple
 * server instances.
 *
 * Redis keys used per wallet:
 *   ratelimit:{wallet}        – hash { level, lastDrip }
 *   ratelimit:blocked:{wallet} – string with TTL (temporary block)
 */

const BUCKET_KEY_PREFIX = "ratelimit:";
const BLOCK_KEY_PREFIX = "ratelimit:blocked:";

// Lua script executed atomically in Redis.
// Returns: [allowed (0|1), currentLevel, bucketCapacity]
const LEAKY_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local leakRate  = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'level', 'lastDrip')
local level    = tonumber(data[1]) or 0
local lastDrip = tonumber(data[2]) or now

-- Leak tokens since the last request
local elapsed = now - lastDrip
local leaked  = elapsed * leakRate
level = math.max(0, level - leaked)

-- Try to add the new request
if level + 1 > capacity then
  -- Bucket full – reject
  redis.call('HMSET', key, 'level', level, 'lastDrip', now)
  redis.call('EXPIRE', key, math.ceil(capacity / leakRate) + 60)
  return {0, tostring(level), tostring(capacity)}
end

level = level + 1
redis.call('HMSET', key, 'level', level, 'lastDrip', now)
redis.call('EXPIRE', key, math.ceil(capacity / leakRate) + 60)
return {1, tostring(level), tostring(capacity)}
`;

class LeakyBucketRateLimiter {
  /**
   * @param {import('ioredis').Redis} redisClient
   * @param {object} [options]
   * @param {number} [options.bucketCapacity=60]  Max burst size.
   * @param {number} [options.leakRatePerSecond=1] Tokens leaked per second.
   * @param {number} [options.blockDurationSeconds=300] How long to block after overflow (5 min).
   * @param {number} [options.sybilThreshold=3] Consecutive blocks before Sybil flagging.
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.bucketCapacity = options.bucketCapacity ?? 60;
    this.leakRatePerSecond = options.leakRatePerSecond ?? 1;
    this.blockDurationSeconds = options.blockDurationSeconds ?? 300;
    this.sybilThreshold = options.sybilThreshold ?? 3;
  }

  /**
   * Consume one token for the given wallet.
   *
   * @param {string} wallet Wallet address (Stellar public key or Ethereum address).
   * @returns {Promise<{allowed: boolean, blocked: boolean, currentLevel: number,
   *           capacity: number, retryAfterSeconds: number | null}>}
   */
  async consume(wallet) {
    const normalizedWallet = wallet.toLowerCase();
    const blockKey = `${BLOCK_KEY_PREFIX}${normalizedWallet}`;

    // 1. Check if wallet is already temporarily blocked.
    const blocked = await this.redis.get(blockKey);
    if (blocked) {
      const ttl = await this.redis.ttl(blockKey);
      return {
        allowed: false,
        blocked: true,
        currentLevel: this.bucketCapacity,
        capacity: this.bucketCapacity,
        retryAfterSeconds: ttl > 0 ? ttl : this.blockDurationSeconds,
      };
    }

    // 2. Run the atomic leaky-bucket script.
    const bucketKey = `${BUCKET_KEY_PREFIX}${normalizedWallet}`;
    const nowSeconds = Date.now() / 1000;

    const [allowed, levelStr, capacityStr] = await this.redis.eval(
      LEAKY_BUCKET_LUA,
      1,
      bucketKey,
      this.bucketCapacity,
      this.leakRatePerSecond,
      nowSeconds,
    );

    const currentLevel = parseFloat(levelStr);
    const capacity = parseFloat(capacityStr);

    if (allowed === 1) {
      return {
        allowed: true,
        blocked: false,
        currentLevel,
        capacity,
        retryAfterSeconds: null,
      };
    }

    // 3. Bucket overflow – impose temporary block and increment violation counter.
    await this.redis.set(blockKey, "1", "EX", this.blockDurationSeconds);

    const violationKey = `ratelimit:violations:${normalizedWallet}`;
    const violations = await this.redis.incr(violationKey);
    // Expire violations counter after 24 hours so old infractions don't persist forever.
    await this.redis.expire(violationKey, 86400);

    return {
      allowed: false,
      blocked: true,
      currentLevel,
      capacity,
      retryAfterSeconds: this.blockDurationSeconds,
      violations,
    };
  }

  /**
   * Return the current violation count for a wallet.
   *
   * @param {string} wallet
   * @returns {Promise<number>}
   */
  async getViolationCount(wallet) {
    const count = await this.redis.get(
      `ratelimit:violations:${wallet.toLowerCase()}`,
    );
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Check whether a wallet is currently blocked.
   *
   * @param {string} wallet
   * @returns {Promise<boolean>}
   */
  async isBlocked(wallet) {
    const res = await this.redis.get(
      `${BLOCK_KEY_PREFIX}${wallet.toLowerCase()}`,
    );
    return res !== null;
  }

  /**
   * Manually unblock a wallet (admin action).
   *
   * @param {string} wallet
   */
  async unblock(wallet) {
    await this.redis.del(`${BLOCK_KEY_PREFIX}${wallet.toLowerCase()}`);
  }

  /**
   * Reset all rate-limit state for a wallet.
   *
   * @param {string} wallet
   */
  async reset(wallet) {
    const w = wallet.toLowerCase();
    await this.redis.del(
      `${BUCKET_KEY_PREFIX}${w}`,
      `${BLOCK_KEY_PREFIX}${w}`,
      `ratelimit:violations:${w}`,
    );
  }
}

module.exports = { LeakyBucketRateLimiter };
