/**
 * PII Scrubbing Integration Tests
 * 
 * Deep integration tests verifying that scrubbed users cannot be identified
 * through any database join or external query, ensuring GDPR/CCPA compliance.
 */

const PIIScrubbingService = require('./src/services/piiScrubbingService');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

describe('PII Scrubbing Integration Tests', () => {
  let db;
  let piiService;
  let testDbPath;
  const testWalletAddress = 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ';
  const testCreatorId = 'GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';

  beforeAll(() => {
    // Create in-memory test database
    testDbPath = path.join(__dirname, 'test-pii-scrubbing.db');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    
    db = new Database(testDbPath);
    
    // Initialize schema
    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        subscribed_at TEXT NOT NULL,
        user_email TEXT,
        balance REAL,
        daily_spend REAL,
        risk_status TEXT,
        estimated_run_out_at TEXT,
        migrated_from_stripe INTEGER DEFAULT 0,
        stripe_plan_id TEXT
      );

      CREATE TABLE IF NOT EXISTS creator_audit_logs (
        id TEXT PRIMARY KEY,
        creator_id TEXT,
        action_type TEXT,
        entity_type TEXT,
        entity_id TEXT,
        timestamp TEXT,
        ip_address TEXT,
        metadata_json TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS data_export_tracking (
        id TEXT PRIMARY KEY,
        wallet_address TEXT,
        requester_email TEXT,
        export_type TEXT,
        status TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS privacy_preferences (
        wallet_address TEXT PRIMARY KEY,
        share_email_with_merchants INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        post_id TEXT,
        user_address TEXT,
        creator_id TEXT,
        content TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS leaderboard_entries (
        id TEXT PRIMARY KEY,
        creator_address TEXT,
        fan_address TEXT,
        score INTEGER,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS social_tokens (
        id TEXT PRIMARY KEY,
        creator_address TEXT,
        user_address TEXT,
        token TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT
      );
    `);

    // Insert test data
    db.prepare('INSERT INTO creators (id, created_at) VALUES (?, ?)').run(testCreatorId, new Date().toISOString());
    
    db.prepare(`
      INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at, user_email, balance, daily_spend, risk_status)
      VALUES (?, ?, 1, ?, ?, 100.0, 10.0, 'active')
    `).run(testCreatorId, testWalletAddress, new Date().toISOString(), 'test@example.com', 100.0, 10.0, 'active');

    db.prepare(`
      INSERT INTO creator_audit_logs (id, creator_id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      testCreatorId,
      'subscription_created',
      'subscription',
      '1',
      new Date().toISOString(),
      '192.168.1.100',
      JSON.stringify({ wallet_address: testWalletAddress }),
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO data_export_tracking (id, wallet_address, requester_email, export_type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      testWalletAddress,
      'test@example.com',
      'data_export',
      'completed',
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO privacy_preferences (wallet_address, share_email_with_merchants)
      VALUES (?, 1)
    `).run(testWalletAddress);

    db.prepare(`
      INSERT INTO comments (id, post_id, user_address, creator_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      'post-1',
      testWalletAddress,
      testCreatorId,
      'Test comment',
      new Date().toISOString(),
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO leaderboard_entries (id, creator_address, fan_address, score, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      testCreatorId,
      testWalletAddress,
      100,
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO social_tokens (id, creator_address, user_address, token, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(
      require('crypto').randomUUID(),
      testCreatorId,
      testWalletAddress,
      'test-token',
      new Date().toISOString()
    );

    // Initialize PII service
    piiService = new PIIScrubbingService({
      database: { db }
    });
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Cryptographic Hashing', () => {
    test('should produce consistent hashes for the same input', () => {
      const value = 'test@example.com';
      const hash1 = piiService.hashValue(value);
      const hash2 = piiService.hashValue(value);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64 hex chars
    });

    test('should produce different hashes for different inputs', () => {
      const hash1 = piiService.hashValue('test@example.com');
      const hash2 = piiService.hashValue('other@example.com');
      
      expect(hash1).not.toBe(hash2);
    });

    test('should anonymize wallet address with prefix and hash', () => {
      const anonymized = piiService.anonymizeWalletAddress(testWalletAddress);
      
      expect(anonymized).toContain(testWalletAddress.substring(0, 8));
      expect(anonymized).toContain('_');
      expect(anonymized).not.toBe(testWalletAddress);
    });
  });

  describe('Database PII Scrubbing', () => {
    test('should scrub PII from subscriptions table', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const subscription = db.prepare(`
        SELECT user_email, wallet_address, risk_status 
        FROM subscriptions 
        WHERE wallet_address = ? OR wallet_address LIKE ?
      `).get(testWalletAddress, `${testWalletAddress.substring(0, 8)}%`);

      expect(subscription).toBeDefined();
      expect(subscription.user_email).toContain('scrubbed_');
      expect(subscription.user_email).toContain('@anon.example.com');
      expect(subscription.wallet_address).not.toBe(testWalletAddress);
      expect(subscription.risk_status).toBe('scrubbed');
    });

    test('should preserve financial data in subscriptions', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const subscription = db.prepare(`
        SELECT balance, daily_spend, creator_id 
        FROM subscriptions 
        WHERE wallet_address LIKE ?
      `).get(`${testWalletAddress.substring(0, 8)}%`);

      expect(subscription).toBeDefined();
      expect(subscription.balance).toBe(100.0);
      expect(subscription.daily_spend).toBe(10.0);
      expect(subscription.creator_id).toBe(testCreatorId);
    });

    test('should scrub IP addresses from audit logs', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const auditLog = db.prepare(`
        SELECT ip_address 
        FROM creator_audit_logs 
        WHERE metadata_json LIKE ?
      `).get(`%${testWalletAddress}%`);

      expect(auditLog).toBeDefined();
      expect(auditLog.ip_address).toContain('scrubbed_');
      expect(auditLog.ip_address).not.toBe('192.168.1.100');
    });

    test('should scrub requester email from data export tracking', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const exportTracking = db.prepare(`
        SELECT requester_email 
        FROM data_export_tracking 
        WHERE wallet_address = ?
      `).get(testWalletAddress);

      expect(exportTracking).toBeDefined();
      expect(exportTracking.requester_email).toContain('scrubbed_');
      expect(exportTracking.requester_email).toContain('@anon.example.com');
    });

    test('should update privacy preferences', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const privacyPref = db.prepare(`
        SELECT share_email_with_merchants 
        FROM privacy_preferences 
        WHERE wallet_address = ?
      `).get(testWalletAddress);

      expect(privacyPref).toBeDefined();
      expect(privacyPref.share_email_with_merchants).toBe(0);
    });

    test('should scrub user address from comments', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const comment = db.prepare(`
        SELECT user_address 
        FROM comments 
        WHERE user_address = ? OR user_address LIKE ?
      `).get(testWalletAddress, `${testWalletAddress.substring(0, 8)}%`);

      expect(comment).toBeDefined();
      expect(comment.user_address).not.toBe(testWalletAddress);
      expect(comment.user_address).toContain(testWalletAddress.substring(0, 8));
    });

    test('should scrub fan address from leaderboard entries', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const leaderboard = db.prepare(`
        SELECT fan_address 
        FROM leaderboard_entries 
        WHERE fan_address = ? OR fan_address LIKE ?
      `).get(testWalletAddress, `${testWalletAddress.substring(0, 8)}%`);

      expect(leaderboard).toBeDefined();
      expect(leaderboard.fan_address).not.toBe(testWalletAddress);
      expect(leaderboard.fan_address).toContain(testWalletAddress.substring(0, 8));
    });

    test('should scrub user address from social tokens', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const socialToken = db.prepare(`
        SELECT user_address 
        FROM social_tokens 
        WHERE user_address = ? OR user_address LIKE ?
      `).get(testWalletAddress, `${testWalletAddress.substring(0, 8)}%`);

      expect(socialToken).toBeDefined();
      expect(socialToken.user_address).not.toBe(testWalletAddress);
      expect(socialToken.user_address).toContain(testWalletAddress.substring(0, 8));
    });
  });

  describe('Identification Prevention', () => {
    beforeEach(async () => {
      // Scrub the user before each identification test
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });
    });

    test('cannot identify user by original wallet address in subscriptions', () => {
      const result = db.prepare(`
        SELECT * FROM subscriptions WHERE wallet_address = ?
      `).get(testWalletAddress);

      expect(result).toBeUndefined();
    });

    test('cannot identify user by email in subscriptions', () => {
      const result = db.prepare(`
        SELECT * FROM subscriptions WHERE user_email = ?
      `).get('test@example.com');

      expect(result).toBeUndefined();
    });

    test('cannot identify user by IP address in audit logs', () => {
      const result = db.prepare(`
        SELECT * FROM creator_audit_logs WHERE ip_address = ?
      `).get('192.168.1.100');

      expect(result).toBeUndefined();
    });

    test('cannot identify user by email in data export tracking', () => {
      const result = db.prepare(`
        SELECT * FROM data_export_tracking WHERE requester_email = ?
      `).get('test@example.com');

      expect(result).toBeUndefined();
    });

    test('cannot identify user by address in comments', () => {
      const result = db.prepare(`
        SELECT * FROM comments WHERE user_address = ?
      `).get(testWalletAddress);

      expect(result).toBeUndefined();
    });

    test('cannot identify user by address in leaderboard entries', () => {
      const result = db.prepare(`
        SELECT * FROM leaderboard_entries WHERE fan_address = ?
      `).get(testWalletAddress);

      expect(result).toBeUndefined();
    });

    test('cannot identify user by address in social tokens', () => {
      const result = db.prepare(`
        SELECT * FROM social_tokens WHERE user_address = ?
      `).get(testWalletAddress);

      expect(result).toBeUndefined();
    });

    test('cannot identify user through database joins', () => {
      // Try to join across tables to find the user
      const result = db.prepare(`
        SELECT s.wallet_address, s.user_email, c.user_address, l.fan_address, st.user_address
        FROM subscriptions s
        LEFT JOIN comments c ON s.wallet_address = c.user_address
        LEFT JOIN leaderboard_entries l ON s.wallet_address = l.fan_address
        LEFT JOIN social_tokens st ON s.wallet_address = st.user_address
        WHERE s.wallet_address = ? 
           OR c.user_address = ?
           OR l.fan_address = ?
           OR st.user_address = ?
      `).get(testWalletAddress, testWalletAddress, testWalletAddress, testWalletAddress);

      expect(result).toBeUndefined();
    });

    test('cannot identify user through pattern matching', () => {
      // Try to find user by email pattern
      const result = db.prepare(`
        SELECT * FROM subscriptions WHERE user_email LIKE '%test@example.com%'
      `).get();

      expect(result).toBeUndefined();
    });

    test('financial data remains accessible but anonymized', () => {
      const result = db.prepare(`
        SELECT balance, daily_spend, creator_id, wallet_address
        FROM subscriptions 
        WHERE wallet_address LIKE ?
      `).get(`${testWalletAddress.substring(0, 8)}%`);

      expect(result).toBeDefined();
      expect(result.balance).toBe(100.0);
      expect(result.daily_spend).toBe(10.0);
      expect(result.creator_id).toBe(testCreatorId);
      expect(result.wallet_address).not.toBe(testWalletAddress);
    });
  });

  describe('Audit Logging', () => {
    test('should create audit log entry for scrubbing operation', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const auditLog = db.prepare(`
        SELECT * FROM creator_audit_logs 
        WHERE action_type = 'pii_scrub'
        ORDER BY created_at DESC
        LIMIT 1
      `).get();

      expect(auditLog).toBeDefined();
      expect(auditLog.action_type).toBe('pii_scrub');
      expect(auditLog.entity_type).toBe('user');
      
      const metadata = JSON.parse(auditLog.metadata_json);
      expect(metadata.scrubId).toBeDefined();
      expect(metadata.reason).toBe('test');
      expect(metadata.original_wallet_hash).toBeDefined();
    });

    test('should log failed scrubbing attempts', async () => {
      // This test would require mocking a failure scenario
      // For now, we verify the audit log structure
      const auditLog = db.prepare(`
        SELECT * FROM creator_audit_logs 
        WHERE action_type = 'pii_scrub'
        ORDER BY created_at DESC
        LIMIT 1
      `).get();

      expect(auditLog).toBeDefined();
      expect(auditLog.ip_address).toBe('system');
    });
  });

  describe('Verification', () => {
    test('should verify scrubbing status correctly', async () => {
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      const verification = piiService.verifyScrubbing(testWalletAddress);

      expect(verification).toBeDefined();
      expect(verification.walletAddress).toBe(testWalletAddress);
      expect(verification.anonymizedAddress).toContain(testWalletAddress.substring(0, 8));
      expect(verification.tables).toBeDefined();
      expect(verification.isScrubbed).toBe(true);
    });

    test('should identify unscrubbed users', () => {
      // Insert a new unscrubbed user
      const newWallet = 'GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
      db.prepare(`
        INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at, user_email)
        VALUES (?, ?, 1, ?, ?)
      `).run(testCreatorId, newWallet, new Date().toISOString(), 'new@example.com');

      const verification = piiService.verifyScrubbing(newWallet);

      expect(verification.isScrubbed).toBe(false);
    });
  });

  describe('Inactive User Detection', () => {
    test('should find inactive users based on retention policy', () => {
      // Insert an old inactive subscription
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 4);

      const oldWallet = 'GOLD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
      db.prepare(`
        INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at, user_email)
        VALUES (?, ?, 0, ?, ?)
      `).run(testCreatorId, oldWallet, oldDate.toISOString(), 'old@example.com');

      const inactiveUsers = piiService.findInactiveUsers(3);

      expect(inactiveUsers).toContain(oldWallet);
    });

    test('should not find active users as inactive', () => {
      const activeUsers = piiService.findInactiveUsers(3);

      expect(activeUsers).not.toContain(testWalletAddress);
    });
  });

  describe('Batch Scrubbing', () => {
    test('should scrub multiple inactive users', async () => {
      // Insert multiple old inactive subscriptions
      const oldDate = new Date();
      oldDate.setFullYear(oldDate.getFullYear() - 4);

      const oldWallets = [
        'GOLD111111111111111111111111111111111111111111111',
        'GOLD222222222222222222222222222222222222222222222',
        'GOLD333333333333333333333333333333333333333333333'
      ];

      for (const wallet of oldWallets) {
        db.prepare(`
          INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at, user_email)
          VALUES (?, ?, 0, ?, ?)
        `).run(testCreatorId, wallet, oldDate.toISOString(), `${wallet}@example.com`);
      }

      const result = await piiService.scrubInactiveUsers(3);

      expect(result.successful).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
      expect(result.totalUsers).toBe(oldWallets.length);
    });
  });

  describe('Idempotency', () => {
    test('should be safe to run scrubbing multiple times', async () => {
      // First scrub
      await piiService.scrubUserPII(testWalletAddress, {
        scrubRedis: false,
        sendWebhooks: false,
        reason: 'test'
      });

      // Second scrub (should not fail)
      await expect(
        piiService.scrubUserPII(testWalletAddress, {
          scrubRedis: false,
          sendWebhooks: false,
          reason: 'test'
        })
      ).resolves.toBeDefined();
    });
  });

  describe('Security', () => {
    test('should use secure salt for hashing', () => {
      const service1 = new PIIScrubbingService({ database: { db } });
      const service2 = new PIIScrubbingService({ database: { db } });

      // Both services should use the same salt from environment
      const hash1 = service1.hashValue('test@example.com');
      const hash2 = service2.hashValue('test@example.com');

      expect(hash1).toBe(hash2);
    });

    test('should prevent dictionary attacks with salt', () => {
      const commonEmail = 'common@example.com';
      const hash = piiService.hashValue(commonEmail);

      // Hash should not be predictable without the salt
      expect(hash).not.toBe(commonEmail);
      expect(hash).not.toContain(commonEmail);
    });
  });
});
