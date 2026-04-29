const express = require('express');
const router = express.Router();
const SandboxService = require('../services/sandboxService');
const { authenticateStellarToken } = require('../middleware/stellarAuth');

const sandboxService = new SandboxService();

// Initialize sandbox service
sandboxService.initialize().catch(console.error);

/**
 * GET /api/sandbox/status
 * Get sandbox environment status and configuration
 */
router.get('/status', async (req, res) => {
  try {
    const status = sandboxService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('[Sandbox] Error getting status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get sandbox status'
    });
  }
});

/**
 * POST /api/sandbox/mock-payment
 * Create a mock payment event for testing
 */
router.post('/mock-payment', authenticateStellarToken, async (req, res) => {
  try {
    const {
      subscriptionId,
      creatorAddress,
      subscriberAddress,
      amount = 0,
      tier = 'bronze',
      metadata = {}
    } = req.body;

    // Validate required fields
    if (!subscriptionId || !creatorAddress || !subscriberAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: subscriptionId, creatorAddress, subscriberAddress'
      });
    }

    // Validate operation in sandbox mode
    const validation = sandboxService.validateOperation('mock_payment', amount);
    if (!validation.allowed) {
      return res.status(400).json({
        success: false,
        error: validation.reason
      });
    }

    const mockPayment = await sandboxService.createMockPayment({
      subscriptionId,
      creatorAddress: creatorAddress.toLowerCase(),
      subscriberAddress: subscriberAddress.toLowerCase(),
      amount,
      tier,
      metadata,
      createdBy: req.user.publicKey
    });

    res.json({
      success: true,
      data: mockPayment
    });
  } catch (error) {
    console.error('[Sandbox] Error creating mock payment:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create mock payment'
    });
  }
});

/**
 * POST /api/sandbox/simulate-failure
 * Simulate a payment failure for testing
 */
router.post('/simulate-failure', authenticateStellarToken, async (req, res) => {
  try {
    const { subscriptionId, failureType = 'insufficient_funds' } = req.body;

    if (!subscriptionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: subscriptionId'
      });
    }

    const failureEvent = await sandboxService.simulatePaymentFailure(subscriptionId, failureType);

    res.json({
      success: true,
      data: failureEvent
    });
  } catch (error) {
    console.error('[Sandbox] Error simulating failure:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to simulate failure'
    });
  }
});

/**
 * GET /api/sandbox/mock-events
 * Get history of mock events
 */
router.get('/mock-events', authenticateStellarToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const events = sandboxService.getMockEvents(limit, offset);

    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    console.error('[Sandbox] Error getting mock events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get mock events'
    });
  }
});

/**
 * DELETE /api/sandbox/mock-events
 * Clear all mock events
 */
router.delete('/mock-events', authenticateStellarToken, async (req, res) => {
  try {
    sandboxService.clearMockEvents();

    res.json({
      success: true,
      message: 'Mock events cleared successfully'
    });
  } catch (error) {
    console.error('[Sandbox] Error clearing mock events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear mock events'
    });
  }
});

/**
 * POST /api/sandbox/testnet-account
 * Create a new testnet account with funding
 */
router.post('/testnet-account', authenticateStellarToken, async (req, res) => {
  try {
    const account = await sandboxService.createTestnetFundingAccount();

    res.json({
      success: true,
      data: account
    });
  } catch (error) {
    console.error('[Sandbox] Error creating testnet account:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create testnet account'
    });
  }
});

/**
 * POST /api/sandbox/webhook-test
 * Test webhook delivery with mock data
 */
router.post('/webhook-test', authenticateStellarToken, async (req, res) => {
  try {
    const { webhookUrl, eventType, payload } = req.body;

    if (!webhookUrl || !eventType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: webhookUrl, eventType'
      });
    }

    // Create test webhook event
    const testEvent = {
      id: `webhook_test_${Date.now()}`,
      type: eventType,
      timestamp: new Date().toISOString(),
      data: payload || {
        subscriptionId: 'test_subscription_123',
        amount: 0,
        isTest: true
      },
      test: true
    };

    // Emit webhook test event
    sandboxService.emit('webhookTest', { webhookUrl, event: testEvent });

    res.json({
      success: true,
      data: {
        eventId: testEvent.id,
        webhookUrl,
        eventType,
        status: 'sent'
      }
    });
  } catch (error) {
    console.error('[Sandbox] Error testing webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to test webhook'
    });
  }
});

/**
 * GET /api/sandbox/failure-rules
 * Get current failure simulation rules
 */
router.get('/failure-rules', authenticateStellarToken, async (req, res) => {
  try {
    const status = sandboxService.getStatus();
    
    res.json({
      success: true,
      data: status.failureRules
    });
  } catch (error) {
    console.error('[Sandbox] Error getting failure rules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get failure rules'
    });
  }
});

/**
 * PUT /api/sandbox/failure-rules/:ruleName
 * Update failure simulation rules
 */
router.put('/failure-rules/:ruleName', authenticateStellarToken, async (req, res) => {
  try {
    const { ruleName } = req.params;
    const ruleUpdates = req.body;

    // Update the rule in sandbox service
    const currentRules = sandboxService.failureSimulationRules.get(ruleName);
    if (!currentRules) {
      return res.status(404).json({
        success: false,
        error: 'Failure rule not found'
      });
    }

    const updatedRule = { ...currentRules, ...ruleUpdates };
    sandboxService.failureSimulationRules.set(ruleName, updatedRule);

    res.json({
      success: true,
      data: updatedRule
    });
  } catch (error) {
    console.error('[Sandbox] Error updating failure rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update failure rule'
    });
  }
});

module.exports = router;
