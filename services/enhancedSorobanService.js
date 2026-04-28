const {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} = require('@stellar/stellar-sdk');
const SorobanCircuitBreaker = require('./sorobanCircuitBreaker');
const { logger } = require('../src/utils/logger');

class EnhancedSorobanService {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
    this.circuitBreaker = new SorobanCircuitBreaker({
      failureThreshold: config.soroban.failureThreshold || 5,
      resetTimeout: config.soroban.resetTimeout || 60000,
      maxRetries: config.soroban.maxRetries || 3,
      baseDelay: config.soroban.baseDelay || 1000,
      maxDelay: config.soroban.maxDelay || 30000,
      requestsPerSecond: config.soroban.requestsPerSecond || 10
    });
    
    // Listen for circuit breaker events
    this.circuitBreaker.on('stateChange', (newState) => {
      this.handleCircuitStateChange(newState);
    });
    
    logger.info('Enhanced Soroban Service initialized with circuit breaker');
  }
  
  handleCircuitStateChange(newState) {
    // Emit events for monitoring and alerting
    if (newState === 'OPEN') {
      logger.error('Soroban RPC circuit breaker OPENED - Service unavailable');
      // Could trigger webhook, email, or other alerting here
    } else if (newState === 'CLOSED') {
      logger.info('Soroban RPC circuit breaker CLOSED - Service restored');
    }
  }
  
  async verifySubscription(accessRequest) {
    this.assertConfigured();
    
    const operation = async () => {
      const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const contract = new Contract(this.config.soroban.contractId);
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(
          contract.call(
            this.config.soroban.method,
            ...this.buildArguments(accessRequest),
          ),
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        const error = new Error(
          `Soroban simulation failed: ${simulation.error || 'unknown simulation error'}`,
        );
        error.statusCode = 502;
        throw error;
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      const normalized = normalizeSubscriptionResult(result);

      return {
        active: normalized.active,
        status: normalized.status,
        raw: result,
      };
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'verifySubscription' });
  }
  
  async getAccount(accountId) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getAccount(accountId);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getAccount' });
  }
  
  async simulateTransaction(transaction) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.simulateTransaction(transaction);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'simulateTransaction' });
  }
  
  async sendTransaction(transaction) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.sendTransaction(transaction);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'sendTransaction' });
  }
  
  async getLatestLedger() {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getLatestLedger();
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getLatestLedger' });
  }
  
  async getLedgerSequence(ledger) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getLedgerSequence(ledger);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getLedgerSequence' });
  }
  
  async getTransaction(txHash) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getTransaction(txHash);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getTransaction' });
  }
  
  async getEvents(request) {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getEvents(request);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getEvents' });
  }
  
  async getContractData(contractId, key, durability = 'persistent') {
    this.assertConfigured();
    
    const operation = async () => {
      return await this.server.getContractData(contractId, key, durability);
    };
    
    return await this.circuitBreaker.execute(operation, { method: 'getContractData' });
  }
  
  // Health check for the service
  async healthCheck() {
    const circuitState = this.circuitBreaker.getState();
    
    let rpcHealth = 'unknown';
    let ledgerLag = null;
    
    try {
      if (this.server && this.circuitBreaker.isHealthy()) {
        const latestLedger = await this.getLatestLedger();
        // Calculate ledger lag (simplified - in production, compare with network time)
        ledgerLag = 0; // Would calculate actual lag
        rpcHealth = 'healthy';
      } else if (this.circuitBreaker.isDegraded()) {
        rpcHealth = 'degraded';
      } else {
        rpcHealth = 'unhealthy';
      }
    } catch (error) {
      rpcHealth = 'error';
      logger.error('Soroban health check failed:', error);
    }
    
    return {
      rpc_health: rpcHealth,
      circuit_breaker_state: circuitState.state,
      circuit_breaker_healthy: this.circuitBreaker.isHealthy(),
      circuit_breaker_degraded: this.circuitBreaker.isDegraded(),
      failure_count: circuitState.failureCount,
      failure_threshold: circuitState.failureThreshold,
      current_rate: circuitState.currentRate,
      max_rate: circuitState.maxRate,
      ledger_lag: ledgerLag,
      last_failure_time: circuitState.lastFailureTime,
      circuit_opened_time: circuitState.circuitOpenedTime
    };
  }
  
  // Get circuit breaker status
  getCircuitBreakerStatus() {
    return this.circuitBreaker.getState();
  }
  
  // Manual circuit breaker control
  forceCircuitOpen() {
    this.circuitBreaker.forceOpen();
  }
  
  forceCircuitClose() {
    this.circuitBreaker.forceClose();
  }
  
  resetCircuitBreaker() {
    this.circuitBreaker.reset();
  }
  
  // Update circuit breaker configuration
  updateCircuitBreakerConfig(config) {
    this.circuitBreaker.updateConfig(config);
  }
  
  buildArguments(accessRequest) {
    return this.config.soroban.argumentMapping
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [type, field] = entry.split(':');
        const value = accessRequest[field];

        if (value === undefined || value === null || value === '') {
          throw new Error(`Missing Soroban argument value for ${field}`);
        }

        switch (type) {
          case 'address':
            return Address.fromString(value).toScVal();
          case 'symbol':
            return nativeToScVal(value, { type: 'symbol' });
          case 'string':
            return nativeToScVal(String(value));
          case 'bool':
            return nativeToScVal(value === true || value === 'true');
          case 'u32':
          case 'u64':
          case 'i128':
            return nativeToScVal(Number(value), { type });
          default:
            throw new Error(`Unsupported Soroban argument type: ${type}`);
        }
      });
  }
  
  assertConfigured() {
    if (!this.server) {
      const error = new Error('SOROBAN_RPC_URL is required for subscription verification');
      error.statusCode = 503;
      throw error;
    }

    if (!this.config.soroban.sourceSecret) {
      const error = new Error('SOROBAN_SOURCE_SECRET is required for subscription verification');
      error.statusCode = 503;
      throw error;
    }
  }
}

function normalizeSubscriptionResult(result) {
  if (!result) {
    return { active: false, status: 'invalid' };
  }

  // Handle different result formats
  if (typeof result === 'boolean') {
    return { active: result, status: result ? 'active' : 'inactive' };
  }

  if (typeof result === 'object') {
    return {
      active: Boolean(result.active || result.has_active_subscription),
      status: result.status || (result.active ? 'active' : 'inactive'),
      expires_at: result.expires_at || result.expiry,
      tier: result.tier || 'unknown'
    };
  }

  return { active: Boolean(result), status: result ? 'active' : 'inactive' };
}

module.exports = EnhancedSorobanService;
