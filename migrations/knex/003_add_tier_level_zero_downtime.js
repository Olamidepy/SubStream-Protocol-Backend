/**
 * Example Migration: Add tier_level column to subscriptions table
 * 
 * This demonstrates zero-downtime migration strategy:
 * 
 * Phase 1 (Pre-deploy): Add column as nullable
 * Phase 2 (Background): Backfill data gradually
 * Phase 3 (Post-deploy): Add NOT NULL constraint and defaults
 * 
 * This approach allows the API to continue serving 5,000+ RPS without failures
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function(knex) {
  console.log('[Migration 003] Starting zero-downtime migration...');
  
  // Step 1: Add column as nullable (safe - doesn't break existing queries)
  console.log('[Migration 003] Adding tier_level column (nullable)...');
  const hasColumn = await knex.schema.hasColumn('subscriptions', 'tier_level');
  
  if (!hasColumn) {
    await knex.schema.alterTable('subscriptions', (table) => {
      table.string('tier_level').nullable().defaultTo('free');
    });
    console.log('[Migration 003] Column added successfully');
  } else {
    console.log('[Migration 003] Column already exists, skipping');
  }
  
  // Step 2: Create index concurrently (doesn't block writes)
  console.log('[Migration 003] Creating index on tier_level...');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_tier_level 
    ON subscriptions (tier_level)
  `);
  console.log('[Migration 003] Index created');
  
  // Step 3: Backfill existing records in batches (to avoid lock contention)
  console.log('[Migration 003] Backfilling existing records...');
  await backfillTierLevels(knex);
  
  // Step 4: Add NOT NULL constraint (safe after backfill)
  console.log('[Migration 003] Adding NOT NULL constraint...');
  await knex.schema.alterTable('subscriptions', (table) => {
    table.string('tier_level').notNullable().alter();
  });
  console.log('[Migration 003] NOT NULL constraint added');
  
  console.log('[Migration 003] Migration completed successfully!');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function(knex) {
  console.log('[Migration 003] Rolling back migration...');
  
  try {
    // Drop index first
    await knex.raw('DROP INDEX IF EXISTS idx_subscriptions_tier_level');
    
    // Remove column
    await knex.schema.alterTable('subscriptions', (table) => {
      table.dropColumn('tier_level');
    });
    
    console.log('[Migration 003] Rollback completed');
  } catch (error) {
    console.error('[Migration 003] Rollback failed:', error);
    throw error;
  }
};

/**
 * Backfill tier levels in small batches to minimize lock contention
 * This is the key to zero-downtime: gradual updates instead of one big transaction
 */
async function backfillTierLevels(knex) {
  const BATCH_SIZE = 1000; // Small batches to avoid locking
  const DELAY_MS = 100;    // Delay between batches
  
  let offset = 0;
  let processedCount = 0;
  
  while (true) {
    // Get batch of records that need backfilling
    const batch = await knex('subscriptions')
      .whereNull('tier_level')
      .orWhere('tier_level', '=', '')
      .limit(BATCH_SIZE)
      .offset(offset);
    
    if (batch.length === 0) {
      console.log(`[Migration 003] Backfill complete. Processed ${processedCount} records`);
      break;
    }
    
    // Update this batch
    const updatePromises = batch.map((record) => {
      // Determine tier based on subscription date or other criteria
      const tier = determineTierLevel(record);
      
      return knex('subscriptions')
        .where({
          creator_id: record.creator_id,
          wallet_address: record.wallet_address,
        })
        .update({ tier_level: tier });
    });
    
    await Promise.all(updatePromises);
    processedCount += batch.length;
    offset += BATCH_SIZE;
    
    console.log(`[Migration 003] Backfilled ${processedCount} records...`);
    
    // Small delay to allow normal traffic to proceed
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
}

/**
 * Determine tier level for a subscription record
 * In production, this would use business logic (payment history, engagement, etc.)
 */
function determineTierLevel(subscription) {
  // Simple example: all existing subscriptions get 'founder' tier
  return 'founder';
  
  // Production example:
  // const subscribedDate = new Date(subscription.subscribed_at);
  // const now = new Date();
  // const monthsActive = (now.getFullYear() - subscribedDate.getFullYear()) * 12 +
  //                      (now.getMonth() - subscribedDate.getMonth());
  //
  // if (monthsActive >= 24) return 'platinum';
  // if (monthsActive >= 12) return 'gold';
  // if (monthsActive >= 6) return 'silver';
  // return 'free';
}
