const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const SandboxService = require('../services/sandboxService');

/**
 * Sandbox-aware database wrapper that provides schema isolation
 */
class SandboxDatabase {
  constructor(filename, sandboxService = null) {
    this.filename = filename;
    this.sandboxService = sandboxService || new SandboxService();
    this.db = null;
    this.isSandboxMode = false;
    this.schemaPrefix = '';
    
    this.initialize();
  }

  async initialize() {
    await this.sandboxService.initialize();
    this.isSandboxMode = this.sandboxService.isSandboxMode;
    this.schemaPrefix = this.sandboxService.getDatabaseSchema();
    
    this.ensureDirectory();
    this.db = new Database(this.filename);
    this.initializeSchema();
  }

  /**
   * Ensure the data directory exists
   */
  ensureDirectory() {
    const dir = path.dirname(this.filename);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Get table name with sandbox prefix if applicable
   */
  getTableName(baseName) {
    return this.schemaPrefix + baseName;
  }

  /**
   * Initialize the database schema with sandbox isolation
   */
  initializeSchema() {
    // Enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON;');

    // Creators table
    const creatorsTable = this.getTableName('creators');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${creatorsTable} (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        sandbox_mode TEXT DEFAULT '${this.isSandboxMode ? 'testnet' : 'mainnet'}'
      );
    `);

    // Creator settings table
    const creatorSettingsTable = this.getTableName('creator_settings');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${creatorSettingsTable} (
        creator_id TEXT PRIMARY KEY,
        flow_rate TEXT NOT NULL,
        currency TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (creator_id) REFERENCES ${creatorsTable}(id)
      );
    `);

    // Videos table
    const videosTable = this.getTableName('videos');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${videosTable} (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded',
        message TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (creator_id) REFERENCES ${creatorsTable}(id)
      );
    `);

    // Subscriptions table
    const subscriptionsTable = this.getTableName('subscriptions');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${subscriptionsTable} (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        subscriber_address TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'bronze',
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_billing_at TEXT,
        is_mock BOOLEAN DEFAULT 0,
        FOREIGN KEY (creator_id) REFERENCES ${creatorsTable}(id)
      );
    `);

    // Mock events table (for sandbox only)
    if (this.isSandboxMode) {
      const mockEventsTable = this.getTableName('mock_events');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${mockEventsTable} (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          subscription_id TEXT,
          data_json TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          source TEXT NOT NULL,
          processed BOOLEAN DEFAULT 0
        );
      `);
    }

    // Notifications table
    const notificationsTable = this.getTableName('notifications');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${notificationsTable} (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        timestamp TEXT NOT NULL,
        read BOOLEAN DEFAULT 0,
        FOREIGN KEY (creator_id) REFERENCES ${creatorsTable}(id)
      );
    `);

    // Webhooks table
    const webhooksTable = this.getTableName('webhooks');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${webhooksTable} (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        events TEXT NOT NULL,
        active BOOLEAN DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (creator_id) REFERENCES ${creatorsTable}(id)
      );
    `);

    console.log(`[Database] Schema initialized with prefix: ${this.schemaPrefix}`);
  }

  /**
   * Insert a creator record
   */
  insertCreator(creatorId) {
    const creatorsTable = this.getTableName('creators');
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ${creatorsTable} (id, created_at, sandbox_mode)
      VALUES (?, ?, ?)
    `);
    return stmt.run(creatorId, new Date().toISOString(), this.isSandboxMode ? 'testnet' : 'mainnet');
  }

  /**
   * Ensure a creator exists
   */
  ensureCreator(creatorId) {
    this.insertCreator(creatorId);
  }

  /**
   * Insert a mock event (sandbox only)
   */
  insertMockEvent(event) {
    if (!this.isSandboxMode) {
      throw new Error('Mock events are only available in sandbox mode');
    }

    const mockEventsTable = this.getTableName('mock_events');
    const stmt = this.db.prepare(`
      INSERT INTO ${mockEventsTable} (id, type, subscription_id, data_json, timestamp, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      event.id,
      event.type,
      event.data.subscriptionId || null,
      JSON.stringify(event.data),
      event.timestamp,
      event.source
    );
  }

  /**
   * Get mock events with pagination
   */
  getMockEvents(limit = 50, offset = 0) {
    if (!this.isSandboxMode) {
      return { events: [], total: 0, hasMore: false };
    }

    const mockEventsTable = this.getTableName('mock_events');
    const eventsStmt = this.db.prepare(`
      SELECT * FROM ${mockEventsTable}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    const events = eventsStmt.all(limit, offset);

    const countStmt = this.db.prepare(`SELECT COUNT(*) as total FROM ${mockEventsTable}`);
    const { total } = countStmt.get();

    return {
      events: events.map(event => ({
        ...event,
        data: JSON.parse(event.data_json)
      })),
      total,
      hasMore: offset + limit < total
    };
  }

  /**
   * Clear mock events (sandbox only)
   */
  clearMockEvents() {
    if (!this.isSandboxMode) {
      throw new Error('Mock events are only available in sandbox mode');
    }

    const mockEventsTable = this.getTableName('mock_events');
    const stmt = this.db.prepare(`DELETE FROM ${mockEventsTable}`);
    return stmt.run();
  }

  /**
   * Insert a subscription record
   */
  insertSubscription(subscription) {
    const subscriptionsTable = this.getTableName('subscriptions');
    const stmt = this.db.prepare(`
      INSERT INTO ${subscriptionsTable} 
      (id, creator_id, subscriber_address, tier, amount, status, created_at, expires_at, last_billing_at, is_mock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      subscription.id,
      subscription.creatorId,
      subscription.subscriberAddress,
      subscription.tier || 'bronze',
      subscription.amount || 0,
      subscription.status || 'active',
      subscription.createdAt || new Date().toISOString(),
      subscription.expiresAt || null,
      subscription.lastBillingAt || null,
      subscription.isMock || false
    );
  }

  /**
   * Get subscriptions by creator
   */
  getSubscriptionsByCreator(creatorId) {
    const subscriptionsTable = this.getTableName('subscriptions');
    const stmt = this.db.prepare(`
      SELECT * FROM ${subscriptionsTable}
      WHERE creator_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(creatorId);
  }

  /**
   * Insert a notification
   */
  insertNotification(notification) {
    const notificationsTable = this.getTableName('notifications');
    const id = notification.id || crypto.randomUUID();
    const timestamp = notification.timestamp || new Date().toISOString();
    
    this.ensureCreator(notification.creatorId);
    
    const stmt = this.db.prepare(`
      INSERT INTO ${notificationsTable} 
      (id, creator_id, type, message, metadata_json, timestamp, read)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    
    stmt.run(
      id,
      notification.creatorId,
      notification.type,
      notification.message,
      JSON.stringify(notification.metadata || {}),
      timestamp
    );
    
    return this.getNotification(id);
  }

  /**
   * Get a notification by ID
   */
  getNotification(id) {
    const notificationsTable = this.getTableName('notifications');
    const stmt = this.db.prepare(`SELECT * FROM ${notificationsTable} WHERE id = ?`);
    return stmt.get(id);
  }

  /**
   * List notifications for a creator
   */
  listNotificationsByCreatorId(creatorId) {
    const notificationsTable = this.getTableName('notifications');
    const stmt = this.db.prepare(`
      SELECT * FROM ${notificationsTable}
      WHERE creator_id = ?
      ORDER BY timestamp DESC, id DESC
    `);
    return stmt.all(creatorId);
  }

  /**
   * Mark notification as read
   */
  markNotificationAsRead(notificationId) {
    const notificationsTable = this.getTableName('notifications');
    this.db.prepare(`UPDATE ${notificationsTable} SET read = 1 WHERE id = ?`).run(notificationId);
    return this.getNotification(notificationId);
  }

  /**
   * Get database statistics
   */
  getStats() {
    const creatorsTable = this.getTableName('creators');
    const subscriptionsTable = this.getTableName('subscriptions');
    const videosTable = this.getTableName('videos');
    const notificationsTable = this.getTableName('notifications');
    
    const creatorCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${creatorsTable}`).get().count;
    const subscriptionCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${subscriptionsTable}`).get().count;
    const videoCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${videosTable}`).get().count;
    const notificationCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${notificationsTable}`).get().count;
    
    let mockEventCount = 0;
    if (this.isSandboxMode) {
      const mockEventsTable = this.getTableName('mock_events');
      mockEventCount = this.db.prepare(`SELECT COUNT(*) as count FROM ${mockEventsTable}`).get().count;
    }
    
    return {
      mode: this.isSandboxMode ? 'sandbox' : 'production',
      schemaPrefix: this.schemaPrefix,
      creators: creatorCount,
      subscriptions: subscriptionCount,
      videos: videoCount,
      notifications: notificationCount,
      mockEvents: mockEventCount
    };
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }

  /**
   * Get the underlying database instance
   */
  getDatabase() {
    return this.db;
  }
}

module.exports = SandboxDatabase;
