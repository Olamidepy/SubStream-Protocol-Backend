/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('price_cache', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('base_asset').notNullable(); // e.g., 'XLM', 'USDC'
    table.string('quote_asset').notNullable(); // e.g., 'USD', 'EUR'
    table.decimal('price', 20, 8).notNullable();
    table.string('source').notNullable(); // 'stellar', 'coinbase', 'binance'
    table.timestamp('timestamp').defaultTo(knex.fn.now());
    
    table.index(['base_asset', 'quote_asset']);
    table.index('timestamp');
    table.index('source');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('price_cache');
};
