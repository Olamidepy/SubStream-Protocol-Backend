const {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  StrKey,
} = require('@stellar/stellar-sdk');

/**
 * Service for managing Soroban vesting vault contracts with proxy pattern support.
 * Enables contract logic upgrades while preserving immutable terms (total allocations).
 */
class SorobanVaultManager {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
    this.contractId = config.soroban.contractId;
  }

  /**
   * Get the current contract instance
   * @returns {Contract}
   */
  getContract() {
    return new Contract(this.contractId);
  }

  /**
   * Retrieve the current code hash that the proxy points to
   * @returns {Promise<string>} The current Wasm code hash
   */
  async getCurrentCodeHash() {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    
    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(contract.call('get_code_hash'))
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeCodeHash(result);
    } catch (error) {
      console.error('Error getting code hash:', error);
      throw new Error('Failed to retrieve current code hash');
    }
  }

  /**
   * Update the contract to point to a new Wasm code hash
   * Only allowed if immutable terms (total allocations) remain unchanged
   * 
   * @param {string} newCodeHash - The new Wasm code hash to upgrade to
   * @param {string} adminPublicKey - Admin public key for authorization
   * @param {string} adminSignature - Admin's signature authorizing the upgrade
   * @returns {Promise<object>} Transaction result with upgrade details
   */
  async upgradeContractLogic(newCodeHash, adminPublicKey, adminSignature) {
    this.assertConfigured();
    
    // Verify that immutable terms are preserved
    const currentTerms = await this.getImmutableTerms();
    const newTerms = await this.validateNewCodeCompatibility(newCodeHash);
    
    if (!this.areTermsCompatible(currentTerms, newTerms)) {
      const error = new Error('Immutable terms mismatch - cannot upgrade contract');
      error.statusCode = 400;
      throw error;
    }

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      // Build the upgrade operation with admin verification
      const upgradeOp = contract.call(
        'upgrade_contract',
        Address.fromString(adminPublicKey).toScVal(),
        nativeToScVal(newCodeHash, { type: 'bytes' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(upgradeOp)
        .setTimeout(30)
        .build();

      // Sign and submit the transaction
      tx.sign(sourceKeypair);
      const sentTx = await this.server.sendTransaction(tx);

      if (sentTx.status !== 'PENDING') {
        throw new Error('Transaction not accepted');
      }

      // Wait for transaction completion
      const txResponse = await this.pollTransaction(sentTx.hash);
      
      return {
        success: true,
        transactionHash: sentTx.hash,
        oldCodeHash: currentTerms.codeHash,
        newCodeHash: newCodeHash,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Contract upgrade failed:', error);
      throw new Error(`Failed to upgrade contract: ${error.message}`);
    }
  }

  /**
   * Get the immutable terms from the current contract
   * @returns {Promise<object>} Immutable terms including total allocations
   */
  async getImmutableTerms() {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(contract.call('get_immutable_terms'))
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeImmutableTerms(result);
    } catch (error) {
      console.error('Error getting immutable terms:', error);
      throw new Error('Failed to retrieve immutable terms');
    }
  }

  /**
   * Validate that a new code hash is compatible with current immutable terms
   * @param {string} newCodeHash - The new code hash to validate
   * @returns {Promise<object>} Terms from the new code
   */
  async validateNewCodeCompatibility(newCodeHash) {
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(
          contract.call('validate_code_compatibility', nativeToScVal(newCodeHash, { type: 'bytes' }))
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Compatibility check failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return result;
    } catch (error) {
      console.error('Compatibility validation failed:', error);
      throw new Error('Failed to validate code compatibility');
    }
  }

  /**
   * Check if two sets of terms are compatible
   * @param {object} currentTerms - Current contract terms
   * @param {object} newTerms - New contract terms
   * @returns {boolean} True if compatible
   */
  areTermsCompatible(currentTerms, newTerms) {
    if (!currentTerms || !newTerms) {
      return false;
    }

    // Compare total allocations (immutable)
    const currentTotal = this.calculateTotalAllocation(currentTerms.allocations);
    const newTotal = this.calculateTotalAllocation(newTerms.allocations);

    return currentTotal === newTotal;
  }

  /**
   * Calculate total allocation from allocations object
   * @param {Array<object>} allocations - Array of allocation objects
   * @returns {number} Total allocation amount
   */
  calculateTotalAllocation(allocations) {
    if (!allocations || !Array.isArray(allocations)) {
      return 0;
    }
    return allocations.reduce((sum, alloc) => sum + (Number(alloc.amount) || 0), 0);
  }

  /**
   * Normalize code hash result from contract call
   * @param {any} result - Raw contract result
   * @returns {string} Normalized code hash
   */
  normalizeCodeHash(result) {
    if (typeof result === 'string') {
      return result;
    }
    if (result && typeof result.toString === 'function') {
      return result.toString('hex');
    }
    return JSON.stringify(result);
  }

  /**
   * Normalize immutable terms from contract call
   * @param {any} result - Raw contract result
   * @returns {object} Normalized terms
   */
  normalizeImmutableTerms(result) {
    if (!result || typeof result !== 'object') {
      return { allocations: [], codeHash: '', totalSupply: 0 };
    }

    return {
      allocations: result.allocations || [],
      codeHash: this.normalizeCodeHash(result.code_hash || result.codeHash),
      totalSupply: Number(result.total_supply || result.totalSupply || 0),
      version: result.version || '1.0.0',
    };
  }

  /**
   * Poll for transaction completion
   * @param {string} txHash - Transaction hash
   * @returns {Promise<object>} Transaction result
   */
  async pollTransaction(txHash) {
    const maxAttempts = 10;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await this.server.getTransaction(txHash);
        
        if (response.status === 'SUCCESS') {
          return response;
        }
        
        if (response.status === 'FAILED') {
          throw new Error('Transaction failed');
        }
      } catch (error) {
        if (i === maxAttempts - 1) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    throw new Error('Transaction polling timeout');
  }

  /**
   * Assert that the service is properly configured
   */
  assertConfigured() {
    if (!this.server) {
      const error = new Error('SOROBAN_RPC_URL is required');
      error.statusCode = 503;
      throw error;
    }

    if (!this.config.soroban.sourceSecret) {
      const error = new Error('SOROBAN_SOURCE_SECRET is required');
      error.statusCode = 503;
      throw error;
    }

    if (!this.contractId) {
      const error = new Error('Contract ID is required');
      error.statusCode = 503;
      throw error;
    }
  }
}

module.exports = {
  SorobanVaultManager,
};
