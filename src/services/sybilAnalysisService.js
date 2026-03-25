/**
 * Sybil Analysis Service
 *
 * Tracks wallets that repeatedly exceed rate limits and flags them for
 * review. Flagged wallets are stored in a Redis sorted set keyed by
 * violation count so operators can query the worst offenders first.
 *
 * Redis structures:
 *   sybil:flagged            – sorted set (score = violation count, member = wallet)
 *   sybil:details:{wallet}   – hash with detailed flag metadata
 */

const FLAGGED_SET_KEY = "sybil:flagged";
const DETAIL_KEY_PREFIX = "sybil:details:";

class SybilAnalysisService {
  /**
   * @param {import('ioredis').Redis} redisClient
   * @param {object} [options]
   * @param {number} [options.flagThreshold=3] Violations required for flagging.
   * @param {number} [options.detailTtlSeconds=604800] How long detail records persist (7 days).
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.flagThreshold = options.flagThreshold ?? 3;
    this.detailTtlSeconds = options.detailTtlSeconds ?? 604800;
  }

  /**
   * Evaluate a wallet after a rate-limit violation and flag it if the
   * threshold has been reached.
   *
   * @param {string} wallet
   * @param {number} violations Current cumulative violation count.
   * @param {object} [meta] Extra metadata (IP, endpoint, etc.).
   * @returns {Promise<{flagged: boolean, violations: number}>}
   */
  async evaluate(wallet, violations, meta = {}) {
    const normalizedWallet = wallet.toLowerCase();

    if (violations < this.flagThreshold) {
      return { flagged: false, violations };
    }

    // Add / update in the sorted set (score = violation count).
    await this.redis.zadd(FLAGGED_SET_KEY, violations, normalizedWallet);

    // Store granular details for investigation.
    const detailKey = `${DETAIL_KEY_PREFIX}${normalizedWallet}`;
    await this.redis.hmset(detailKey, {
      wallet: normalizedWallet,
      violations: String(violations),
      flaggedAt: new Date().toISOString(),
      lastEndpoint: meta.endpoint || "",
      lastIp: meta.ip || "",
      reason: "Exceeded rate-limit violation threshold",
    });
    await this.redis.expire(detailKey, this.detailTtlSeconds);

    console.warn(
      `[SybilAnalysis] Wallet ${normalizedWallet} flagged – ${violations} violations`,
    );

    return { flagged: true, violations };
  }

  /**
   * Check whether a wallet was previously flagged.
   *
   * @param {string} wallet
   * @returns {Promise<boolean>}
   */
  async isFlagged(wallet) {
    const score = await this.redis.zscore(
      FLAGGED_SET_KEY,
      wallet.toLowerCase(),
    );
    return score !== null;
  }

  /**
   * Retrieve the detail record for a flagged wallet.
   *
   * @param {string} wallet
   * @returns {Promise<object|null>}
   */
  async getDetail(wallet) {
    const data = await this.redis.hgetall(
      `${DETAIL_KEY_PREFIX}${wallet.toLowerCase()}`,
    );
    return data && Object.keys(data).length > 0 ? data : null;
  }

  /**
   * Return the top N most-violated wallets.
   *
   * @param {number} [count=20]
   * @returns {Promise<Array<{wallet: string, violations: number}>>}
   */
  async getTopFlagged(count = 20) {
    const results = await this.redis.zrevrange(
      FLAGGED_SET_KEY,
      0,
      count - 1,
      "WITHSCORES",
    );
    const entries = [];
    for (let i = 0; i < results.length; i += 2) {
      entries.push({
        wallet: results[i],
        violations: parseInt(results[i + 1], 10),
      });
    }
    return entries;
  }

  /**
   * Remove a wallet from the flagged set (admin clearance).
   *
   * @param {string} wallet
   */
  async unflag(wallet) {
    const w = wallet.toLowerCase();
    await this.redis.zrem(FLAGGED_SET_KEY, w);
    await this.redis.del(`${DETAIL_KEY_PREFIX}${w}`);
  }
}

module.exports = { SybilAnalysisService };
