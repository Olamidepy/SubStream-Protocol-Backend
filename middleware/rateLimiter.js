/**
 * Express middleware – per-wallet Leaky Bucket rate limiting with Sybil flagging.
 *
 * Usage:
 *   const { createRateLimiter } = require('./middleware/rateLimiter');
 *   app.use('/api', createRateLimiter({ redis, bucketCapacity: 60 }));
 *
 * The middleware extracts the wallet address from (in priority order):
 *   1. req.user.address   (set by auth middleware)
 *   2. req.user.publicKey (Stellar auth)
 *   3. req.body.walletAddress
 *   4. req.query.walletAddress || req.query.publicKey
 *
 * When a wallet cannot be determined the request falls through to the
 * next middleware so unauthenticated routes still work.
 */

const {
  LeakyBucketRateLimiter,
} = require("../src/services/leakyBucketRateLimiter");
const {
  SybilAnalysisService,
} = require("../src/services/sybilAnalysisService");
const { getRequestIp } = require("../src/utils/requestIp");

/**
 * Extract the wallet / public-key identifier from the request.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractWallet(req) {
  if (req.user?.address) return req.user.address;
  if (req.user?.publicKey) return req.user.publicKey;
  if (req.body?.walletAddress) return req.body.walletAddress;
  if (req.query?.walletAddress) return req.query.walletAddress;
  if (req.query?.publicKey) return req.query.publicKey;
  return null;
}

/**
 * Create the rate-limiting middleware.
 *
 * @param {object} options
 * @param {import('ioredis').Redis} options.redis             Redis client instance.
 * @param {number}  [options.bucketCapacity=60]               Max burst size.
 * @param {number}  [options.leakRatePerSecond=1]             Tokens drained per second.
 * @param {number}  [options.blockDurationSeconds=300]        Temp-block length after overflow.
 * @param {number}  [options.sybilThreshold=3]                Violations before Sybil flag.
 * @param {boolean} [options.skipIfNoWallet=true]             Pass through when wallet is unknown.
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
  const { redis, skipIfNoWallet = true } = options;

  if (!redis) {
    throw new Error("createRateLimiter requires a redis client instance");
  }

  const limiter = new LeakyBucketRateLimiter(redis, {
    bucketCapacity: options.bucketCapacity,
    leakRatePerSecond: options.leakRatePerSecond,
    blockDurationSeconds: options.blockDurationSeconds,
    sybilThreshold: options.sybilThreshold,
  });

  const sybil = new SybilAnalysisService(redis, {
    flagThreshold: options.sybilThreshold,
  });

  return async function rateLimiterMiddleware(req, res, next) {
    const wallet = extractWallet(req);

    if (!wallet) {
      if (skipIfNoWallet) return next();
      return res.status(400).json({
        success: false,
        error: "Wallet address required for rate-limited endpoints",
      });
    }

    try {
      const result = await limiter.consume(wallet);

      // Always attach rate-limit headers so clients can self-throttle.
      res.set("X-RateLimit-Limit", String(result.capacity));
      res.set(
        "X-RateLimit-Remaining",
        String(Math.max(0, Math.floor(result.capacity - result.currentLevel))),
      );

      if (result.allowed) {
        return next();
      }

      // --- Request denied ---

      // Flag for Sybil analysis when violations cross the threshold.
      if (result.violations !== undefined) {
        await sybil.evaluate(wallet, result.violations, {
          endpoint: req.originalUrl,
          ip: getRequestIp(req),
        });
      }

      res.set("Retry-After", String(result.retryAfterSeconds));

      return res.status(429).json({
        success: false,
        error: "Rate limit exceeded. You have been temporarily blocked.",
        retryAfterSeconds: result.retryAfterSeconds,
      });
    } catch (err) {
      // If Redis is unavailable, fail open so the API stays usable.
      console.error("[RateLimiter] Redis error – failing open:", err.message);
      return next();
    }
  };
}

module.exports = { createRateLimiter, extractWallet };
