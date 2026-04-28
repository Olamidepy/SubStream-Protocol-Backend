import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('merchant_balances', (table: any) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    table.string('asset_code').notNullable(); // e.g., 'XLM', 'USDC', 'EURC'
    table.string('asset_issuer').nullable(); // Stellar asset issuer
    table.decimal('balance', 20, 8).notNullable().defaultTo(0);
    table.timestamp('last_updated').defaultTo(knex.fn.now());
    
    table.unique(['merchant_id', 'asset_code']);
    table.index('merchant_id');
    table.index('asset_code');
    table.index('last_updated');
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable('merchant_balances');
}
