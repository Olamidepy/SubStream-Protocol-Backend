/**
 * Tests for the Leaky Bucket rate limiter, Sybil analysis, and middleware.
 *
 * Uses a simple in-memory Redis mock so the suite runs without a real Redis
 * instance.
 */

const {
  LeakyBucketRateLimiter,
} = require("./src/services/leakyBucketRateLimiter");
const { SybilAnalysisService } = require("./src/services/sybilAnalysisService");
const {
  createRateLimiter,
  extractWallet,
} = require("./middleware/rateLimiter");

// ---------------------------------------------------------------------------
// Minimal Redis mock (supports only the commands the services actually use)
// ---------------------------------------------------------------------------
class RedisMock {
  constructor() {
    this.store = new Map(); // key -> string value
    this.hashes = new Map(); // key -> Map(field -> value)
    this.sortedSets = new Map(); // key -> Map(member -> score)
    this.ttls = new Map(); // key -> expiry timestamp
  }

  // --- strings ---
  async get(key) {
    this._evict(key);
    return this.store.get(key) ?? null;
  }
  async set(key, value, ...args) {
    this.store.set(key, String(value));
    if (args[0] === "EX" && typeof args[1] === "number") {
      this.ttls.set(key, Date.now() + args[1] * 1000);
    }
    return "OK";
  }
  async incr(key) {
    const cur = parseInt(this.store.get(key) || "0", 10);
    const next = cur + 1;
    this.store.set(key, String(next));
    return next;
  }
  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
      if (this.hashes.delete(k)) count++;
      if (this.sortedSets.delete(k)) count++;
      this.ttls.delete(k);
    }
    return count;
  }
  async ttl(key) {
    const ex = this.ttls.get(key);
    if (!ex) return -1;
    const remaining = Math.ceil((ex - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }
  async expire(key, seconds) {
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  // --- hashes ---
  async hmset(key, obj) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key);
    for (const [f, v] of Object.entries(obj)) h.set(f, String(v));
    return "OK";
  }
  async hmget(key, ...fields) {
    const h = this.hashes.get(key);
    return fields.map((f) => (h ? (h.get(f) ?? null) : null));
  }
  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h) return {};
    const result = {};
    for (const [f, v] of h) result[f] = v;
    return result;
  }

  // --- sorted sets ---
  async zadd(key, score, member) {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    this.sortedSets.get(key).set(member, score);
    return 1;
  }
  async zscore(key, member) {
    const ss = this.sortedSets.get(key);
    if (!ss) return null;
    const s = ss.get(member);
    return s !== undefined ? String(s) : null;
  }
  async zrevrange(key, start, stop, withScores) {
    const ss = this.sortedSets.get(key);
    if (!ss) return [];
    const entries = [...ss.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1);
    const result = [];
    for (const [member, score] of entries) {
      result.push(member);
      if (withScores === "WITHSCORES") result.push(String(score));
    }
    return result;
  }
  async zrem(key, member) {
    const ss = this.sortedSets.get(key);
    if (!ss) return 0;
    return ss.delete(member) ? 1 : 0;
  }

  // --- eval (Lua emulation) ---
  async eval(script, numkeys, key, capacity, leakRate, now) {
    capacity = Number(capacity);
    leakRate = Number(leakRate);
    now = Number(now);

    const [levelStr, lastDripStr] = await this.hmget(key, "level", "lastDrip");
    let level = parseFloat(levelStr) || 0;
    const lastDrip = parseFloat(lastDripStr) || now;

    const elapsed = now - lastDrip;
    const leaked = elapsed * leakRate;
    level = Math.max(0, level - leaked);

    if (level + 1 > capacity) {
      await this.hmset(key, { level: String(level), lastDrip: String(now) });
      return [0, String(level), String(capacity)];
    }

    level = level + 1;
    await this.hmset(key, { level: String(level), lastDrip: String(now) });
    return [1, String(level), String(capacity)];
  }

  // TTL eviction helper
  _evict(key) {
    const ex = this.ttls.get(key);
    if (ex && Date.now() > ex) {
      this.store.delete(key);
      this.hashes.delete(key);
      this.ttls.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// LeakyBucketRateLimiter
// ---------------------------------------------------------------------------
describe("LeakyBucketRateLimiter", () => {
  let redis;
  let limiter;

  beforeEach(() => {
    redis = new RedisMock();
    limiter = new LeakyBucketRateLimiter(redis, {
      bucketCapacity: 5,
      leakRatePerSecond: 1,
      blockDurationSeconds: 10,
      sybilThreshold: 2,
    });
  });

  it("allows requests within capacity", async () => {
    const result = await limiter.consume("WALLET_A");
    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.currentLevel).toBeGreaterThan(0);
  });

  it("rejects and blocks when bucket overflows", async () => {
    // Fill bucket to capacity.
    for (let i = 0; i < 5; i++) {
      const r = await limiter.consume("WALLET_B");
      expect(r.allowed).toBe(true);
    }

    // Next request should be rejected.
    const rejected = await limiter.consume("WALLET_B");
    expect(rejected.allowed).toBe(false);
    expect(rejected.blocked).toBe(true);
    expect(rejected.retryAfterSeconds).toBe(10);
  });

  it("returns blocked status on subsequent attempts while blocked", async () => {
    for (let i = 0; i < 5; i++) await limiter.consume("WALLET_C");
    await limiter.consume("WALLET_C"); // triggers block

    const attempt = await limiter.consume("WALLET_C");
    expect(attempt.allowed).toBe(false);
    expect(attempt.blocked).toBe(true);
  });

  it("tracks violations", async () => {
    for (let i = 0; i < 5; i++) await limiter.consume("WALLET_D");
    const overflow = await limiter.consume("WALLET_D");
    expect(overflow.violations).toBe(1);

    const count = await limiter.getViolationCount("WALLET_D");
    expect(count).toBe(1);
  });

  it("isBlocked returns correct state", async () => {
    expect(await limiter.isBlocked("WALLET_E")).toBe(false);
    for (let i = 0; i < 5; i++) await limiter.consume("WALLET_E");
    await limiter.consume("WALLET_E");
    expect(await limiter.isBlocked("WALLET_E")).toBe(true);
  });

  it("unblock clears the block", async () => {
    for (let i = 0; i < 5; i++) await limiter.consume("WALLET_F");
    await limiter.consume("WALLET_F");
    expect(await limiter.isBlocked("WALLET_F")).toBe(true);

    await limiter.unblock("WALLET_F");
    expect(await limiter.isBlocked("WALLET_F")).toBe(false);
  });

  it("reset clears all state", async () => {
    for (let i = 0; i < 5; i++) await limiter.consume("WALLET_G");
    await limiter.consume("WALLET_G");
    await limiter.reset("WALLET_G");

    expect(await limiter.isBlocked("WALLET_G")).toBe(false);
    expect(await limiter.getViolationCount("WALLET_G")).toBe(0);

    const fresh = await limiter.consume("WALLET_G");
    expect(fresh.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SybilAnalysisService
// ---------------------------------------------------------------------------
describe("SybilAnalysisService", () => {
  let redis;
  let sybil;

  beforeEach(() => {
    redis = new RedisMock();
    sybil = new SybilAnalysisService(redis, { flagThreshold: 3 });
  });

  it("does not flag when below threshold", async () => {
    const result = await sybil.evaluate("WALLET_1", 2);
    expect(result.flagged).toBe(false);
  });

  it("flags when violations meet threshold", async () => {
    const result = await sybil.evaluate("WALLET_2", 3, {
      endpoint: "/api/cdn/token",
      ip: "1.2.3.4",
    });
    expect(result.flagged).toBe(true);
    expect(await sybil.isFlagged("WALLET_2")).toBe(true);
  });

  it("stores detail metadata", async () => {
    await sybil.evaluate("WALLET_3", 5, {
      endpoint: "/api/test",
      ip: "10.0.0.1",
    });
    const detail = await sybil.getDetail("WALLET_3");
    expect(detail).not.toBeNull();
    expect(detail.violations).toBe("5");
    expect(detail.lastEndpoint).toBe("/api/test");
    expect(detail.lastIp).toBe("10.0.0.1");
  });

  it("getTopFlagged returns ranked wallets", async () => {
    await sybil.evaluate("w1", 3);
    await sybil.evaluate("w2", 10);
    await sybil.evaluate("w3", 5);

    const top = await sybil.getTopFlagged(2);
    expect(top).toHaveLength(2);
    expect(top[0].wallet).toBe("w2");
    expect(top[0].violations).toBe(10);
  });

  it("unflag removes the wallet from flagged set", async () => {
    await sybil.evaluate("WALLET_4", 4);
    expect(await sybil.isFlagged("WALLET_4")).toBe(true);
    await sybil.unflag("WALLET_4");
    expect(await sybil.isFlagged("WALLET_4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractWallet helper
// ---------------------------------------------------------------------------
describe("extractWallet", () => {
  it("prefers req.user.address", () => {
    const req = {
      user: { address: "0xABC" },
      body: { walletAddress: "0xOther" },
      query: {},
    };
    expect(extractWallet(req)).toBe("0xABC");
  });

  it("falls back to req.user.publicKey", () => {
    const req = { user: { publicKey: "GPUBKEY" }, body: {}, query: {} };
    expect(extractWallet(req)).toBe("GPUBKEY");
  });

  it("falls back to req.body.walletAddress", () => {
    const req = { body: { walletAddress: "0xBody" }, query: {} };
    expect(extractWallet(req)).toBe("0xBody");
  });

  it("falls back to query params", () => {
    const req = { body: {}, query: { publicKey: "GQUERY" } };
    expect(extractWallet(req)).toBe("GQUERY");
  });

  it("returns null when no wallet is present", () => {
    const req = { body: {}, query: {} };
    expect(extractWallet(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createRateLimiter middleware
// ---------------------------------------------------------------------------
describe("createRateLimiter middleware", () => {
  let redis;
  let middleware;

  const mockRes = () => {
    const res = {
      _status: null,
      _json: null,
      _headers: {},
      status(code) {
        res._status = code;
        return res;
      },
      json(body) {
        res._json = body;
        return res;
      },
      set(key, value) {
        res._headers[key] = value;
      },
    };
    return res;
  };

  beforeEach(() => {
    redis = new RedisMock();
    middleware = createRateLimiter({
      redis,
      bucketCapacity: 3,
      leakRatePerSecond: 1,
      blockDurationSeconds: 10,
      sybilThreshold: 2,
    });
  });

  it("throws if no redis client is provided", () => {
    expect(() => createRateLimiter({})).toThrow("redis client");
  });

  it("passes through when no wallet is identified", async () => {
    const req = { body: {}, query: {} };
    const res = mockRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows requests within the limit", async () => {
    const req = {
      user: { address: "0xFan" },
      body: {},
      query: {},
      originalUrl: "/api/test",
    };
    const res = mockRes();
    const next = jest.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._headers["X-RateLimit-Limit"]).toBeDefined();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      const req = {
        user: { address: "0xBot" },
        body: {},
        query: {},
        originalUrl: "/api/x",
      };
      await middleware(req, mockRes(), jest.fn());
    }

    const req = {
      user: { address: "0xBot" },
      body: {},
      query: {},
      originalUrl: "/api/x",
    };
    const res = mockRes();
    const next = jest.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(429);
    expect(res._json.error).toMatch(/Rate limit exceeded/);
    expect(res._headers["Retry-After"]).toBeDefined();
  });

  it("fails open when Redis throws", async () => {
    const brokenRedis = {
      get: () => {
        throw new Error("connection refused");
      },
      eval: () => {
        throw new Error("connection refused");
      },
    };

    const mw = createRateLimiter({ redis: brokenRedis, bucketCapacity: 5 });
    const req = {
      user: { address: "0xOops" },
      body: {},
      query: {},
      originalUrl: "/api/y",
    };
    const res = mockRes();
    const next = jest.fn();
    await mw(req, res, next);

    // Should call next() instead of crashing.
    expect(next).toHaveBeenCalled();
  });
});
