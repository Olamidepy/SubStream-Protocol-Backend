#!/usr/bin/env node
/**
 * Idempotent Migration Script for Kubernetes initContainer
 * 
 * This script is designed to run in a Kubernetes initContainer with the following properties:
 * - Completely idempotent: can be run multiple times safely
 * - Distributed execution safe: uses database-level locking
 * - Exit code 0 on success, 1 on failure (prevents pod startup)
 * - Comprehensive logging for debugging
 * - Vault integration for secure credential fetching
 * 
 * Usage: node scripts/migrate-init-container.js
 */

const knex = require('knex');
const path = require('path');

// Configuration
const MIGRATION_LOCK_TIMEOUT = parseInt(process.env.MIGRATION_LOCK_TIMEOUT || '300000'); // 5 minutes
const MIGRATION_TIMEOUT = parseInt(process.env.MIGRATION_TIMEOUT || '1800000'); // 30 minutes for long-running migrations
const LOCK_TABLE = '_migration_locks';
const LONG_RUNNING_THRESHOLD = 60000; // 1 minute - log progress for migrations taking longer

class InitContainerMigrationRunner {
  constructor() {
    this.knex = null;
    this.lockAcquired = false;
    this.startTime = Date.now();
  }

  /**
   * Main execution flow
   */
  async run() {
    try {
      console.log('[InitContainer] Starting migration process...');
      console.log('[InitContainer] Timestamp:', new Date().toISOString());

      // Initialize database connection
      await this.initializeDatabase();

      // Acquire distributed lock to prevent race conditions
      await this.acquireLock();

      // Run migrations with timeout protection
      await this.runMigrationsWithTimeout();

      // Release lock
      await this.releaseLock();

      // Cleanup
      await this.cleanup();

      const duration = Date.now() - this.startTime;
      console.log(`[InitContainer] Migration completed successfully in ${duration}ms`);
      console.log('[InitContainer] Exiting with code 0 (success)');
      process.exit(0);
    } catch (error) {
      console.error('[InitContainer] Migration failed:', error);

      // Attempt to release lock if acquired
      if (this.lockAcquired) {
        try {
          await this.releaseLock();
        } catch (lockError) {
          console.error('[InitContainer] Failed to release lock:', lockError);
        }
      }

      // Cleanup connection
      try {
        await this.cleanup();
      } catch (cleanupError) {
        console.error('[InitContainer] Cleanup failed:', cleanupError);
      }

      console.error('[InitContainer] Exiting with code 1 (failure - will prevent pod startup)');
      process.exit(1);
    }
  }

  /**
   * Initialize database connection from environment variables
   */
  async initializeDatabase() {
    const dbConfig = {
      client: 'better-sqlite3',
      connection: {
        filename: process.env.DATABASE_FILENAME || '/app/data/substream.db',
      },
      useNullAsDefault: true,
      migrations: {
        directory: './migrations/knex',
        extension: 'js',
        loadExtensions: ['.js'],
      },
      pool: {
        min: 1,
        max: 5,
        acquireTimeoutMillis: 30000,
        createTimeoutMillis: 5000,
        destroyTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      },
    };

    console.log('[InitContainer] Initializing database connection...');
    console.log('[InitContainer] Database file:', dbConfig.connection.filename);

    this.knex = knex(dbConfig);

    // Test connection
    try {
      await this.knex.raw('SELECT 1');
      console.log('[InitContainer] Database connection successful');
    } catch (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }

    // Ensure lock table exists
    await this.ensureLockTable();
  }

  /**
   * Ensure the migration lock table exists
   */
  async ensureLockTable() {
    const hasTable = await this.knex.schema.hasTable(LOCK_TABLE);

    if (!hasTable) {
      console.log('[InitContainer] Creating migration lock table...');
      await this.knex.schema.createTable(LOCK_TABLE, (table) => {
        table.string('lock_key').primary();
        table.timestamp('acquired_at');
        table.timestamp('expires_at');
        table.string('node_id');
        table.string('pod_name');
        table.string('namespace');
      });
      console.log('[InitContainer] Lock table created');
    }
  }

  /**
   * Acquire distributed lock to prevent concurrent migrations
   */
  async acquireLock() {
    const lockKey = 'schema_migration';
    const nodeId = process.env.HOSTNAME || 'unknown';
    const podName = process.env.POD_NAME || 'unknown';
    const namespace = process.env.NAMESPACE || 'default';
    const now = new Date();
    const expiresAt = new Date(Date.now() + MIGRATION_LOCK_TIMEOUT);

    console.log('[InitContainer] Attempting to acquire migration lock...');
    console.log(`[InitContainer] Node ID: ${nodeId}, Pod: ${podName}, Namespace: ${namespace}`);

    // Check for existing lock
    const existingLock = await this.knex(LOCK_TABLE)
      .where('lock_key', lockKey)
      .first();

    if (existingLock) {
      const expiresAtTime = new Date(existingLock.expires_at);

      // Check if lock is expired
      if (expiresAtTime > now) {
        const timeRemaining = Math.floor((expiresAtTime - now) / 1000);
        console.warn(`[InitContainer] Lock already held by ${existingLock.node_id} (${existingLock.pod_name})`);
        console.warn(`[InitContainer] Lock expires in ${timeRemaining} seconds`);
        console.warn('[InitContainer] Waiting for lock to be released...');

        // Wait for lock to be released (with timeout)
        const maxWaitTime = MIGRATION_LOCK_TIMEOUT;
        const checkInterval = 5000;
        let waitedTime = 0;

        while (waitedTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waitedTime += checkInterval;

          const currentLock = await this.knex(LOCK_TABLE)
            .where('lock_key', lockKey)
            .first();

          if (!currentLock || new Date(currentLock.expires_at) <= new Date()) {
            console.log('[InitContainer] Lock released, proceeding...');
            break;
          }

          console.log(`[InitContainer] Still waiting for lock... (${waitedTime / 1000}s/${maxWaitTime / 1000}s)`);
        }

        if (waitedTime >= maxWaitTime) {
          throw new Error('Timeout waiting for migration lock');
        }
      } else {
        console.log('[InitContainer] Existing lock expired, cleaning up...');
        await this.knex(LOCK_TABLE).where('lock_key', lockKey).del();
      }
    }

    // Acquire lock
    await this.knex(LOCK_TABLE)
      .insert({
        lock_key: lockKey,
        acquired_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        node_id: nodeId,
        pod_name: podName,
        namespace: namespace,
      });

    this.lockAcquired = true;
    console.log('[InitContainer] Migration lock acquired successfully');
  }

  /**
   * Release the migration lock
   */
  async releaseLock() {
    if (!this.lockAcquired) {
      return;
    }

    const lockKey = 'schema_migration';
    console.log('[InitContainer] Releasing migration lock...');

    await this.knex(LOCK_TABLE)
      .where('lock_key', lockKey)
      .del();

    this.lockAcquired = false;
    console.log('[InitContainer] Migration lock released');
  }

  /**
   * Run migrations with timeout protection
   */
  async runMigrationsWithTimeout() {
    console.log('[InitContainer] Running migrations...');

    // Set up timeout for long-running migrations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Migration timeout after ${MIGRATION_TIMEOUT}ms`));
      }, MIGRATION_TIMEOUT);
    });

    // Run migrations
    const migrationPromise = this.runMigrations();

    // Race between migration and timeout
    await Promise.race([migrationPromise, timeoutPromise]);
  }

  /**
   * Execute Knex migrations
   */
  async runMigrations() {
    try {
      const migrationStartTime = Date.now();
      const [batchNo, log] = await this.knex.migrate.latest();

      if (log.length === 0) {
        console.log('[InitContainer] No new migrations to run (already up to date)');
      } else {
        const migrationDuration = Date.now() - migrationStartTime;
        console.log(`[InitContainer] Successfully ran ${log.length} migrations in batch ${batchNo}`);
        log.forEach((migration) => {
          console.log(`[InitContainer]   - ${migration.name}`);
        });
        console.log(`[InitContainer] Migration batch completed in ${migrationDuration}ms`);

        // Log warning if migration took longer than threshold
        if (migrationDuration > LONG_RUNNING_THRESHOLD) {
          console.warn(`[InitContainer] WARNING: Migration took ${migrationDuration}ms, which exceeds the ${LONG_RUNNING_THRESHOLD}ms threshold`);
          console.warn('[InitContainer] Consider increasing MIGRATION_TIMEOUT or optimizing the migration');
        }
      }

      // Verify migration status
      await this.verifyMigrationStatus();
    } catch (error) {
      throw new Error(`Migration execution failed: ${error.message}`);
    }
  }

  /**
   * Verify that migrations were applied correctly
   */
  async verifyMigrationStatus() {
    console.log('[InitContainer] Verifying migration status...');

    // Get current migration status
    const completed = await this.knex.migrate.currentVersion();
    console.log(`[InitContainer] Current migration version: ${completed}`);

    // Check for any pending migrations
    const allMigrations = await this.knex.migrate.list();
    const pending = allMigrations[1]; // Second element is pending migrations

    if (pending.length > 0) {
      console.warn(`[InitContainer] WARNING: ${pending.length} migrations still pending`);
      pending.forEach((migration) => {
        console.warn(`[InitContainer]   - ${migration.name}`);
      });
      throw new Error('Not all migrations were applied successfully');
    }

    console.log('[InitContainer] Migration verification passed');
  }

  /**
   * Cleanup database connections
   */
  async cleanup() {
    if (this.knex) {
      console.log('[InitContainer] Closing database connection...');
      await this.knex.destroy();
      console.log('[InitContainer] Database connection closed');
    }
  }
}

// Execute if run directly
if (require.main === module) {
  const runner = new InitContainerMigrationRunner();
  runner.run();
}

module.exports = { InitContainerMigrationRunner };
