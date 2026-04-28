/**
 * Add SEP-24 Anchor Transaction tables
 */

exports.up = async function(knex) {
  // Anchor Transactions table for SEP-24 compliance
  await knex.schema.createTable('anchor_transactions', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('stellar_public_key', 56).notNullable().index();
    table.string('transaction_id', 64).unique().notNullable(); // Stellar transaction ID
    table.string('anchor_transaction_id', 64).unique(); // Anchor's internal transaction ID
    table.enum('transaction_type', ['deposit', 'withdrawal']).notNullable();
    table.string('asset_code', 12).notNullable(); // e.g., 'USD', 'EUR', 'BTC'
    table.string('asset_issuer', 56); // For custom assets
    table.decimal('amount', 20, 8).notNullable();
    table.string('amount_in_asset', 64); // Amount in asset format (e.g., "5.00 USD")
    
    // Transaction status following SEP-24 spec
    table.enum('status', [
      'pending_user_transfer_start',
      'pending_anchor', 
      'pending_user_transfer_complete',
      'incomplete',
      'completed',
      'error'
    ]).notNullable().defaultTo('pending_user_transfer_start');
    
    table.text('status_message'); // Human-readable status message
    table.json('transaction_details'); // Additional transaction metadata
    
    // Interactive flow fields
    table.string('session_token', 255).unique(); // JWT for interactive session
    table.timestamp('session_expires_at');
    table.string('interactive_url', 2048); // URL for interactive flow
    table.text('customer_memo'); // Memo for bank transfer
    
    // Bank transfer details
    table.string('bank_account_type', 50); // IBAN, SWIFT, etc.
    table.string('bank_account_number', 255);
    table.string('bank_routing_number', 255);
    table.string('bank_name', 255);
    table.string('bank_country', 2); // ISO 3166-1 alpha-2
    
    // Timestamps
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('completed_at');
    
    // Foreign keys and indexes
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
    table.index(['tenant_id', 'status']);
    table.index(['stellar_public_key', 'status']);
    table.index(['transaction_type', 'status']);
    table.index(['created_at']);
  });

  // SEP-24 Interactive Sessions table
  await knex.schema.createTable('sep24_interactive_sessions', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('anchor_transaction_id').notNullable();
    table.string('session_token', 255).unique().notNullable();
    table.string('origin_domain', 255).notNullable(); // Domain that initiated the flow
    table.string('callback_url', 2048); // URL to call after completion
    table.json('session_data'); // Session state and metadata
    table.enum('status', ['active', 'completed', 'expired', 'error']).defaultTo('active');
    
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
    table.timestamp('completed_at');
    
    table.foreign('anchor_transaction_id').references('id').in_table('anchor_transactions').onDelete('CASCADE');
    table.index(['session_token']);
    table.index(['status']);
    table.index(['expires_at']);
  });

  // Webhook configurations for anchors
  await knex.schema.createTable('anchor_webhook_configs', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('anchor_name', 255).notNullable();
    table.string('webhook_url', 2048).notNullable();
    table.string('webhook_secret', 255); // HMAC secret for webhook validation
    table.json('supported_assets'); // Array of supported asset codes
    table.boolean('active').defaultTo(true);
    
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
    table.index(['tenant_id', 'anchor_name']);
    table.index(['active']);
  });

  // Create indexes for performance
  await knex.raw('CREATE INDEX idx_anchor_transactions_tenant_status ON anchor_transactions(tenant_id, status)');
  await knex.raw('CREATE INDEX idx_anchor_transactions_stellar_status ON anchor_transactions(stellar_public_key, status)');
  await knex.raw('CREATE INDEX idx_anchor_transactions_type_status ON anchor_transactions(transaction_type, status)');
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('anchor_webhook_configs');
  await knex.schema.dropTableIfExists('sep24_interactive_sessions');
  await knex.schema.dropTableIfExists('anchor_transactions');
};
