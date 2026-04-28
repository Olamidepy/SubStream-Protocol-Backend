const request = require('supertest');
const SandboxService = require('../services/sandboxService');
const SandboxDatabase = require('../src/db/sandboxDatabase');

describe('Sandbox Environment Tests', () => {
  let app;
  let sandboxService;
  let sandboxDb;
  let authToken;

  beforeAll(async () => {
    // Set environment variables for sandbox testing
    process.env.SANDBOX_ENABLED = 'true';
    process.env.SANDBOX_MODE = 'testnet';
    process.env.SANDBOX_MOCK_PAYMENTS_ENABLED = 'true';
    process.env.SANDBOX_FAILURE_SIMULATION_ENABLED = 'true';
    process.env.SANDBOX_ZERO_VALUE_TOKENS_ENABLED = 'true';
    process.env.SANDBOX_DB_SCHEMA_PREFIX = 'test_sandbox_';

    // Initialize services
    sandboxService = new SandboxService();
    await sandboxService.initialize();

    sandboxDb = new SandboxDatabase(':memory:', sandboxService);
    await sandboxDb.initialize();

    // Get the Express app
    const { createApp } = require('../index');
    app = await createApp();
  });

  afterAll(async () => {
    if (sandboxDb) {
      sandboxDb.close();
    }
  });

  describe('Sandbox Configuration', () => {
    test('should initialize with sandbox mode enabled', () => {
      expect(sandboxService.isSandboxMode).toBe(true);
    });

    test('should use testnet configuration', () => {
      const stellarConfig = sandboxService.getStellarConfig();
      expect(stellarConfig.networkPassphrase).toContain('Test');
      expect(stellarConfig.horizonUrl).toContain('testnet');
    });

    test('should have sandbox database schema prefix', () => {
      const schema = sandboxService.getDatabaseSchema();
      expect(schema).toBe('test_sandbox_');
    });

    test('should have zero-value tokens enabled', async () => {
      const status = sandboxService.getStatus();
      expect(status.features.zeroValueTokens).toBe(true);
    });
  });

  describe('Sandbox Status API', () => {
    test('GET /api/sandbox/status should return sandbox status', async () => {
      const response = await request(app)
        .get('/api/sandbox/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.enabled).toBe(true);
      expect(response.body.data.mode).toBe('testnet');
      expect(response.body.data.features.mockPayments).toBe(true);
      expect(response.body.data.features.failureSimulation).toBe(true);
      expect(response.body.data.features.zeroValueTokens).toBe(true);
    });
  });

  describe('Mock Payment API', () => {
    test('POST /api/sandbox/mock-payment should create mock payment', async () => {
      const paymentData = {
        subscriptionId: 'test_subscription_001',
        creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
        subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
        amount: 0,
        tier: 'bronze',
        metadata: { test: true }
      };

      const response = await request(app)
        .post('/api/sandbox/mock-payment')
        .send(paymentData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.type).toBe('SubscriptionBilled');
      expect(response.body.data.data.subscriptionId).toBe(paymentData.subscriptionId);
      expect(response.body.data.data.amount).toBe(0);
      expect(response.body.data.data.isMock).toBe(true);
    });

    test('should reject non-zero amounts when zero-value tokens enabled', async () => {
      const paymentData = {
        subscriptionId: 'test_subscription_002',
        creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
        subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
        amount: 10.50, // Non-zero amount
        tier: 'silver'
      };

      const response = await request(app)
        .post('/api/sandbox/mock-payment')
        .send(paymentData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Zero-value tokens enabled');
    });

    test('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/sandbox/mock-payment')
        .send({
          creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7'
          // Missing required fields
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Missing required fields');
    });
  });

  describe('Failure Simulation API', () => {
    test('POST /api/sandbox/simulate-failure should simulate payment failure', async () => {
      const failureData = {
        subscriptionId: 'test_subscription_003',
        failureType: 'insufficient_funds'
      };

      const response = await request(app)
        .post('/api/sandbox/simulate-failure')
        .send(failureData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.type).toBe('PaymentFailed');
      expect(response.body.data.data.subscriptionId).toBe(failureData.subscriptionId);
      expect(response.body.data.data.failureType).toBe(failureData.failureType);
      expect(response.body.data.data.isMock).toBe(true);
    });

    test('should simulate different failure types', async () => {
      const failureTypes = ['insufficient_funds', 'network_error', 'timeout'];

      for (const failureType of failureTypes) {
        const response = await request(app)
          .post('/api/sandbox/simulate-failure')
          .send({
            subscriptionId: `test_subscription_${failureType}`,
            failureType
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.data.failureType).toBe(failureType);
      }
    });
  });

  describe('Testnet Account API', () => {
    test('POST /api/sandbox/testnet-account should create testnet account', async () => {
      const response = await request(app)
        .post('/api/sandbox/testnet-account')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(response.body.data.secretKey).toMatch(/^S[A-Z0-9]{55}$/);
      expect(response.body.data.network).toContain('Test');
    });

    test('created account should use testnet configuration', async () => {
      const response = await request(app)
        .post('/api/sandbox/testnet-account')
        .expect(200);

      const account = response.body.data;
      const stellarConfig = sandboxService.getStellarConfig();
      
      expect(account.horizonUrl).toBe(stellarConfig.horizonUrl);
      expect(account.network).toBe(stellarConfig.networkPassphrase);
    });
  });

  describe('Mock Events API', () => {
    beforeEach(async () => {
      // Clear events before each test
      await request(app)
        .delete('/api/sandbox/mock-events')
        .expect(200);
    });

    test('GET /api/sandbox/mock-events should return empty list initially', async () => {
      const response = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.events).toEqual([]);
      expect(response.body.data.total).toBe(0);
    });

    test('should return created mock events', async () => {
      // Create a mock payment
      await request(app)
        .post('/api/sandbox/mock-payment')
        .send({
          subscriptionId: 'test_subscription_events',
          creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
          subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
          amount: 0,
          tier: 'bronze'
        });

      // Get events
      const response = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.events).toHaveLength(1);
      expect(response.body.data.events[0].type).toBe('SubscriptionBilled');
      expect(response.body.data.total).toBe(1);
    });

    test('should support pagination', async () => {
      // Create multiple events
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/sandbox/mock-payment')
          .send({
            subscriptionId: `test_subscription_${i}`,
            creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
            subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
            amount: 0,
            tier: 'bronze'
          });
      }

      // Test pagination
      const response = await request(app)
        .get('/api/sandbox/mock-events?limit=2&offset=0')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.events).toHaveLength(2);
      expect(response.body.data.hasMore).toBe(true);
    });

    test('DELETE /api/sandbox/mock-events should clear all events', async () => {
      // Create an event
      await request(app)
        .post('/api/sandbox/mock-payment')
        .send({
          subscriptionId: 'test_subscription_clear',
          creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
          subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
          amount: 0,
          tier: 'bronze'
        });

      // Clear events
      const response = await request(app)
        .delete('/api/sandbox/mock-events')
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify events are cleared
      const getResponse = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(getResponse.body.data.events).toEqual([]);
    });
  });

  describe('Webhook Testing API', () => {
    test('POST /api/sandbox/webhook-test should test webhook delivery', async () => {
      const webhookData = {
        webhookUrl: 'https://webhook.site/test',
        eventType: 'SubscriptionBilled',
        payload: {
          subscriptionId: 'test_webhook_001',
          amount: 0,
          tier: 'bronze'
        }
      };

      const response = await request(app)
        .post('/api/sandbox/webhook-test')
        .send(webhookData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.eventId).toBeDefined();
      expect(response.body.data.webhookUrl).toBe(webhookData.webhookUrl);
      expect(response.body.data.eventType).toBe(webhookData.eventType);
    });

    test('should validate webhook URL', async () => {
      const response = await request(app)
        .post('/api/sandbox/webhook-test')
        .send({
          eventType: 'SubscriptionBilled'
          // Missing webhookUrl
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Missing required fields');
    });
  });

  describe('Failure Rules API', () => {
    test('GET /api/sandbox/failure-rules should return failure rules', async () => {
      const response = await request(app)
        .get('/api/sandbox/failure-rules')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThan(0);
      
      const randomFailureRule = response.body.data.find(rule => rule.name === 'random_failure');
      expect(randomFailureRule).toBeDefined();
      expect(randomFailureRule.enabled).toBe(true);
      expect(randomFailureRule.probability).toBeDefined();
    });

    test('PUT /api/sandbox/failure-rules/:ruleName should update failure rule', async () => {
      const updatedRule = {
        enabled: true,
        probability: 0.15,
        types: ['insufficient_funds', 'network_error', 'timeout', 'account_locked']
      };

      const response = await request(app)
        .put('/api/sandbox/failure-rules/random_failure')
        .send(updatedRule)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.enabled).toBe(updatedRule.enabled);
      expect(response.body.data.probability).toBe(updatedRule.probability);
      expect(response.body.data.types).toEqual(updatedRule.types);
    });
  });

  describe('Database Schema Isolation', () => {
    test('should use sandbox schema prefixes', () => {
      const creatorsTable = sandboxDb.getTableName('creators');
      const subscriptionsTable = sandboxDb.getTableName('subscriptions');
      
      expect(creatorsTable).toBe('test_sandbox_creators');
      expect(subscriptionsTable).toBe('test_sandbox_subscriptions');
    });

    test('should insert and retrieve data with sandbox schema', async () => {
      // Insert a creator
      sandboxDb.insertCreator('test_creator_001');
      
      // Insert a mock event
      const mockEvent = {
        id: 'mock_event_001',
        type: 'SubscriptionBilled',
        data: { subscriptionId: 'test_subscription_001' },
        timestamp: new Date().toISOString(),
        source: 'test'
      };
      
      sandboxDb.insertMockEvent(mockEvent);
      
      // Get database stats
      const stats = sandboxDb.getStats();
      expect(stats.mode).toBe('sandbox');
      expect(stats.schemaPrefix).toBe('test_sandbox_');
      expect(stats.creators).toBe(1);
      expect(stats.mockEvents).toBe(1);
    });

    test('should get mock events from sandbox database', async () => {
      // Clear existing events
      sandboxDb.clearMockEvents();
      
      // Insert test events
      const events = [
        {
          id: 'test_event_001',
          type: 'SubscriptionBilled',
          data: { subscriptionId: 'sub_001' },
          timestamp: new Date().toISOString(),
          source: 'test'
        },
        {
          id: 'test_event_002',
          type: 'PaymentFailed',
          data: { subscriptionId: 'sub_002', failureType: 'insufficient_funds' },
          timestamp: new Date().toISOString(),
          source: 'test'
        }
      ];
      
      events.forEach(event => sandboxDb.insertMockEvent(event));
      
      // Get events
      const result = sandboxDb.getMockEvents(10, 0);
      expect(result.events).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(false);
      
      // Verify event data
      expect(result.events[0].type).toBe('SubscriptionBilled');
      expect(result.events[1].type).toBe('PaymentFailed');
    });
  });

  describe('Zero-Value Token Validation', () => {
    test('should validate zero-value operations', () => {
      const validOperation = sandboxService.validateOperation('mock_payment', 0);
      expect(validOperation.allowed).toBe(true);
      
      const invalidOperation = sandboxService.validateOperation('mock_payment', 10);
      expect(invalidOperation.allowed).toBe(false);
      expect(invalidOperation.reason).toContain('Zero-value tokens enabled');
    });

    test('should allow non-zero amounts when zero-value tokens disabled', async () => {
      // Temporarily disable zero-value tokens
      process.env.SANDBOX_ZERO_VALUE_TOKENS_ENABLED = 'false';
      await sandboxService.initialize();
      
      const validOperation = sandboxService.validateOperation('mock_payment', 10);
      expect(validOperation.allowed).toBe(true);
      
      // Re-enable for other tests
      process.env.SANDBOX_ZERO_VALUE_TOKENS_ENABLED = 'true';
      await sandboxService.initialize();
    });
  });

  describe('Failure Simulation Logic', () => {
    test('should determine when to simulate failures', () => {
      const result = sandboxService.shouldSimulateFailure('payment');
      expect(result).toHaveProperty('shouldFail');
      expect(result).toHaveProperty('failureType');
      expect(result).toHaveProperty('reason');
    });

    test('should not simulate failures when disabled', async () => {
      // Temporarily disable failure simulation
      process.env.SANDBOX_FAILURE_SIMULATION_ENABLED = 'false';
      await sandboxService.initialize();
      
      const result = sandboxService.shouldSimulateFailure('payment');
      expect(result.shouldFail).toBe(false);
      
      // Re-enable for other tests
      process.env.SANDBOX_FAILURE_SIMULATION_ENABLED = 'true';
      await sandboxService.initialize();
    });
  });

  describe('Integration Tests', () => {
    test('complete sandbox workflow with zero-value tokens', async () => {
      // 1. Check initial status
      const statusResponse = await request(app)
        .get('/api/sandbox/status')
        .expect(200);
      
      expect(statusResponse.body.data.enabled).toBe(true);
      expect(statusResponse.body.data.features.zeroValueTokens).toBe(true);

      // 2. Create testnet account
      const accountResponse = await request(app)
        .post('/api/sandbox/testnet-account')
        .expect(200);
      
      const { publicKey, secretKey } = accountResponse.data;
      expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(secretKey).toMatch(/^S[A-Z0-9]{55}$/);

      // 3. Create mock payment with zero value
      const paymentResponse = await request(app)
        .post('/api/sandbox/mock-payment')
        .send({
          subscriptionId: 'integration_test_001',
          creatorAddress: publicKey,
          subscriberAddress: publicKey,
          amount: 0,
          tier: 'bronze'
        })
        .expect(200);

      expect(paymentResponse.body.data.data.amount).toBe(0);
      expect(paymentResponse.body.data.data.isMock).toBe(true);

      // 4. Verify event was created
      const eventsResponse = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(eventsResponse.body.data.events).toHaveLength(1);
      expect(eventsResponse.body.data.events[0].type).toBe('SubscriptionBilled');

      // 5. Simulate failure
      const failureResponse = await request(app)
        .post('/api/sandbox/simulate-failure')
        .send({
          subscriptionId: 'integration_test_001',
          failureType: 'insufficient_funds'
        })
        .expect(200);

      expect(failureResponse.body.data.type).toBe('PaymentFailed');

      // 6. Verify both events exist
      const finalEventsResponse = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(finalEventsResponse.body.data.events).toHaveLength(2);

      // 7. Test webhook delivery
      const webhookResponse = await request(app)
        .post('/api/sandbox/webhook-test')
        .send({
          webhookUrl: 'https://webhook.site/integration-test',
          eventType: 'SubscriptionBilled',
          payload: {
            subscriptionId: 'integration_test_001',
            amount: 0,
            creatorAddress: publicKey,
            subscriberAddress: publicKey
          }
        })
        .expect(200);

      expect(webhookResponse.body.data.eventId).toBeDefined();

      // 8. Clean up
      await request(app)
        .delete('/api/sandbox/mock-events')
        .expect(200);

      const cleanupResponse = await request(app)
        .get('/api/sandbox/mock-events')
        .expect(200);

      expect(cleanupResponse.body.data.events).toHaveLength(0);
    });
  });
});
