/**
 * Add Global Reputation System for Cross-Tenant Blacklist Sync
 */

exports.up = async function(knex) {
  // Global Reputation Scores table
  await knex.schema.createTable('global_reputation_scores', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('wallet_address', 56).notNullable().unique().index();
    table.string('hashed_identifier', 64).unique().index(); // Hashed PII for privacy
    table.decimal('reputation_score', 5, 2).notNullable().defaultTo(100.00); // 0-100 scale
    table.enum('risk_level', ['low', 'medium', 'high', 'critical']).notNullable().defaultTo('low');
    table.integer('total_flags').notNullable().defaultTo(0);
    table.integer('malicious_dispute_flags').notNullable().defaultTo(0);
    table.integer('allowance_exploitation_flags').notNullable().defaultTo(0);
    table.integer('fraud_flags').notNullable().defaultTo(0);
    table.integer('spam_flags').notNullable().defaultTo(0);
    table.json('flag_details'); // Array of flag details with timestamps and reasons
    table.timestamp('last_flagged_at');
    table.timestamp('last_reviewed_at');
    table.uuid('last_reviewed_by_tenant'); // Tenant that last reviewed
    table.text('review_notes');
    table.boolean('auto_rejection_enabled').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Indexes for performance
    table.index(['reputation_score']);
    table.index(['risk_level']);
    table.index(['total_flags']);
    table.index(['last_flagged_at']);
  });

  // Reputation Events table for audit trail
  await knex.schema.createTable('reputation_events', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('global_reputation_id').notNullable();
    table.uuid('tenant_id').notNullable();
    table.string('wallet_address', 56).notNullable();
    table.enum('event_type', [
      'malicious_dispute',
      'allowance_exploitation', 
      'fraud_detection',
      'spam_activity',
      'manual_flag',
      'manual_unflag',
      'score_adjustment',
      'review_completed'
    ]).notNullable();
    table.decimal('score_impact', 5, 2).notNullable(); // Negative for penalties, positive for improvements
    table.decimal('previous_score', 5, 2);
    table.decimal('new_score', 5, 2);
    table.text('reason'); // Human-readable reason
    table.json('event_metadata'); // Additional context
    table.string('flagged_by_tenant_name', 255);
    table.uuid('flagged_by_user_id'); // User who flagged (within tenant)
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Foreign keys
    table.foreign('global_reputation_id').references('id').inTable('global_reputation_scores').onDelete('CASCADE');
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
    
    // Indexes
    table.index(['global_reputation_id', 'created_at']);
    table.index(['tenant_id', 'event_type']);
    table.index(['wallet_address', 'event_type']);
    table.index(['created_at']);
  });

  // Tenant Reputation Settings table
  await knex.schema.createTable('tenant_reputation_settings', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().unique();
    table.boolean('global_reputation_enabled').defaultTo(true);
    table.decimal('warning_threshold', 5, 2).defaultTo(70.00); // Below this = warning
    table.decimal('blocking_threshold', 5, 2).defaultTo(30.00); // Below this = auto-reject if enabled
    table.boolean('auto_rejection_enabled').defaultTo(false);
    table.json('custom_flag_weights'); // Custom weights for different flag types
    table.boolean('share_flags_with_global').defaultTo(true);
    table.boolean('receive_global_flags').defaultTo(true);
    table.integer('flags_required_for_review').defaultTo(3); // Min flags before review
    table.text('rejection_message_template');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Foreign key
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  // Reputation Review Queue table
  await knex.schema.createTable('reputation_review_queue', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('global_reputation_id').notNullable();
    table.uuid('assigned_to_tenant_id'); // Tenant assigned for review
    table.enum('priority', ['low', 'medium', 'high', 'urgent']).defaultTo('medium');
    table.enum('status', ['pending', 'in_review', 'resolved', 'escalated']).defaultTo('pending');
    table.text('review_reason');
    table.json('review_context'); // Why this needs review
    table.timestamp('assigned_at');
    table.timestamp('review_started_at');
    table.timestamp('review_completed_at');
    table.uuid('reviewed_by_user_id');
    table.text('review_decision'); // Approved, rejected, needs investigation
    table.text('review_notes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Foreign key
    table.foreign('global_reputation_id').references('id').inTable('global_reputation_scores').onDelete('CASCADE');
    
    // Indexes
    table.index(['status', 'priority']);
    table.index(['assigned_to_tenant_id', 'status']);
    table.index(['created_at']);
  });

  // Create indexes for performance
  await knex.raw('CREATE INDEX idx_global_reputation_score_desc ON global_reputation_scores(reputation_score DESC)');
  await knex.raw('CREATE INDEX idx_global_reputation_risk_level ON global_reputation_scores(risk_level)');
  await knex.raw('CREATE INDEX idx_reputation_events_tenant_type ON reputation_events(tenant_id, event_type)');
  await knex.raw('CREATE INDEX idx_reputation_events_wallet_created ON reputation_events(wallet_address, created_at)');
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('reputation_review_queue');
  await knex.schema.dropTableIfExists('tenant_reputation_settings');
  await knex.schema.dropTableIfExists('reputation_events');
  await knex.schema.dropTableIfExists('global_reputation_scores');
};
