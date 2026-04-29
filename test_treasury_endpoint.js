// Test script for the consolidated treasury endpoint
const axios = require('axios');

const BASE_URL = 'http://localhost:3001/api/v1';
const MERCHANT_ID = '550e8400-e29b-41d4-a716-446655440001'; // Acme Corporation

async function testConsolidatedTreasury() {
  console.log('🧪 Testing Consolidated Treasury Endpoint...\n');
  
  try {
    // Test 1: Get consolidated treasury for Acme Corporation
    console.log('📊 Test 1: GET /merchants/:id/treasury/consolidated');
    const response = await axios.get(`${BASE_URL}/merchants/${MERCHANT_ID}/treasury/consolidated`);
    
    console.log('✅ Success! Response status:', response.status);
    console.log('📄 Response data:');
    console.log(JSON.stringify(response.data, null, 2));
    
    // Validate response structure
    const { data } = response.data;
    const requiredFields = ['merchantId', 'baseCurrency', 'totalValueLocked', 'totalValueLockedUsd', 'delta24h', 'assetBreakdown', 'lastUpdated'];
    
    console.log('\n🔍 Validating response structure...');
    for (const field of requiredFields) {
      if (data[field] === undefined) {
        console.error(`❌ Missing required field: ${field}`);
        return;
      }
      console.log(`✅ ${field}: ${typeof data[field]}`);
    }
    
    // Validate asset breakdown
    console.log('\n💰 Asset Breakdown:');
    data.assetBreakdown.forEach((asset, index) => {
      console.log(`  ${index + 1}. ${asset.assetCode}: ${asset.balance} (${asset.valueInBaseCurrency} ${data.baseCurrency})`);
      console.log(`     Value in USD: $${asset.valueInUsd} (${asset.percentageOfTotal}% of total)`);
      console.log(`     Current Price: $${asset.currentPrice}`);
      if (asset.priceChange24h !== undefined) {
        console.log(`     24h Change: ${asset.priceChange24h}%`);
      }
    });
    
    console.log(`\n📈 Total Value Locked: ${data.totalValueLocked} ${data.baseCurrency}`);
    console.log(`💵 Total Value Locked (USD): $${data.totalValueLockedUsd}`);
    console.log(`📊 24h Delta: ${data.delta24h.absolute} (${data.delta24h.percentage}%)`);
    
    // Test 2: Get treasury history
    console.log('\n\n📈 Test 2: GET /merchants/:id/treasury/history');
    const historyResponse = await axios.get(`${BASE_URL}/merchants/${MERCHANT_ID}/treasury/history?days=7`);
    
    console.log('✅ History endpoint success!');
    console.log(`📊 History entries: ${historyResponse.data.data.history.length}`);
    
    // Test 3: Test with non-existent merchant
    console.log('\n\n❌ Test 3: GET /merchants/:id/treasury/consolidated (non-existent merchant)');
    try {
      await axios.get(`${BASE_URL}/merchants/non-existent-id/treasury/consolidated`);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log('✅ Correctly returned 404 for non-existent merchant');
      } else {
        throw error;
      }
    }
    
    console.log('\n🎉 All tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// Run tests if server is available
async function checkServerAndRunTests() {
  try {
    await axios.get(`${BASE_URL}/health`);
    console.log('✅ Server is running, starting tests...\n');
    await testConsolidatedTreasury();
  } catch (error) {
    console.log('❌ Server is not running. Please start the server first:');
    console.log('   npm run dev or npm start');
    console.log('   Then run this test script again.');
  }
}

checkServerAndRunTests();
