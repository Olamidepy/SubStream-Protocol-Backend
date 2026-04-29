const { loadConfig } = require('../src/config');
const StellarSdk = require('@stellar/stellar-sdk');
const EventEmitter = require('events');

class SandboxService extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.isSandboxMode = false;
    this.mockEvents = [];
    this.failureSimulationRules = new Map();
  }

  /**
   * Initialize sandbox service with configuration
   */
  async initialize() {
    this.config = await loadConfig();
    this.isSandboxMode = this.config.sandbox.enabled;
    
    if (this.isSandboxMode) {
      console.log('[Sandbox] Sandbox mode enabled:', this.config.sandbox.mode);
      this.setupFailureSimulation();
    }
  }

  /**
   * Get Stellar configuration based on environment (sandbox or production)
   */
  getStellarConfig() {
    if (!this.isSandboxMode) {
      return {
        networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Public Global Stellar Network ; September 2015",
        horizonUrl: process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org",
        rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-rpc.mainnet.stellar.gateway.fm"
      };
    }

    return {
      networkPassphrase: this.config.sandbox.stellar.networkPassphrase,
      horizonUrl: this.config.sandbox.stellar.horizonUrl,
      rpcUrl: this.config.sandbox.soroban.rpcUrl
    };
  }

  /**
   * Get Soroban configuration based on environment
   */
  getSorobanConfig() {
    if (!this.isSandboxMode) {
      return {
        rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-rpc.mainnet.stellar.gateway.fm",
        networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || "Public Network",
        contractId: process.env.SOROBAN_CONTRACT_ID || "CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L"
      };
    }

    return {
      rpcUrl: this.config.sandbox.soroban.rpcUrl,
      networkPassphrase: this.config.sandbox.stellar.networkPassphrase,
      contractId: this.config.sandbox.soroban.contractId
    };
  }

  /**
   * Get database schema prefix based on environment
   */
  getDatabaseSchema() {
    if (!this.isSandboxMode) {
      return '';
    }
    return this.config.sandbox.dbSchemaPrefix;
  }

  /**
   * Create a mock payment event for testing
   */
  async createMockPayment(paymentData) {
    if (!this.isSandboxMode || !this.config.sandbox.mockPayments.enabled) {
      throw new Error('Mock payments are not enabled');
    }

    const mockEvent = {
      id: `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'SubscriptionBilled',
      timestamp: new Date().toISOString(),
      data: {
        ...paymentData,
        amount: this.config.sandbox.zeroValueTokens.enabled ? 0 : paymentData.amount,
        isMock: true,
        sandboxMode: this.config.sandbox.mode
      },
      source: 'sandbox_mock'
    };

    this.mockEvents.push(mockEvent);
    
    // Emit event for internal indexer
    this.emit('mockEvent', mockEvent);
    
    console.log('[Sandbox] Mock payment created:', mockEvent.id);
    return mockEvent;
  }

  /**
   * Simulate payment failures for testing
   */
  async simulatePaymentFailure(subscriptionId, failureType = 'insufficient_funds') {
    if (!this.isSandboxMode || !this.config.sandbox.failureSimulation.enabled) {
      throw new Error('Failure simulation is not enabled');
    }

    const failureEvent = {
      id: `failure_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'PaymentFailed',
      timestamp: new Date().toISOString(),
      data: {
        subscriptionId,
        failureType,
        isMock: true,
        sandboxMode: this.config.sandbox.mode,
        retryCount: 0,
        maxRetries: 3
      },
      source: 'sandbox_failure_simulation'
    };

    this.mockEvents.push(failureEvent);
    this.emit('mockEvent', failureEvent);
    
    console.log('[Sandbox] Payment failure simulated:', failureEvent.id);
    return failureEvent;
  }

  /**
   * Setup failure simulation rules
   */
  setupFailureSimulation() {
    // Default failure simulation rules
    this.failureSimulationRules.set('random_failure', {
      enabled: true,
      probability: 0.1, // 10% chance of failure
      types: ['insufficient_funds', 'network_error', 'timeout']
    });

    this.failureSimulationRules.set('grace_period', {
      enabled: true,
      duration: 3 * 24 * 60 * 60 * 1000, // 3 days
      warnings: [24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000] // 24h and 12h before
    });
  }

  /**
   * Check if a request should fail based on simulation rules
   */
  shouldSimulateFailure(operation) {
    if (!this.isSandboxMode || !this.config.sandbox.failureSimulation.enabled) {
      return false;
    }

    const rule = this.failureSimulationRules.get('random_failure');
    if (!rule || !rule.enabled) {
      return false;
    }

    const random = Math.random();
    if (random < rule.probability) {
      const failureType = rule.types[Math.floor(Math.random() * rule.types.length)];
      return {
        shouldFail: true,
        failureType,
        reason: `Sandbox simulation: ${failureType}`
      };
    }

    return { shouldFail: false };
  }

  /**
   * Get sandbox status and configuration
   */
  getStatus() {
    return {
      enabled: this.isSandboxMode,
      mode: this.isSandboxMode ? this.config.sandbox.mode : 'production',
      stellarConfig: this.getStellarConfig(),
      sorobanConfig: this.getSorobanConfig(),
      features: {
        mockPayments: this.isSandboxMode ? this.config.sandbox.mockPayments.enabled : false,
        failureSimulation: this.isSandboxMode ? this.config.sandbox.failureSimulation.enabled : false,
        zeroValueTokens: this.isSandboxMode ? this.config.sandbox.zeroValueTokens.enabled : false
      },
      mockEventsCount: this.mockEvents.length,
      failureRules: Array.from(this.failureSimulationRules.entries()).map(([key, rule]) => ({
        name: key,
        ...rule
      }))
    };
  }

  /**
   * Get mock events history
   */
  getMockEvents(limit = 50, offset = 0) {
    return {
      events: this.mockEvents.slice(offset, offset + limit),
      total: this.mockEvents.length,
      hasMore: offset + limit < this.mockEvents.length
    };
  }

  /**
   * Clear mock events
   */
  clearMockEvents() {
    this.mockEvents = [];
    console.log('[Sandbox] Mock events cleared');
  }

  /**
   * Create testnet funding account for developers
   */
  async createTestnetFundingAccount() {
    if (!this.isSandboxMode) {
      throw new Error('Testnet funding is only available in sandbox mode');
    }

    const keypair = StellarSdk.Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    const stellarConfig = this.getStellarConfig();
    const server = new StellarSdk.Horizon.Server(stellarConfig.horizonUrl);

    // In testnet, we can use the friendbot to fund the account
    if (stellarConfig.horizonUrl.includes('testnet')) {
      try {
        await server.friendbot(publicKey);
        console.log('[Sandbox] Testnet account funded via friendbot:', publicKey);
      } catch (error) {
        console.log('[Sandbox] Friendbot funding failed, account may need manual funding:', error.message);
      }
    }

    return {
      publicKey,
      secretKey, // Only return in sandbox mode for testing
      network: stellarConfig.networkPassphrase,
      horizonUrl: stellarConfig.horizonUrl
    };
  }

  /**
   * Validate if an operation is allowed in current mode
   */
  validateOperation(operation, amount = 0) {
    if (!this.isSandboxMode) {
      return { allowed: true };
    }

    // In sandbox mode with zero-value tokens, reject non-zero amounts
    if (this.config.sandbox.zeroValueTokens.enabled && amount > 0) {
      return {
        allowed: false,
        reason: 'Zero-value tokens enabled in sandbox mode'
      };
    }

    return { allowed: true };
  }
}

module.exports = SandboxService;
