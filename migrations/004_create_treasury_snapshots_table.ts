import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('treasury_snapshots', (table: any) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    table.decimal('total_value_usd', 20, 8).notNullable();
    table.json('asset_breakdown').notNullable(); // JSON breakdown of assets
    table.timestamp('timestamp').defaultTo(knex.fn.now());
    
    table.index('merchant_id');
    table.index('timestamp');
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable('treasury_snapshots');
}
