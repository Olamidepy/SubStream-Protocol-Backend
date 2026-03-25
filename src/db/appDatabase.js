const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

/**
 * SQLite-backed application database wrapper.
 */
class AppDatabase {
  /**
   * @param {string} filename SQLite filename or `:memory:`.
   */
  constructor(filename) {
    this.filename = filename;
    this.ensureDirectory();
    this.db = new DatabaseSync(filename);
    this.initializeSchema();
    this.ensureSubscriberCountColumn();
  }

  /**
   * Ensure the database directory exists for file-backed databases.
   *
   * @returns {void}
   */
  ensureDirectory() {
    if (this.filename === ':memory:') {
      return;
    }

    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
  }

  /**
   * Initialize all application tables and indexes.
   *
   * @returns {void}
   */
  initializeSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_settings (
        creator_id TEXT PRIMARY KEY REFERENCES creators(id),
        flow_rate TEXT NOT NULL,
        currency TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        title TEXT,
        visibility TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coop_splits (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        split_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_audit_logs (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        action_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        creator_id TEXT NOT NULL REFERENCES creators(id),
        wallet_address TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        subscribed_at TEXT NOT NULL,
        unsubscribed_at TEXT,
        PRIMARY KEY (creator_id, wallet_address)
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        creator_id TEXT NOT NULL REFERENCES creators(id),
        wallet_address TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        subscribed_at TEXT NOT NULL,
        unsubscribed_at TEXT,
        PRIMARY KEY (creator_id, wallet_address)
      );

      CREATE INDEX IF NOT EXISTS idx_creator_audit_logs_creator_timestamp
      ON creator_audit_logs (creator_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        user_address TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments (post_id);
      CREATE INDEX IF NOT EXISTS idx_comments_creator_id ON comments (creator_id);
      CREATE INDEX IF NOT EXISTS idx_comments_user_address ON comments (user_address);
    `);
  }

  /**
   * Ensure the creators table has a subscriber_count column.
   * This is a noop for in-memory DBs that already have the column.
   */
  ensureSubscriberCountColumn() {
    try {
      const info = this.db
        .prepare("PRAGMA table_info(creators);")
        .all();

      const hasColumn = info.some((col) => col.name === 'subscriber_count');

      if (!hasColumn) {
        // Add the column with a default of 0
        this.db.exec(`ALTER TABLE creators ADD COLUMN subscriber_count INTEGER DEFAULT 0`);
      }
    } catch (error) {
      // If anything goes wrong, log and continue — schema migrations
      // should be non-fatal for existing deployments in this simple codebase.
      // eslint-disable-next-line no-console
      console.warn('ensureSubscriberCountColumn failed:', error.message);
    }
  }

  /**
   * Execute work inside a database transaction.
   *
   * @template T
   * @param {() => T} callback Work to execute.
   * @returns {T}
   */
  transaction(callback) {
    this.db.exec('BEGIN');

    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Ensure a creator row exists.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {void}
   */
  ensureCreator(creatorId) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO creators (id, created_at)
        VALUES (?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      )
      .run(creatorId, now);
  }

  /**
   * Seed a video for tests or local setup.
   *
   * @param {{id: string, creatorId: string, title?: string, visibility: string}} video Video seed.
   * @returns {void}
   */
  seedVideo(video) {
    this.ensureCreator(video.creatorId);
    this.db
      .prepare(
        `
        INSERT INTO videos (id, creator_id, title, visibility, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        video.id,
        video.creatorId,
        video.title || null,
        video.visibility,
        new Date().toISOString(),
      );
  }

  /**
   * Seed a co-op split for tests or local setup.
   *
   * @param {{id: string, creatorId: string, splits: object[]}} split Co-op split seed.
   * @returns {void}
   */
  seedCoopSplit(split) {
    this.ensureCreator(split.creatorId);
    this.db
      .prepare(
        `
        INSERT INTO coop_splits (id, creator_id, split_json, updated_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(split.id, split.creatorId, JSON.stringify(split.splits), new Date().toISOString());
  }

  /**
   * Seed creator settings for tests or local setup.
   *
   * @param {{creatorId: string, flowRate: string, currency?: string}} settings Settings seed.
   * @returns {void}
   */
  seedCreatorSettings(settings) {
    this.ensureCreator(settings.creatorId);
    this.db
      .prepare(
        `
        INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(creator_id) DO UPDATE SET
          flow_rate = excluded.flow_rate,
          currency = excluded.currency,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        settings.creatorId,
        settings.flowRate,
        settings.currency || null,
        new Date().toISOString(),
      );
  }

  /**
   * Get creator settings for a creator.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {object|null}
   */
  getCreatorSettings(creatorId) {
    const row = this.db
      .prepare(
        `
        SELECT creator_id AS creatorId, flow_rate AS flowRate, currency, updated_at AS updatedAt
        FROM creator_settings
        WHERE creator_id = ?
      `,
      )
      .get(creatorId);

    return row || null;
  }

  /**
   * Create or update creator settings.
   *
   * @param {{creatorId: string, flowRate: string, currency: string|null, updatedAt: string}} settings Settings data.
   * @returns {object}
   */
  upsertCreatorSettings(settings) {
    this.ensureCreator(settings.creatorId);
    this.db
      .prepare(
        `
        INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(creator_id) DO UPDATE SET
          flow_rate = excluded.flow_rate,
          currency = excluded.currency,
          updated_at = excluded.updated_at
      `,
      )
      .run(settings.creatorId, settings.flowRate, settings.currency, settings.updatedAt);

    return this.getCreatorSettings(settings.creatorId);
  }

  /**
   * Fetch a video.
   *
   * @param {string} videoId Video identifier.
   * @returns {object|null}
   */
  getVideoById(videoId) {
    const row = this.db
      .prepare(
        `
        SELECT id, creator_id AS creatorId, title, visibility, updated_at AS updatedAt
        FROM videos
        WHERE id = ?
      `,
      )
      .get(videoId);

    return row || null;
  }

  /**
   * Update the visibility of an existing video.
   *
   * @param {{videoId: string, visibility: string, updatedAt: string}} input Update payload.
   * @returns {object}
   */
  updateVideoVisibility(input) {
    this.db
      .prepare(
        `
        UPDATE videos
        SET visibility = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(input.visibility, input.updatedAt, input.videoId);

    return this.getVideoById(input.videoId);
  }

  /**
   * Fetch a co-op split by identifier.
   *
   * @param {string} splitId Split identifier.
   * @returns {object|null}
   */
  getCoopSplitById(splitId) {
    const row = this.db
      .prepare(
        `
        SELECT id, creator_id AS creatorId, split_json AS splitJson, updated_at AS updatedAt
        FROM coop_splits
        WHERE id = ?
      `,
      )
      .get(splitId);

    if (!row) {
      return null;
    }

    return {
      ...row,
      splits: JSON.parse(row.splitJson),
    };
  }

  /**
   * Update an existing co-op split.
   *
   * @param {{splitId: string, splits: object[], updatedAt: string}} input Update payload.
   * @returns {object}
   */
  updateCoopSplit(input) {
    this.db
      .prepare(
        `
        UPDATE coop_splits
        SET split_json = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(JSON.stringify(input.splits), input.updatedAt, input.splitId);

    return this.getCoopSplitById(input.splitId);
  }

  /**
   * Insert an immutable audit log entry.
   *
   * @param {{creatorId: string, actionType: string, entityType: string, entityId: string, timestamp: string, ipAddress: string, metadata: object}} entry Audit log payload.
   * @returns {object}
   */
  insertAuditLog(entry) {
    const id = crypto.randomUUID();
    this.ensureCreator(entry.creatorId);
    this.db
      .prepare(
        `
        INSERT INTO creator_audit_logs (
          id,
          creator_id,
          action_type,
          entity_type,
          entity_id,
          timestamp,
          ip_address,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        entry.creatorId,
        entry.actionType,
        entry.entityType,
        entry.entityId,
        entry.timestamp,
        entry.ipAddress,
        JSON.stringify(entry.metadata || {}),
        entry.timestamp,
      );

    return this.db
      .prepare(
        `
        SELECT
          id,
          creator_id AS creatorId,
          action_type AS actionType,
          entity_type AS entityType,
          entity_id AS entityId,
          timestamp,
          ip_address AS ipAddress,
          metadata_json AS metadataJson,
          created_at AS createdAt
        FROM creator_audit_logs
        WHERE id = ?
      `,
      )
      .get(id);
  }

  /**
   * List audit logs for a creator in reverse chronological order.
   *
   * @param {string} creatorId Creator identifier.
   * @returns {object[]}
   */
  listAuditLogsByCreatorId(creatorId) {
    return this.db
      .prepare(
        `
        SELECT
          id,
          creator_id AS creatorId,
          action_type AS actionType,
          entity_type AS entityType,
          entity_id AS entityId,
          timestamp,
          ip_address AS ipAddress,
          metadata_json AS metadataJson,
          created_at AS createdAt
        FROM creator_audit_logs
        WHERE creator_id = ?
        ORDER BY timestamp DESC, id DESC
      `,
      )
      .all(creatorId);
  }

  /**
   * Get the cached subscriber count for a creator.
   * Ensures the creator row exists and returns a number (0 if missing).
   *
   * @param {string} creatorId
   * @returns {number}
   */
  getCreatorSubscriberCount(creatorId) {
    this.ensureCreator(creatorId);
    const row = this.db
      .prepare(`SELECT subscriber_count AS subscriberCount FROM creators WHERE id = ?`)
      .get(creatorId);

    return (row && Number(row.subscriberCount)) || 0;
  }

  /**
   * Increment the subscriber count for a creator by 1.
   * Returns the new count.
   *
   * @param {string} creatorId
   * @returns {number}
   */
  incrementCreatorSubscriberCount(creatorId) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      this.db
        .prepare(`UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?`)
        .run(creatorId);

      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Decrement the subscriber count for a creator by 1, clamped at 0.
   * Returns the new count.
   *
   * @param {string} creatorId
   * @returns {number}
   */
  decrementCreatorSubscriberCount(creatorId) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      this.db
        .prepare(
          `UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?`,
        )
        .run(creatorId);

      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Set the subscriber count explicitly.
   *
   * @param {string} creatorId
   * @param {number} count
   * @returns {number}
   */
  setCreatorSubscriberCount(creatorId, count) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const safe = Math.max(0, Math.floor(Number(count) || 0));
      this.db
        .prepare(`UPDATE creators SET subscriber_count = ? WHERE id = ?`)
        .run(safe, creatorId);

      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Get a subscription row for a creator and wallet.
   * @param {string} creatorId
   * @param {string} walletAddress
   * @returns {object|null}
   */
  getSubscription(creatorId, walletAddress) {
    const row = this.db
      .prepare(
        `SELECT creator_id AS creatorId, wallet_address AS walletAddress, active, subscribed_at AS subscribedAt, unsubscribed_at AS unsubscribedAt FROM subscriptions WHERE creator_id = ? AND wallet_address = ?`,
      )
      .get(creatorId, walletAddress);
   * Create a new comment.
   *
   * @param {{postId: string, userAddress: string, creatorId: string, content: string}} comment Comment data.
   * @returns {object}
   */
  createComment(comment) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO comments (id, post_id, user_address, creator_id, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(id, comment.postId, comment.userAddress, comment.creatorId, comment.content, now, now);

    return this.getCommentById(id);
  }

  /**
   * Get a comment by ID.
   *
   * @param {string} commentId Comment identifier.
   * @returns {object|null}
   */
  getCommentById(commentId) {
    const row = this.db
      .prepare(
        `
        SELECT id, post_id AS postId, user_address AS userAddress, creator_id AS creatorId, content, created_at AS createdAt, updated_at AS updatedAt
        FROM comments
        WHERE id = ?
      `,
      )
      .get(commentId);

    return row || null;
  }

  /**
   * Create or activate a subscription for a wallet. Returns { changed: boolean, count: number }
   * @param {string} creatorId
   * @param {string} walletAddress
   */
  createOrActivateSubscription(creatorId, walletAddress) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const existing = this.getSubscription(creatorId, walletAddress);
      const now = new Date().toISOString();

      if (existing && existing.active === 1) {
        // already active
        return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
      }

      if (existing) {
        // reactivate
        this.db
          .prepare(`UPDATE subscriptions SET active = 1, subscribed_at = ?, unsubscribed_at = NULL WHERE creator_id = ? AND wallet_address = ?`)
          .run(now, creatorId, walletAddress);
      } else {
        this.db
          .prepare(`INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at) VALUES (?, ?, 1, ?)`)
          .run(creatorId, walletAddress, now);
      }

      // Increment cached count
      this.db
        .prepare(`UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?`)
        .run(creatorId);

      const newCount = this.getCreatorSubscriberCount(creatorId);
      return { changed: true, count: newCount };
    });
  }

  /**
   * Deactivate a subscription if it is currently active. Returns { changed: boolean, count: number }
   * @param {string} creatorId
   * @param {string} walletAddress
   */
  deactivateSubscription(creatorId, walletAddress) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const existing = this.getSubscription(creatorId, walletAddress);
      const now = new Date().toISOString();

      if (!existing || existing.active !== 1) {
        return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
      }

      this.db
        .prepare(`UPDATE subscriptions SET active = 0, unsubscribed_at = ? WHERE creator_id = ? AND wallet_address = ?`)
        .run(now, creatorId, walletAddress);

      // Decrement cached count, clamp at 0
      this.db
        .prepare(`UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?`)
        .run(creatorId);

      const newCount = this.getCreatorSubscriberCount(creatorId);
      return { changed: true, count: newCount };
    });
  }

  /**
   * Count active subscriptions for a creator (derived from subscriptions table).
   * @param {string} creatorId
   * @returns {number}
   */
  countActiveSubscriptions(creatorId) {
    const row = this.db
      .prepare(`SELECT COUNT(1) AS ct FROM subscriptions WHERE creator_id = ? AND active = 1`)
      .get(creatorId);

    return (row && Number(row.ct)) || 0;
   * Get comments by post ID.
   *
   * @param {string} postId Post identifier.
   * @returns {object[]}
   */
  getCommentsByPostId(postId) {
    return this.db
      .prepare(
        `
        SELECT id, post_id AS postId, user_address AS userAddress, creator_id AS creatorId, content, created_at AS createdAt, updated_at AS updatedAt
        FROM comments
        WHERE post_id = ?
        ORDER BY created_at DESC
      `,
      )
      .all(postId);
  }

  /**
   * Update a comment.
   *
   * @param {{commentId: string, content: string}} input Update payload.
   * @returns {object}
   */
  updateComment(input) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE comments
        SET content = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(input.content, now, input.commentId);

    return this.getCommentById(input.commentId);
  }

  /**
   * Delete a comment.
   *
   * @param {string} commentId Comment identifier.
   * @returns {boolean}
   */
  deleteComment(commentId) {
    const result = this.db
      .prepare(
        `
        DELETE FROM comments WHERE id = ?
      `,
      )
      .run(commentId);

    return result.changes > 0;
  }
}

module.exports = {
  AppDatabase,
};
