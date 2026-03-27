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

class LegalAgreementService {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
    this.contractId = config.soroban.contractId;
  }

  getContract() {
    return new Contract(this.contractId);
  }

  async storeAgreementHashes(vaultId, agreements, adminPublicKey, adminSignature) {
    this.assertConfigured();

    if (!Array.isArray(agreements) || agreements.length === 0) {
      const error = new Error('Agreements must be a non-empty array');
      error.statusCode = 400;
      throw error;
    }

    const hasPrimary = agreements.some(agg => agg.isPrimary === true);
    if (!hasPrimary) {
      const error = new Error('At least one agreement must be marked as primary');
      error.statusCode = 400;
      throw error;
    }

    const validLanguages = ['en', 'zh', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru', 'ar'];
    for (const agg of agreements) {
      if (!validLanguages.includes(agg.language)) {
        const error = new Error(`Invalid language code: ${agg.language}`);
        error.statusCode = 400;
        throw error;
      }
      
      if (!agg.hash || typeof agg.hash !== 'string') {
        const error = new Error(`Invalid hash format for language: ${agg.language}`);
        error.statusCode = 400;
        throw error;
      }
    }

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      const agreementsScVal = nativeToScVal(agreements.map(agg => ({
        language: agg.language,
        hash: agg.hash,
        is_primary: agg.isPrimary,
        timestamp: agg.timestamp || new Date().toISOString(),
      })), { 
        type: 'map', 
        keyType: 'symbol' 
      });

      const storeOp = contract.call(
        'store_agreement_hashes',
        Address.fromString(vaultId).toScVal(),
        agreementsScVal,
        nativeToScVal(adminPublicKey, { type: 'string' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(storeOp)
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
        vaultId,
        storedAgreements: agreements,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Failed to store agreement hashes:', error);
      throw new Error(`Failed to store agreements: ${error.message}`);
    }
  }

  async getAgreementHashes(vaultId) {
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
          contract.call('get_agreement_hashes', Address.fromString(vaultId).toScVal())
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeAgreements(result);
    } catch (error) {
      console.error('Error fetching agreement hashes:', error);
      throw new Error('Failed to fetch agreement hashes');
    }
  }

  async getPrimaryAgreementByLanguage(vaultId, language) {
    const agreements = await this.getAgreementHashes(vaultId);
    
    const primaryAgreement = agreements.find(
      agg => agg.language === language && agg.isPrimary === true
    );

    if (!primaryAgreement) {
      const error = new Error(`No primary agreement found for language: ${language}`);
      error.statusCode = 404;
      throw error;
    }

    return primaryAgreement;
  }

  async updatePrimaryAgreement(vaultId, language, newHash, adminPublicKey, adminSignature) {
    this.assertConfigured();

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      const updateOp = contract.call(
        'update_primary_agreement',
        Address.fromString(vaultId).toScVal(),
        nativeToScVal(language, { type: 'string' }),
        nativeToScVal(newHash, { type: 'string' }),
        nativeToScVal(adminPublicKey, { type: 'string' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(updateOp)
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
        vaultId,
        language,
        newHash,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Failed to update primary agreement:', error);
      throw new Error(`Failed to update primary agreement: ${error.message}`);
    }
  }

  async verifyAgreementHash(vaultId, language, providedHash) {
    try {
      const agreement = await this.getPrimaryAgreementByLanguage(vaultId, language);
      return agreement.hash === providedHash;
    } catch (error) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async getAgreementHistory(vaultId) {
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
          contract.call('get_agreement_history', Address.fromString(vaultId).toScVal())
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeHistory(result);
    } catch (error) {
      console.error('Error fetching agreement history:', error);
      throw new Error('Failed to fetch agreement history');
    }
  }

  normalizeAgreements(result) {
    if (!result || !Array.isArray(result)) {
      return [];
    }

    return result.map(item => {
      if (!item || typeof item !== 'object') {
        return {
          language: '',
          hash: '',
          isPrimary: false,
          timestamp: null,
          version: '1.0.0',
        };
      }

      return {
        language: String(item.language || ''),
        hash: String(item.hash || ''),
        isPrimary: Boolean(item.is_primary || item.isPrimary),
        timestamp: item.timestamp || null,
        version: String(item.version || '1.0.0'),
        storedAt: item.stored_at || item.storedAt || null,
      };
    });
  }

  normalizeHistory(result) {
    if (!result || typeof result !== 'object') {
      return {
        currentAgreements: [],
        historicalVersions: [],
        lastUpdated: null,
      };
    }

    return {
      currentAgreements: this.normalizeAgreements(result.current || result.current_agreements || []),
      historicalVersions: this.normalizeAgreements(result.history || result.historical_versions || []),
      lastUpdated: result.last_updated || result.lastUpdated || null,
    };
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
  LegalAgreementService,
};
