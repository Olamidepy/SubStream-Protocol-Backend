const Redis = require("ioredis");

let redisClient = null;

/**
 * Create or return the singleton Redis client.
 *
 * Supports configuration via environment variables:
 *   REDIS_URL   – full connection string (e.g. redis://user:pass@host:6379)
 *   REDIS_HOST  – hostname (default 127.0.0.1)
 *   REDIS_PORT  – port     (default 6379)
 *   REDIS_PASSWORD – password (optional)
 *   REDIS_DB    – database index (default 0)
 *
 * @param {object} [opts] Override options forwarded to ioredis.
 * @returns {import('ioredis').Redis}
 */
function getRedisClient(opts = {}) {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL;

  if (url) {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      ...opts,
    });
  } else {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      ...opts,
    });
  }

  redisClient.on("error", (err) => {
    console.error("[Redis] connection error:", err.message);
  });

  return redisClient;
}

/**
 * Gracefully close the Redis connection (e.g. during shutdown).
 */
async function closeRedisClient() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Replace the singleton – useful for injecting a mock in tests.
 */
function setRedisClient(client) {
  redisClient = client;
}

module.exports = { getRedisClient, closeRedisClient, setRedisClient };
