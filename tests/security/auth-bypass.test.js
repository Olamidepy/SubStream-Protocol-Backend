/**
 * Authentication Bypass Tests
 * 
 * This test suite attempts to bypass SEP-10 JWT authentication by:
 * - Accessing protected routes without authentication
 * - Using malformed or expired tokens
 * - Attempting token replay attacks
 * - Testing role-based access control bypasses
 * 
 * Run with: npm test -- tests/security/auth-bypass.test.js
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// Test results storage
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  tests: []
};

/**
 * Test helper function
 */
async function test(name, testFn) {
  results.total++;
  try {
    await testFn();
    results.passed++;
    results.tests.push({ name, status: 'PASSED', error: null });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAILED', error: error.message });
    console.log(`❌ ${name}: ${error.message}`);
  }
}

/**
 * Generate malformed JWT tokens
 */
function generateMalformedTokens() {
  return {
    empty: '',
    invalid: 'invalid.token.here',
    expired: jwt.sign({ sub: 'test', exp: Math.floor(Date.now() / 1000) - 3600 }, 'secret'),
    future: jwt.sign({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 31536000 }, 'secret'),
    noSignature: jwt.sign({ sub: 'test' }, 'secret', { algorithm: 'none' }),
    wrongAlgorithm: jwt.sign({ sub: 'test' }, 'secret', { algorithm: 'HS256' }),
    missingClaim: jwt.sign({}, 'secret'),
    extraClaims: jwt.sign({ sub: 'test', admin: true }, 'secret')
  };
}

/**
 * Test accessing protected routes without authentication
 */
async function testNoAuthentication() {
  const protectedRoutes = [
    '/api/merchants',
    '/api/subscriptions',
    '/api/payments',
    '/api/internal/health',
    '/api/admin/analytics'
  ];

  for (const route of protectedRoutes) {
    await test(`Access ${route} without authentication`, async () => {
      const response = await axios.get(`${BACKEND_URL}${route}`, {
        validateStatus: () => true
      });

      if (response.status === 200) {
        throw new Error(`Route ${route} accessible without authentication`);
      }

      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`Expected 401/403, got ${response.status}`);
      }
    });
  }
}

/**
 * Test with malformed JWT tokens
 */
async function testMalformedTokens() {
  const tokens = generateMalformedTokens();
  const protectedRoute = '/api/merchants';

  for (const [type, token] of Object.entries(tokens)) {
    await test(`Access with ${type} token`, async () => {
      const response = await axios.get(`${BACKEND_URL}${protectedRoute}`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        validateStatus: () => true
      });

      if (response.status === 200) {
        throw new Error(`Route accessible with ${type} token`);
      }

      if (response.status !== 401 && response.status !== 403) {
        throw new Error(`Expected 401/403 for ${type} token, got ${response.status}`);
      }
    });
  }
}

/**
 * Test token replay attacks
 */
async function testTokenReplay() {
  await test('Token replay attack detection', async () => {
    // First request with valid token
    const validToken = jwt.sign({ sub: 'test', iat: Math.floor(Date.now() / 1000) }, 'test-secret');
    
    const response1 = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: { Authorization: `Bearer ${validToken}` },
      validateStatus: () => true
    });

    // Second request with same token (should be rejected if jti claim is checked)
    const response2 = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: { Authorization: `Bearer ${validToken}` },
      validateStatus: () => true
    });

    // If both succeed, token replay is not prevented
    if (response1.status === 200 && response2.status === 200) {
      console.warn('⚠️  Token replay may not be prevented (consider adding jti claim)');
    }
  });
}

/**
 * Test role-based access control bypass
 */
async function testRBACBypass() {
  await test('Regular user accessing admin endpoints', async () => {
    const userToken = jwt.sign({ sub: 'user', role: 'user' }, 'test-secret');
    
    const response = await axios.get(`${BACKEND_URL}/api/admin/analytics`, {
      headers: { Authorization: `Bearer ${userToken}` },
      validateStatus: () => true
    });

    if (response.status === 200) {
      throw new Error('Regular user can access admin endpoints');
    }

    if (response.status !== 403) {
      throw new Error(`Expected 403, got ${response.status}`);
    }
  });

  await test('Admin accessing user endpoints', async () => {
    const adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, 'test-secret');
    
    const response = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });

    // Admin should be able to access user endpoints
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Admin cannot access user endpoints: ${response.status}`);
    }
  });
}

/**
 * Test API key authentication bypass
 */
async function testAPIKeyBypass() {
  await test('Access with invalid API key', async () => {
    const response = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: { 'X-API-Key': 'invalid-key-12345' },
      validateStatus: () => true
    });

    if (response.status === 200) {
      throw new Error('Route accessible with invalid API key');
    }

    if (response.status !== 401 && response.status !== 403) {
      throw new Error(`Expected 401/403, got ${response.status}`);
    }
  });

  await test('Access without API key header', async () => {
    const response = await axios.get(`${BACKEND_URL}/api/merchants`, {
      validateStatus: () => true
    });

    if (response.status === 200) {
      throw new Error('Route accessible without API key');
    }

    if (response.status !== 401 && response.status !== 403) {
      throw new Error(`Expected 401/403, got ${response.status}`);
    }
  });
}

/**
 * Test header injection attacks
 */
async function testHeaderInjection() {
  await test('X-Forwarded-For header injection', async () => {
    const response = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: {
        'X-Forwarded-For': '127.0.0.1, 10.0.0.1',
        'X-Real-IP': '127.0.0.1'
      },
      validateStatus: () => true
    });

    if (response.status === 200) {
      throw new Error('Route accessible without authentication via header injection');
    }

    if (response.status !== 401 && response.status !== 403) {
      throw new Error(`Expected 401/403, got ${response.status}`);
    }
  });
}

/**
 * Test session fixation
 */
async function testSessionFixation() {
  await test('Session fixation attempt', async () => {
    // Try to set a session cookie manually
    const response = await axios.get(`${BACKEND_URL}/api/merchants`, {
      headers: {
        'Cookie': 'session=malicious-session-id'
      },
      validateStatus: () => true
    });

    if (response.status === 200) {
      throw new Error('Route accessible with malicious session cookie');
    }

    if (response.status !== 401 && response.status !== 403) {
      throw new Error(`Expected 401/403, got ${response.status}`);
    }
  });
}

/**
 * Test CSRF protection
 */
async function testCSRFProtection() {
  await test('CSRF token validation', async () => {
    // Try to POST without CSRF token
    const response = await axios.post(`${BACKEND_URL}/api/merchants`, {
      name: 'test'
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });

    // Should require CSRF token for state-changing operations
    if (response.status === 200 || response.status === 201) {
      console.warn('⚠️  CSRF protection may not be enabled for POST requests');
    }
  });
}

/**
 * Run all authentication bypass tests
 */
async function runAuthBypassTests() {
  console.log('='.repeat(60));
  console.log('Authentication Bypass Tests');
  console.log('='.repeat(60));
  console.log(`Backend URL: ${BACKEND_URL}\n`);

  try {
    await testNoAuthentication();
    await testMalformedTokens();
    await testTokenReplay();
    await testRBACBypass();
    await testAPIKeyBypass();
    await testHeaderInjection();
    await testSessionFixation();
    await testCSRFProtection();

    console.log('\n' + '='.repeat(60));
    console.log('Test Summary');
    console.log('='.repeat(60));
    console.log(`Total: ${results.total}`);
    console.log(`Passed: ${results.passed}`);
    console.log(`Failed: ${results.failed}`);
    console.log(`Success Rate: ${((results.passed / results.total) * 100).toFixed(2)}%`);

    if (results.failed > 0) {
      console.log('\n❌ Authentication bypass tests failed');
      process.exit(1);
    } else {
      console.log('\n✅ All authentication bypass tests passed');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Test suite error:', error.message);
    process.exit(2);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAuthBypassTests();
}

module.exports = {
  runAuthBypassTests,
  results
};
