import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // Create sample merchants
  const merchants = [
    {
      id: '550e8400-e29b-41d4-a716-446655440001',
      name: 'Acme Corporation',
      base_currency: 'USD',
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      id: '550e8400-e29b-41d4-a716-446655440002', 
      name: 'Global Tech Ltd',
      base_currency: 'EUR',
      created_at: new Date(),
      updated_at: new Date()
    }
  ];

  await knex('merchants').del(); // Clear existing
  await knex('merchants').insert(merchants);

  // Create sample merchant balances
  const balances = [
    // Acme Corporation balances
    {
      id: '660e8400-e29b-41d4-a716-446655440001',
      merchant_id: '550e8400-e29b-41d4-a716-446655440001',
      asset_code: 'XLM',
      balance: '10000.50000000',
      last_updated: new Date()
    },
    {
      id: '660e8400-e29b-41d4-a716-446655440002',
      merchant_id: '550e8400-e29b-41d4-a716-446655440001',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5HVCI5YJPNOIYSWKJ6RUMLA5OZNGXXHQ5T7YRWDWBR',
      balance: '50000.00000000',
      last_updated: new Date()
    },
    {
      id: '660e8400-e29b-41d4-a716-446655440003',
      merchant_id: '550e8400-e29b-41d4-a716-446655440001',
      asset_code: 'EURC',
      asset_issuer: 'GAK5A6Y5N4JQK3DRMLNDJZTFJ2XGQZSHJLLZDGKQK5DKHP5A6YZQKXZ',
      balance: '30000.00000000',
      last_updated: new Date()
    },
    
    // Global Tech Ltd balances
    {
      id: '660e8400-e29b-41d4-a716-446655440004',
      merchant_id: '550e8400-e29b-41d4-a716-446655440002',
      asset_code: 'XLM',
      balance: '7500.25000000',
      last_updated: new Date()
    },
    {
      id: '660e8400-e29b-41d4-a716-446655440005',
      merchant_id: '550e8400-e29b-41d4-a716-446655440002',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5HVCI5YJPNOIYSWKJ6RUMLA5OZNGXXHQ5T7YRWDWBR',
      balance: '25000.00000000',
      last_updated: new Date()
    }
  ];

  await knex('merchant_balances').del(); // Clear existing
  await knex('merchant_balances').insert(balances);

  // Create sample price cache data
  const prices = [
    {
      id: '770e8400-e29b-41d4-a716-446655440001',
      base_asset: 'XLM',
      quote_asset: 'USD',
      price: '0.13340000',
      source: 'stellar',
      timestamp: new Date()
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440002',
      base_asset: 'USDC',
      quote_asset: 'USD',
      price: '1.00000000',
      source: 'stellar',
      timestamp: new Date()
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440003',
      base_asset: 'EURC',
      quote_asset: 'USD',
      price: '1.08000000',
      source: 'stellar',
      timestamp: new Date()
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440004',
      base_asset: 'XLM',
      quote_asset: 'EUR',
      price: '0.12350000',
      source: 'stellar',
      timestamp: new Date()
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440005',
      base_asset: 'USD',
      quote_asset: 'EUR',
      price: '0.92590000',
      source: 'coinbase',
      timestamp: new Date()
    }
  ];

  await knex('price_cache').del(); // Clear existing
  await knex('price_cache').insert(prices);

  // Create historical price data (24h ago) for delta calculations
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const historicalPrices = [
    {
      id: '770e8400-e29b-41d4-a716-446655440006',
      base_asset: 'XLM',
      quote_asset: 'USD',
      price: '0.12800000', // Lower price 24h ago
      source: 'stellar',
      timestamp: yesterday
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440007',
      base_asset: 'USDC',
      quote_asset: 'USD',
      price: '1.00000000',
      source: 'stellar',
      timestamp: yesterday
    },
    {
      id: '770e8400-e29b-41d4-a716-446655440008',
      base_asset: 'EURC',
      quote_asset: 'USD',
      price: '1.07500000', // Lower price 24h ago
      source: 'stellar',
      timestamp: yesterday
    }
  ];

  await knex('price_cache').insert(historicalPrices);
}
