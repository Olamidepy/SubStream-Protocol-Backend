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

class VaultRegistryService {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
    this.contractId = config.soroban.contractId;
  }

  getContract() {
    return new Contract(this.contractId);
  }

  async registerVault(creatorAddress, vaultContractId, adminPublicKey, adminSignature) {
    this.assertConfigured();

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      const registerOp = contract.call(
        'register_vault',
        Address.fromString(creatorAddress).toScVal(),
        Address.fromString(vaultContractId).toScVal(),
        nativeToScVal(adminPublicKey, { type: 'string' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(registerOp)
        .setTimeout(30)
        .build();

      tx.sign(sourceKeypair);
      const sentTx = await this.server.sendTransaction(tx);

      if (sentTx.status !== 'PENDING') {
        throw new Error('Transaction not accepted');
      }

      await this.pollTransaction(sentTx.hash);
      
      return {
        success: true,
        transactionHash: sentTx.hash,
        creatorAddress,
        vaultContractId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Vault registration failed:', error);
      throw new Error(`Failed to register vault: ${error.message}`);
    }
  }

  async listVaultsByCreator(creatorAddress) {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(
          contract.call('list_vaults_by_creator', Address.fromString(creatorAddress).toScVal())
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeVaultList(result);
    } catch (error) {
      console.error('Error listing vaults:', error);
      throw new Error('Failed to list vaults');
    }
  }

  async getAllVaults() {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(contract.call('get_all_vaults'))
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeAllVaults(result);
    } catch (error) {
      console.error('Error fetching all vaults:', error);
      throw new Error('Failed to fetch all vaults');
    }
  }

  async unregisterVault(creatorAddress, vaultContractId, adminPublicKey, adminSignature) {
    this.assertConfigured();

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      const unregisterOp = contract.call(
        'unregister_vault',
        Address.fromString(creatorAddress).toScVal(),
        Address.fromString(vaultContractId).toScVal(),
        nativeToScVal(adminPublicKey, { type: 'string' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(unregisterOp)
        .setTimeout(30)
        .build();

      tx.sign(sourceKeypair);
      const sentTx = await this.server.sendTransaction(tx);

      if (sentTx.status !== 'PENDING') {
        throw new Error('Transaction not accepted');
      }

      await this.pollTransaction(sentTx.hash);
      
      return {
        success: true,
        transactionHash: sentTx.hash,
        creatorAddress,
        vaultContractId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Vault unregistration failed:', error);
      throw new Error(`Failed to unregister vault: ${error.message}`);
    }
  }

  async isVaultRegistered(vaultContractId) {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(
          contract.call('is_vault_registered', Address.fromString(vaultContractId).toScVal())
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return Boolean(result);
    } catch (error) {
      console.error('Error checking vault registration:', error);
      throw new Error('Failed to check vault registration');
    }
  }

  normalizeVaultList(result) {
    if (!result || !Array.isArray(result)) {
      return [];
    }
    
    return result.map(item => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item.toString === 'function') {
        return item.toString();
      }
      return String(item);
    });
  }

  normalizeAllVaults(result) {
    if (!result || typeof result !== 'object') {
      return {};
    }

    const normalized = {};
    
    for (const [key, value] of Object.entries(result)) {
      normalized[key] = this.normalizeVaultList(value);
    }

    return normalized;
  }

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
  VaultRegistryService,
};
