# Long-Running Migration Strategies

This document provides strategies for handling long-running database migrations that may exceed default deployment timeouts.

## Overview

Some database operations can take significant time, especially on large datasets:
- Adding indexes to tables with millions of rows
- Backfilling data for new columns
- Converting column types
- Large data transformations

These operations can trigger deployment timeouts if not properly managed.

## Configuration

### Default Timeouts

The migration system has configurable timeouts:

```yaml
migration:
  timeout: 1800 # 30 minutes in seconds
  lockTimeout: 300 # 5 minutes in seconds
```

### Increasing Timeouts

For known long-running migrations, increase the timeout:

```yaml
migration:
  timeout: 7200 # 2 hours
  lockTimeout: 600 # 10 minutes
```

**Apply via Helm:**
```bash
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --set migration.timeout=7200 \
  --set migration.lockTimeout=600
```

---

## Strategy 1: Batch Processing

Break large operations into smaller batches to avoid long transactions and reduce lock contention.

### Example: Backfilling Data

**❌ Wrong (Single Transaction):**
```javascript
exports.up = async function(knex) {
  // This could take hours on a large table
  await knex('users')
    .whereNull('email_verified')
    .update({ email_verified: true });
};
```

**✅ Correct (Batch Processing):**
```javascript
exports.up = async function(knex) {
  const batchSize = 10000;
  let processed = 0;
  let hasMore = true;

  console.log('Starting batch backfill...');

  while (hasMore) {
    const updated = await knex('users')
      .whereNull('email_verified')
      .limit(batchSize)
      .update({ email_verified: true });

    processed += updated;
    hasMore = updated > 0;

    console.log(`Processed ${processed} records...`);

    // Small delay to reduce database load
    if (hasMore) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`Backfill complete: ${processed} records updated`);
};
```

### Example: Index Creation with Batch Data

```javascript
exports.up = async function(knex) {
  // Add column first
  await knex.schema.table('orders', (table) => {
    table.integer('customer_id').nullable();
  });

  // Backfill in batches
  const batchSize = 5000;
  let offset = 0;
  let total = 0;

  while (true) {
    const orders = await knex('orders')
      .whereNull('customer_id')
      .limit(batchSize)
      .offset(offset);

    if (orders.length === 0) break;

    for (const order of orders) {
      // Derive customer_id from existing data
      const customerId = await deriveCustomerId(order);
      await knex('orders')
        .where('id', order.id)
        .update({ customer_id: customerId });
    }

    total += orders.length;
    offset += batchSize;
    console.log(`Backfilled ${total} orders`);
  }

  // Create index after backfill
  await knex.schema.table('orders', (table) => {
    table.index('customer_id');
  });
};
```

---

## Strategy 2: Online Schema Changes

For PostgreSQL, use online schema change tools to avoid locking tables.

### PostgreSQL CONCURRENTLY

```javascript
exports.up = function(knex) {
  // Create index without locking the table
  return knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email 
    ON users(email)
  `);
};

exports.down = function(knex) {
  return knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_users_email');
};
```

**Important Notes:**
- CONCURRENTLY cannot be used in a transaction
- Index creation is still atomic
- If the operation fails, the index may be invalid
- Check for invalid indexes after migration

### Check for Invalid Indexes

```javascript
// After migration
await knex.raw(`
  SELECT indexname, indexdef 
  FROM pg_indexes 
  WHERE indisvalid = false
`);
```

---

## Strategy 3: Two-Phase Migration

Deploy migrations in multiple phases to spread the work across deployments.

### Phase 1: Prepare Schema

```javascript
// Migration 001_add_column.js
exports.up = function(knex) {
  return knex.schema.table('subscriptions', (table) => {
    table.string('status').defaultTo('active').nullable();
  });
};
```

### Phase 2: Backfill Data (Optional)

```javascript
// Migration 002_backfill_status.js
exports.up = async function(knex) {
  const batchSize = 10000;
  let processed = 0;

  while (true) {
    const updated = await knex('subscriptions')
      .whereNull('status')
      .limit(batchSize)
      .update({ status: 'active' });

    if (updated === 0) break;

    processed += updated;
    console.log(`Backfilled ${processed} subscriptions`);
  }
};
```

### Phase 3: Update Application

Deploy new application code that uses the new column.

### Phase 4: Finalize Schema (Optional)

```javascript
// Migration 003_finalize_column.js
exports.up = async function(knex) {
  // Ensure all rows have a value
  await knex('subscriptions')
    .whereNull('status')
    .update({ status: 'active' });

  // Make column non-nullable
  return knex.schema.table('subscriptions', (table) => {
    table.string('status').defaultTo('active').alter();
  });
};
```

---

## Strategy 4: Background Job Migration

For very large operations, use a background job instead of blocking deployment.

### Create Migration Job

```javascript
// Migration 001_queue_backfill.js
exports.up = async function(knex) {
  // Add column
  await knex.schema.table('users', (table) => {
    table.string('full_name').nullable();
  });

  // Queue background job
  await knex('background_jobs').insert({
    type: 'backfill_user_names',
    status: 'pending',
    priority: 1,
    created_at: new Date(),
    metadata: JSON.stringify({
      batch_size: 10000,
      estimated_total: 1000000
    })
  });

  console.log('Backfill job queued');
};
```

### Process Background Job

Create a worker to process the job:

```javascript
// workers/backfillWorker.js
async function processBackfillJob(job) {
  const { batch_size, estimated_total } = job.metadata;
  let processed = 0;

  while (true) {
    const users = await knex('users')
      .whereNull('full_name')
      .limit(batch_size);

    if (users.length === 0) break;

    for (const user of users) {
      await knex('users')
        .where('id', user.id)
        .update({
          full_name: `${user.first_name} ${user.last_name}`
        });
    }

    processed += users.length;
    console.log(`Backfill progress: ${processed}/${estimated_total}`);

    // Update job progress
    await knex('background_jobs')
      .where('id', job.id)
      .update({
        status: 'in_progress',
        progress: processed / estimated_total
      });
  }

  // Mark job complete
  await knex('background_jobs')
    .where('id', job.id)
    .update({ status: 'completed' });
}
```

---

## Strategy 5: Copy and Swap

For major schema changes, create a new table and swap it in.

### Step 1: Create New Table

```javascript
// Migration 001_create_new_table.js
exports.up = async function(knex) {
  await knex.schema.createTable('users_v2', (table) => {
    table.increments('id').primary();
    table.string('email').unique();
    table.string('full_name');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};
```

### Step 2: Copy Data in Batches

```javascript
// Migration 002_copy_data.js
exports.up = async function(knex) {
  const batchSize = 10000;
  let offset = 0;
  let total = 0;

  while (true) {
    const users = await knex('users')
      .limit(batchSize)
      .offset(offset);

    if (users.length === 0) break;

    await knex('users_v2').insert(
      users.map(u => ({
        email: u.email,
        full_name: `${u.first_name} ${u.last_name}`,
        created_at: u.created_at,
        updated_at: u.updated_at
      }))
    );

    total += users.length;
    offset += batchSize;
    console.log(`Copied ${total} users`);
  }
};
```

### Step 3: Update Application

Deploy new application code that reads from `users_v2`.

### Step 4: Swap Tables

```javascript
// Migration 003_swap_tables.js
exports.up = async function(knex) {
  // Rename old table
  await knex.schema.renameTable('users', 'users_old');

  // Rename new table
  await knex.schema.renameTable('users_v2', 'users');
};

exports.down = async function(knex) {
  // Rollback swap
  await knex.schema.renameTable('users', 'users_v2');
  await knex.schema.renameTable('users_old', 'users');
};
```

### Step 5: Clean Up (Later)

```javascript
// Migration 004_cleanup.js
exports.up = async function(knex) {
  // Drop old table after verification
  await knex.schema.dropTableIfExists('users_old');
};
```

---

## Monitoring Long-Running Migrations

### Progress Logging

Add progress logging to migrations:

```javascript
exports.up = async function(knex) {
  const total = await knex('large_table').count('* as count').first();
  const batchSize = 10000;
  let processed = 0;

  console.log(`Total records to process: ${total.count}`);

  while (true) {
    const updated = await knex('large_table')
      .whereNull('new_column')
      .limit(batchSize)
      .update({ new_column: 'default_value' });

    if (updated === 0) break;

    processed += updated;
    const progress = ((processed / total.count) * 100).toFixed(2);
    console.log(`Progress: ${progress}% (${processed}/${total.count})`);
  }
};
```

### Kubernetes Monitoring

Monitor the migration job:

```bash
# Watch job progress
kubectl logs -f job/substream-backend-migration -n substream

# Check job status
kubectl describe job/substream-backend-migration -n substream

# Check pod resource usage
kubectl top pod -l job-name=substream-backend-migration -n substream
```

### Alerts

Set up alerts for:
- Migration job running longer than expected
- Migration job failure
- High database CPU during migration
- Lock acquisition timeouts

---

## Testing Long-Running Migrations

### Load Testing

Test migrations with production-like data volumes:

```bash
# Create test database with production data volume
pg_dump production_db | psql test_db

# Run migration
node scripts/migrate-init-container.js

# Monitor performance
```

### Performance Profiling

Profile migration performance:

```javascript
exports.up = async function(knex) {
  const startTime = Date.now();

  // Migration logic

  const duration = Date.now() - startTime;
  console.log(`Migration duration: ${duration}ms`);

  // Log to monitoring system
  await logMetric('migration_duration', duration);
};
```

---

## Best Practices

1. **Estimate Duration**: Test migrations with production-like data to estimate duration
2. **Add Buffers**: Set timeout 2-3x the estimated duration
3. **Monitor Progress**: Log progress for long operations
4. **Use Batches**: Break large operations into smaller batches
5. **Avoid Peak Hours**: Schedule long migrations during low-traffic periods
6. **Have Rollback Plan**: Always have a rollback strategy
7. **Communicate**: Notify stakeholders about expected downtime or performance impact
8. **Test Thoroughly**: Test in staging with production data volumes

---

## Troubleshooting

### Migration Times Out

**Symptoms:**
- Job fails with "deadline exceeded"
- InitContainer exits with timeout error

**Solutions:**
1. Increase `migration.timeout` in values.yaml
2. Optimize the migration (use batches, indexes, etc.)
3. Split migration into multiple phases
4. Use background job strategy

### Migration Causes High Database Load

**Symptoms:**
- Database CPU spikes to 100%
- Other queries slow down
- Application performance degrades

**Solutions:**
1. Reduce batch size
2. Add delays between batches
3. Use online schema changes (CONCURRENTLY)
4. Schedule during maintenance window
5. Increase database resources temporarily

### Migration Gets Stuck

**Symptoms:**
- Migration runs indefinitely
- No progress in logs
- Lock held for too long

**Solutions:**
1. Check for database locks
2. Kill stuck queries
3. Release migration lock manually
4. Restart migration job

---

## Example: Complete Long-Running Migration

### Scenario: Add index to 100M row table

**Step 1: Estimate Duration**
```bash
# Test on sample data
CREATE INDEX CONCURRENTLY idx_test ON test_table(column);
# Monitor time: ~30 minutes for 10M rows
# Estimate: 5 hours for 100M rows
```

**Step 2: Configure Timeout**
```yaml
migration:
  timeout: 21600 # 6 hours
  lockTimeout: 600 # 10 minutes
```

**Step 3: Write Migration**
```javascript
// migrations/knex/015_add_large_index.js
exports.up = async function(knex) {
  console.log('Starting index creation...');
  const startTime = Date.now();

  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_large_table_column 
    ON large_table(column)
  `);

  const duration = Date.now() - startTime;
  console.log(`Index created in ${duration}ms`);
};

exports.down = async function(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_large_table_column');
};
```

**Step 4: Deploy**
```bash
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --set migration.timeout=21600 \
  --set migration.lockTimeout=600
```

**Step 5: Monitor**
```bash
kubectl logs -f job/substream-backend-migration -n substream
```

**Step 6: Verify**
```bash
# Check index exists
kubectl exec -it <pod-name> -n substream -- node -e "
const knex = require('knex');
const db = knex({ client: 'better-sqlite3', connection: { filename: '/app/data/substream.db' } });
db.raw('PRAGMA index_list(large_table)').then(console.log).finally(() => db.destroy());
"
```

---

## References

- [PostgreSQL Index Creation](https://www.postgresql.org/docs/current/sql-createindex.html)
- [Backwards-Compatible Migrations](./BACKWARDS_COMPATIBLE_MIGRATIONS.md)
- [Migration Failure Runbook](./MIGRATION_FAILURE_RUNBOOK.md)
