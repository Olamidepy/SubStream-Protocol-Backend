# Backwards-Compatible Database Migrations

This document provides guidelines and patterns for writing backwards-compatible database migrations that allow old and new application versions to coexist during deployments.

## Overview

In a Kubernetes environment with rolling updates, old pods continue running while new pods are starting. Migrations must be backwards-compatible to ensure:
- Old pods can still read/write data with the old schema
- New pods can read/write data with the new schema
- No data loss or corruption occurs during the transition

## Core Principles

1. **Never break existing contracts**
2. **Add before removing**
3. **Use nullable columns for new fields**
4. **Default values for new required fields**
5. **Two-phase deployment for breaking changes**

---

## Migration Patterns

### Pattern 1: Adding a New Column

**❌ Wrong (Breaking):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.string('email').notNullable(); // Old pods will fail
  });
};
```

**✅ Correct (Backwards-Compatible):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.string('email').nullable(); // Old pods ignore it
  });
};

exports.down = function(knex) {
  return knex.schema.table('users', (table) => {
    table.dropColumn('email');
  });
};
```

**Deployment Steps:**
1. Deploy migration (adds nullable column)
2. Deploy new application code (uses new column)
3. Backfill data for existing rows
4. Deploy migration to make column non-nullable (optional)

### Pattern 2: Adding a New Table

**✅ Correct:**
```javascript
exports.up = function(knex) {
  return knex.schema.createTable('audit_logs', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned();
    table.string('action');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.foreign('user_id').references('users.id');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('audit_logs');
};
```

**Deployment Steps:**
1. Deploy migration (creates new table)
2. Deploy new application code (writes to new table)
3. Old pods ignore the new table (safe)

### Pattern 3: Renaming a Column

**❌ Wrong (Breaking):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.renameColumn('username', 'display_name'); // Old pods will fail
  });
};
```

**✅ Correct (Two-Phase):**

**Phase 1: Add new column**
```javascript
// Migration 001_add_display_name.js
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.string('display_name').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.table('users', (table) => {
    table.dropColumn('display_name');
  });
};
```

**Phase 2: Backfill data**
```javascript
// Migration 002_backfill_display_name.js
exports.up = async function(knex) {
  await knex('users')
    .whereNull('display_name')
    .update({
      display_name: knex.raw('username')
    });
};

exports.down = async function(knex) {
  // No-op
};
```

**Phase 3: Update application code**
- Deploy new version that reads from `display_name`
- Keep writing to both `username` and `display_name`

**Phase 4: Remove old column**
```javascript
// Migration 003_remove_username.js
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.dropColumn('username');
  });
};

exports.down = function(knex) {
  return knex.schema.table('users', (table) => {
    table.string('username').nullable();
  });
};
```

### Pattern 4: Changing Column Type

**❌ Wrong (Breaking):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.integer('age').alter(); // Old pods expect string
  });
};
```

**✅ Correct (Two-Phase):**

**Phase 1: Add new column**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.integer('age_new').nullable();
  });
};
```

**Phase 2: Backfill and convert**
```javascript
exports.up = async function(knex) {
  await knex('users')
    .whereNull('age_new')
    .update({
      age_new: knex.raw('CAST(age AS INTEGER)')
    });
};
```

**Phase 3: Update application code**
- Deploy new version that reads from `age_new`
- Keep writing to both columns

**Phase 4: Remove old column**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.dropColumn('age');
  });
  
  return knex.schema.table('users', (table) => {
    table.renameColumn('age_new', 'age');
  });
};
```

### Pattern 5: Adding a Foreign Key

**✅ Correct:**
```javascript
exports.up = function(knex) {
  return knex.schema.table('posts', (table) => {
    table.integer('author_id').unsigned().nullable();
    table
      .foreign('author_id')
      .references('users.id')
      .onDelete('SET NULL'); // Safe deletion
  });
};

exports.down = function(knex) {
  return knex.schema.table('posts', (table) => {
    table.dropForeign(['author_id']);
    table.dropColumn('author_id');
  });
};
```

**Deployment Steps:**
1. Deploy migration (adds nullable foreign key)
2. Deploy new application code (uses foreign key)
3. Backfill data
4. Make column non-nullable (optional)

### Pattern 6: Adding an Index

**✅ Correct (Non-Blocking):**
```javascript
exports.up = function(knex) {
  // For PostgreSQL, use CONCURRENTLY to avoid locking
  return knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email 
    ON users(email)
  `);
};

exports.down = function(knex) {
  return knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_users_email');
};
```

**For SQLite (no CONCURRENTLY):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.index('email');
  });
};
```

**Note:** SQLite index creation is fast and typically doesn't require special handling.

### Pattern 7: Changing Default Values

**✅ Correct:**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    // New rows get the new default
    table.timestamp('created_at').defaultTo(knex.fn.now()).alter();
  });
};
```

**Note:** This only affects new rows. Old rows are unaffected.

### Pattern 8: Adding a Constraint

**❌ Wrong (Breaking):**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.unique('email'); // Old data might violate this
  });
};
```

**✅ Correct (Two-Phase):**

**Phase 1: Clean up data**
```javascript
exports.up = async function(knex) {
  // Remove duplicates
  await knex.raw(`
    DELETE FROM users u1 
    WHERE id NOT IN (
      SELECT MIN(id) 
      FROM users u2 
      GROUP BY email
    )
  `);
};
```

**Phase 2: Add constraint**
```javascript
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.unique('email');
  });
};
```

---

## Data Migration Strategies

### Strategy 1: Backfill in Migration

```javascript
exports.up = async function(knex) {
  // Add column
  await knex.schema.table('users', (table) => {
    table.string('full_name').nullable();
  });
  
  // Backfill data
  await knex('users')
    .whereNull('full_name')
    .update({
      full_name: knex.raw('CONCAT(first_name, " ", last_name)')
    });
};
```

### Strategy 2: Backfill in Application Code

For large datasets, backfill in the application:

```javascript
// In the application
async function backfillUserNames() {
  const batchSize = 1000;
  let offset = 0;
  
  while (true) {
    const users = await knex('users')
      .whereNull('full_name')
      .limit(batchSize)
      .offset(offset);
    
    if (users.length === 0) break;
    
    for (const user of users) {
      await knex('users')
        .where('id', user.id)
        .update({
          full_name: `${user.first_name} ${user.last_name}`
        });
    }
    
    offset += batchSize;
  }
}
```

### Strategy 3: Backfill via Background Job

```javascript
// Create a job to backfill data
exports.up = async function(knex) {
  await knex.schema.table('users', (table) => {
    table.string('full_name').nullable();
  });
  
  // Queue background job
  await knex('background_jobs').insert({
    type: 'backfill_user_names',
    status: 'pending',
    created_at: new Date()
  });
};
```

---

## Deployment Checklist

Before deploying a migration, verify:

- [ ] Migration is idempotent (can run multiple times safely)
- [ ] Migration has a rollback script
- [ ] New columns are nullable or have default values
- [ ] No columns are dropped without a two-phase process
- [ ] No constraints are added without data cleanup
- [ ] Indexes use CONCURRENTLY (PostgreSQL) or are fast (SQLite)
- [ ] Foreign keys use ON DELETE SET NULL or similar safe policies
- [ ] Migration tested in staging environment
- [ ] Application code updated to handle both old and new schema
- [ ] Rollback procedure documented

---

## Example: Complete Migration Workflow

### Scenario: Add `status` column to `subscriptions` table

**Step 1: Migration 1 - Add nullable column**
```javascript
// migrations/knex/015_add_subscription_status.js
exports.up = function(knex) {
  return knex.schema.table('subscriptions', (table) => {
    table.string('status').defaultTo('active').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.table('subscriptions', (table) => {
    table.dropColumn('status');
  });
};
```

**Step 2: Deploy migration**
```bash
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --set migration.enabled=true
```

**Step 3: Update application code**
- Update application to read `status` column
- Update application to write `status` column
- Deploy new version

**Step 4: Verify**
- Check that both old and new pods work
- Verify data integrity
- Monitor for errors

**Step 5: (Optional) Make column non-nullable**
```javascript
// migrations/knex/016_make_status_required.js
exports.up = async function(knex) {
  // Ensure all rows have a value
  await knex('subscriptions')
    .whereNull('status')
    .update({ status: 'active' });
  
  // Make column required
  return knex.schema.table('subscriptions', (table) => {
    table.string('status').defaultTo('active').alter();
  });
};

exports.down = function(knex) {
  return knex.schema.table('subscriptions', (table) => {
    table.string('status').nullable().alter();
  });
};
```

---

## Testing Backwards Compatibility

### Unit Tests

```javascript
describe('Migration backwards compatibility', () => {
  it('should work with old schema', async () => {
    // Test that old application code works with new schema
    const oldApp = require('./old-app');
    await oldApp.createUser({ name: 'John' });
  });
  
  it('should work with new schema', async () => {
    // Test that new application code works with new schema
    const newApp = require('./new-app');
    await newApp.createUser({ name: 'John', email: 'john@example.com' });
  });
});
```

### Integration Tests

```javascript
describe('Deployment compatibility', () => {
  it('should handle mixed pod versions', async () => {
    // Simulate old and new pods running simultaneously
    const oldPod = await startOldPod();
    const newPod = await startNewPod();
    
    // Both should work
    await oldPod.writeData({ field: 'value' });
    await newPod.readData();
    
    await oldPod.stop();
    await newPod.stop();
  });
});
```

---

## Common Pitfalls

### Pitfall 1: Assuming Migration Completes Instantly

**Problem:** Application code deployed before migration completes.

**Solution:** Use initContainer or Helm hooks to ensure migration completes before application starts.

### Pitfall 2: Not Testing with Production Data

**Problem:** Migration works with test data but fails with production data scale.

**Solution:** Test migrations with production-like data volume in staging.

### Pitfall 3: Forgetting Rollback Scripts

**Problem:** Migration fails and cannot be rolled back.

**Solution:** Always write rollback scripts and test them.

### Pitfall 4: Changing Data Semantics

**Problem:** Migration changes the meaning of existing data.

**Solution:** Add new columns instead of modifying existing ones.

### Pitfall 5: Long-Running Migrations

**Problem:** Migration takes too long and times out.

**Solution:** Use batch processing, increase timeout, or use online schema change tools.

---

## References

- [Knex.js Migration Documentation](https://knexjs.org/#Migrations)
- [PostgreSQL ALTER TABLE Documentation](https://www.postgresql.org/docs/current/sql-altertable.html)
- [Migration Failure Runbook](./MIGRATION_FAILURE_RUNBOOK.md)
- [Vault Migration Setup](./VAULT_MIGRATION_SETUP.md)
