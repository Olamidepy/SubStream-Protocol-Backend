const express = require('express');
const { authenticateToken, getUserId } = require('../middleware/unifiedAuth');
const PreBillingHealthWorker = require('../workers/preBillingHealthWorker');
const PreBillingHealthCheck = require('../services/preBillingHealthCheck');
const PreBillingEmailService = require('../services/preBillingEmailService');

const router = express.Router();

/**
 * GET /api/v1/pre-billing/status
 * Get pre-billing health check worker status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    
    // Initialize worker with user's database context
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const status = worker.getStatus();
    
    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    console.error('Get pre-billing status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get pre-billing status'
    });
  }
});

/**
 * POST /api/v1/pre-billing/trigger
 * Manually trigger pre-billing health check
 */
router.post('/trigger', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { targetDate, options = {} } = req.body;

    // Initialize worker
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    let result;
    if (targetDate) {
      // Trigger for specific date
      const date = new Date(targetDate);
      if (isNaN(date.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid targetDate format'
        });
      }
      result = await worker.triggerForDate(date);
    } else {
      // Trigger regular health check
      result = await worker.runHealthCheck(options);
    }

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Trigger pre-billing health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to trigger pre-billing health check'
    });
  }
});

/**
 * GET /api/v1/pre-billing/upcoming
 * Get upcoming subscriptions that need warnings
 */
router.get('/upcoming', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { daysAhead = 3 } = req.query;

    // Initialize health check service
    const healthCheck = new PreBillingHealthCheck({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const upcomingSubscriptions = healthCheck.getSubscriptionsNeedingWarnings(parseInt(daysAhead));

    res.json({
      success: true,
      data: {
        daysAhead: parseInt(daysAhead),
        count: upcomingSubscriptions.length,
        subscriptions: upcomingSubscriptions
      }
    });

  } catch (error) {
    console.error('Get upcoming subscriptions error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get upcoming subscriptions'
    });
  }
});

/**
 * POST /api/v1/pre-billing/test-wallet
 * Test health check for a specific wallet
 */
router.post('/test-wallet', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { walletAddress, requiredAmount = 0 } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'walletAddress is required'
      });
    }

    // Validate Stellar public key format
    try {
      const { StellarSdk } = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(walletAddress);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar public key format'
      });
    }

    // Initialize worker
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const result = await worker.testWallet(walletAddress, requiredAmount);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Test wallet health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to test wallet health check'
    });
  }
});

/**
 * GET /api/v1/pre-billing/metrics
 * Get pre-billing health check metrics
 */
router.get('/metrics', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);

    // Initialize worker
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const metrics = worker.getMetrics();

    res.json({
      success: true,
      data: metrics
    });

  } catch (error) {
    console.error('Get pre-billing metrics error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get pre-billing metrics'
    });
  }
});

/**
 * GET /api/v1/pre-billing/health
 * Health check endpoint for monitoring
 */
router.get('/health', async (req, res) => {
  try {
    // Initialize worker
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const health = worker.health();

    res.json({
      success: true,
      data: health
    });

  } catch (error) {
    console.error('Pre-billing health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Health check failed'
    });
  }
});

/**
 * POST /api/v1/pre-billing/send-test-email
 * Send test pre-billing warning email
 */
router.post('/send-test-email', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { email, walletAddress, creatorId, issues } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'email is required'
      });
    }

    // Initialize email service
    const emailService = new PreBillingEmailService();

    const testData = {
      email,
      walletAddress: walletAddress || 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
      creatorId: creatorId || 'test-creator',
      nextBillingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      requiredAmount: 10000000, // 1 XLM
      issues: issues || [
        {
          type: 'insufficient_balance',
          message: 'Insufficient balance for payment',
          balance: 5000000,
          required: 10000000
        }
      ]
    };

    const result = await emailService.sendTestEmail(testData);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Send test email error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send test email'
    });
  }
});

/**
 * PUT /api/v1/pre-billing/next-billing-date
 * Update next billing date for a subscription
 */
router.put('/next-billing-date', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { creatorId, walletAddress, nextBillingDate, requiredAmount = 0 } = req.body;

    if (!creatorId || !walletAddress || !nextBillingDate) {
      return res.status(400).json({
        success: false,
        error: 'creatorId, walletAddress, and nextBillingDate are required'
      });
    }

    // Validate date format
    const date = new Date(nextBillingDate);
    if (isNaN(date.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid nextBillingDate format'
      });
    }

    // Validate Stellar public key format
    try {
      const { StellarSdk } = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(walletAddress);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar public key format'
      });
    }

    // Initialize health check service
    const healthCheck = new PreBillingHealthCheck({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    healthCheck.updateNextBillingDate(creatorId, walletAddress, date, requiredAmount);

    res.json({
      success: true,
      message: 'Next billing date updated successfully'
    });

  } catch (error) {
    console.error('Update next billing date error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update next billing date'
    });
  }
});

/**
 * GET /api/v1/pre-billing/wallet/:walletAddress/health
 * Get health status for a specific wallet
 */
router.get('/wallet/:walletAddress/health', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { walletAddress } = req.params;
    const { requiredAmount = 0 } = req.query;

    // Validate Stellar public key format
    try {
      const { StellarSdk } = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(walletAddress);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar public key format'
      });
    }

    // Initialize worker
    const worker = new PreBillingHealthWorker({
      database: req.app.get('database'),
      emailService: new PreBillingEmailService(),
      soroban: {
        rpcUrl: process.env.SOROBAN_RPC_URL,
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
        sourceSecret: process.env.SOROBAN_SOURCE_SECRET,
        contractId: process.env.SUBSTREAM_CONTRACT_ID
      }
    });

    const result = await worker.testWallet(walletAddress, parseFloat(requiredAmount));

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Get wallet health error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get wallet health'
    });
  }
});

module.exports = router;
