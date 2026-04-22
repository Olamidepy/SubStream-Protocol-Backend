const { rpc, Server, Keypair } = require('@stellar/stellar-sdk');

/**
 * Soroban Balance Checker Service
 * Queries Soroban RPC to check wallet balances and authorization allowances
 */
class SorobanBalanceChecker {
  constructor(config = {}) {
    this.rpcUrl = config.rpcUrl || process.env.SOROBAN_RPC_URL;
    this.networkPassphrase = config.networkPassphrase || process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
    this.sourceSecret = config.sourceSecret || process.env.SOROBAN_SOURCE_SECRET;
    this.contractId = config.contractId || process.env.SUBSTREAM_CONTRACT_ID;
    
    this.server = null;
    this.rateLimiter = new Map(); // Simple in-memory rate limiter
    this.requestCache = new Map(); // Cache for RPC responses
    this.cacheTimeout = 30000; // 30 seconds cache
    
    this.initializeServer();
  }

  /**
   * Initialize Soroban RPC server connection
   */
  initializeServer() {
    if (!this.rpcUrl) {
      throw new Error('SOROBAN_RPC_URL environment variable is required');
    }
    
    try {
      this.server = new Server(this.rpcUrl);
      console.log(`Soroban RPC server initialized: ${this.rpcUrl}`);
    } catch (error) {
      console.error('Failed to initialize Soroban RPC server:', error);
      throw error;
    }
  }

  /**
   * Check if a wallet has sufficient balance for upcoming payment
   * @param {string} walletAddress - Stellar public key
   * @param {string} contractId - SubStream contract ID
   * @param {number} requiredAmount - Required amount for payment
   * @returns {Promise<Object>} Balance check result
   */
  async checkWalletBalance(walletAddress, contractId = this.contractId, requiredAmount = 0) {
    try {
      // Rate limiting check
      if (this.isRateLimited(walletAddress)) {
        throw new Error('Rate limit exceeded for wallet balance check');
      }

      // Check cache first
      const cacheKey = `balance_${walletAddress}_${contractId}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      // Get account information
      const account = await this.server.getAccount(walletAddress);
      
      // Get token balance (assuming native XLM for now, can be extended for other tokens)
      const balance = this.extractBalance(account);
      
      // Check if balance is sufficient
      const isSufficient = balance >= requiredAmount;
      
      const result = {
        walletAddress,
        balance,
        requiredAmount,
        isSufficient,
        timestamp: new Date().toISOString(),
        contractId
      };

      // Cache the result
      this.setCache(cacheKey, result);
      
      return result;
    } catch (error) {
      console.error(`Failed to check balance for wallet ${walletAddress}:`, error);
      
      // Return a safe default for failed checks
      return {
        walletAddress,
        balance: 0,
        requiredAmount,
        isSufficient: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        contractId
      };
    }
  }

  /**
   * Check if authorization allowance exists for the contract
   * @param {string} walletAddress - Stellar public key
   * @param {string} contractId - SubStream contract ID
   * @returns {Promise<Object>} Authorization check result
   */
  async checkAuthorizationAllowance(walletAddress, contractId = this.contractId) {
    try {
      // Rate limiting check
      if (this.isRateLimited(walletAddress)) {
        throw new Error('Rate limit exceeded for authorization check');
      }

      // Check cache first
      const cacheKey = `auth_${walletAddress}_${contractId}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      if (!this.sourceSecret) {
        throw new Error('SOROBAN_SOURCE_SECRET is required for authorization checks');
      }

      const sourceKeypair = Keypair.fromSecret(this.sourceSecret);
      
      // Simulate a contract call to check authorization
      // This would typically involve calling a view function on the contract
      const simulationResult = await this.simulateContractCall(
        sourceKeypair,
        contractId,
        'check_authorization',
        [walletAddress]
      );

      const hasAuthorization = this.parseAuthorizationResult(simulationResult);
      
      const result = {
        walletAddress,
        contractId,
        hasAuthorization,
        timestamp: new Date().toISOString(),
        simulationResult
      };

      // Cache the result
      this.setCache(cacheKey, result);
      
      return result;
    } catch (error) {
      console.error(`Failed to check authorization for wallet ${walletAddress}:`, error);
      
      // Return a safe default for failed checks
      return {
        walletAddress,
        contractId,
        hasAuthorization: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Perform comprehensive pre-billing health check
   * @param {string} walletAddress - Stellar public key
   * @param {string} contractId - SubStream contract ID
   * @param {number} requiredAmount - Required amount for payment
   * @returns {Promise<Object>} Comprehensive health check result
   */
  async performHealthCheck(walletAddress, contractId = this.contractId, requiredAmount = 0) {
    try {
      const [balanceCheck, authCheck] = await Promise.all([
        this.checkWalletBalance(walletAddress, contractId, requiredAmount),
        this.checkAuthorizationAllowance(walletAddress, contractId)
      ]);

      const isHealthy = balanceCheck.isSufficient && authCheck.hasAuthorization;
      const issues = [];
      
      if (!balanceCheck.isSufficient) {
        issues.push({
          type: 'insufficient_balance',
          message: `Insufficient balance: ${balanceCheck.balance} < ${requiredAmount}`,
          balance: balanceCheck.balance,
          required: requiredAmount
        });
      }
      
      if (!authCheck.hasAuthorization) {
        issues.push({
          type: 'missing_authorization',
          message: 'Authorization allowance has been revoked or not granted',
          hasAuthorization: authCheck.hasAuthorization
        });
      }

      return {
        walletAddress,
        contractId,
        isHealthy,
        issues,
        balanceCheck,
        authCheck,
        timestamp: new Date().toISOString(),
        requiredAmount
      };
    } catch (error) {
      console.error(`Health check failed for wallet ${walletAddress}:`, error);
      
      return {
        walletAddress,
        contractId,
        isHealthy: false,
        issues: [{
          type: 'check_failed',
          message: error.message
        }],
        error: error.message,
        timestamp: new Date().toISOString(),
        requiredAmount
      };
    }
  }

  /**
   * Extract balance from Stellar account
   * @param {Object} account - Stellar account object
   * @returns {number} Balance in stroops
   */
  extractBalance(account) {
    if (!account || !account.balances) {
      return 0;
    }

    // Find native XLM balance
    const nativeBalance = account.balances.find(b => b.asset_type === 'native');
    if (nativeBalance) {
      return parseFloat(nativeBalance.balance) * 10000000; // Convert from XLM to stroops
    }

    return 0;
  }

  /**
   * Simulate a contract call
   * @param {Keypair} sourceKeypair - Source keypair for simulation
   * @param {string} contractId - Contract ID
   * @param {string} method - Contract method name
   * @param {Array} args - Method arguments
   * @returns {Promise<Object>} Simulation result
   */
  async simulateContractCall(sourceKeypair, contractId, method, args) {
    try {
      const account = await this.server.getAccount(sourceKeypair.publicKey());
      
      // Build contract call transaction
      const contract = new rpc.Contract(contractId);
      const contractCall = contract.call(method, ...args);
      
      const transaction = new rpc.TransactionBuilder(account, {
        fee: 100,
        networkPassphrase: this.networkPassphrase
      })
        .addOperation(contractCall)
        .setTimeout(30)
        .build();

      // Simulate the transaction
      const simulation = await this.server.simulateTransaction(transaction);
      
      return simulation;
    } catch (error) {
      console.error(`Contract simulation failed for ${method}:`, error);
      throw error;
    }
  }

  /**
   * Parse authorization result from simulation
   * @param {Object} simulationResult - Simulation result
   * @returns {boolean} Whether authorization exists
   */
  parseAuthorizationResult(simulationResult) {
    try {
      if (!simulationResult || !simulationResult.result) {
        return false;
      }

      // Parse the result based on contract response format
      // This would need to be adapted based on actual contract implementation
      const result = simulationResult.result.retval;
      
      if (typeof result === 'boolean') {
        return result;
      }
      
      if (typeof result === 'object' && result.value !== undefined) {
        return Boolean(result.value);
      }
      
      // Default to false if we can't parse the result
      return false;
    } catch (error) {
      console.error('Failed to parse authorization result:', error);
      return false;
    }
  }

  /**
   * Check if a wallet is rate limited
   * @param {string} walletAddress - Wallet address to check
   * @returns {boolean} Whether rate limited
   */
  isRateLimited(walletAddress) {
    const now = Date.now();
    const lastRequest = this.rateLimiter.get(walletAddress);
    
    if (!lastRequest) {
      this.rateLimiter.set(walletAddress, now);
      return false;
    }
    
    // Allow 1 request per minute per wallet
    const timeSinceLastRequest = now - lastRequest;
    if (timeSinceLastRequest < 60000) {
      return true;
    }
    
    this.rateLimiter.set(walletAddress, now);
    return false;
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Object|null} Cached value or null
   */
  getFromCache(key) {
    const cached = this.requestCache.get(key);
    if (!cached) {
      return null;
    }
    
    const now = Date.now();
    if (now - cached.timestamp > this.cacheTimeout) {
      this.requestCache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {Object} data - Data to cache
   */
  setCache(key, data) {
    this.requestCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Clear expired cache entries
   */
  clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.requestCache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.requestCache.delete(key);
      }
    }
  }

  /**
   * Get service statistics
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      rpcUrl: this.rpcUrl,
      contractId: this.contractId,
      cacheSize: this.requestCache.size,
      rateLimiterSize: this.rateLimiter.size,
      cacheTimeout: this.cacheTimeout
    };
  }

  /**
   * Batch health check for multiple wallets
   * @param {Array<string>} walletAddresses - Array of wallet addresses
   * @param {string} contractId - Contract ID
   * @param {number} requiredAmount - Required amount for payment
   * @returns {Promise<Array>} Array of health check results
   */
  async batchHealthCheck(walletAddresses, contractId = this.contractId, requiredAmount = 0) {
    const results = [];
    const batchSize = 10; // Process in batches to avoid overwhelming RPC
    
    for (let i = 0; i < walletAddresses.length; i += batchSize) {
      const batch = walletAddresses.slice(i, i + batchSize);
      const batchPromises = batch.map(wallet => 
        this.performHealthCheck(wallet, contractId, requiredAmount)
      );
      
      try {
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      } catch (error) {
        console.error(`Batch health check failed for batch ${i}-${i + batchSize}:`, error);
        
        // Add failed results for this batch
        batch.forEach(wallet => {
          results.push({
            walletAddress: wallet,
            contractId,
            isHealthy: false,
            issues: [{
              type: 'batch_failed',
              message: error.message
            }],
            error: error.message,
            timestamp: new Date().toISOString(),
            requiredAmount
          });
        });
      }
      
      // Add delay between batches to respect rate limits
      if (i + batchSize < walletAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return results;
  }
}

module.exports = SorobanBalanceChecker;
