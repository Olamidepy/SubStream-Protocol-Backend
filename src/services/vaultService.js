/**
 * HashiCorp Vault Service
 * 
 * This service handles authentication to Vault using Kubernetes service account tokens
 * and retrieves secrets dynamically. Secrets are cached in memory and can be
 * hot-reloaded via SIGHUP signal.
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class VaultService {
  constructor(options = {}) {
    this.vaultAddr = options.vaultAddr || process.env.VAULT_ADDR || 'http://vault:8200';
    this.vaultRole = options.vaultRole || process.env.VAULT_ROLE || 'substream-backend';
    this.authPath = options.authPath || process.env.VAULT_AUTH_PATH || 'auth/kubernetes';
    this.secretPath = options.secretPath || process.env.VAULT_SECRET_PATH || 'secret/data/substream';
    this.dbPath = options.dbPath || process.env.VAULT_DB_PATH || 'database/creds/substream-role';
    this.kubernetesTokenPath = options.kubernetesTokenPath || 
      process.env.KUBERNETES_TOKEN_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/token';
    
    this.token = null;
    this.tokenLeaseDuration = 0;
    this.tokenExpiry = null;
    this.secretsCache = {};
    this.dbCredentialsCache = null;
    this.dbCredentialsExpiry = null;
    this.initialized = false;
    this.initializationPromise = null;
  }

  /**
   * Initialize Vault authentication
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._performInitialization();
    await this.initializationPromise;
  }

  async _performInitialization() {
    try {
      // Authenticate with Vault using Kubernetes service account token
      await this._authenticate();
      
      // Load initial secrets
      await this.loadSecrets();
      
      // Load initial database credentials
      await this.loadDatabaseCredentials();
      
      this.initialized = true;
      console.log('[VaultService] Successfully initialized');
    } catch (error) {
      console.error('[VaultService] Initialization failed:', error.message);
      throw new Error(`Vault initialization failed: ${error.message}`);
    }
  }

  /**
   * Authenticate with Vault using Kubernetes service account
   */
  async _authenticate() {
    try {
      // Read Kubernetes service account token
      const token = await fs.readFile(this.kubernetesTokenPath, 'utf-8');
      
      // Authenticate with Vault
      const response = await axios.post(
        `${this.vaultAddr}/v1/${this.authPath}/login`,
        {
          role: this.vaultRole,
          jwt: token.trim()
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (!response.data.auth) {
        throw new Error('No auth data in Vault response');
      }

      this.token = response.data.auth.client_token;
      this.tokenLeaseDuration = response.data.auth.lease_duration || 3600;
      this.tokenExpiry = Date.now() + (this.tokenLeaseDuration * 1000) - (60 * 1000); // Refresh 1 minute before expiry

      console.log('[VaultService] Successfully authenticated with Vault');
    } catch (error) {
      if (error.response) {
        throw new Error(`Vault authentication failed: ${error.response.status} ${error.response.data?.errors?.[0] || error.response.statusText}`);
      }
      throw new Error(`Vault authentication failed: ${error.message}`);
    }
  }

  /**
   * Ensure token is valid, refresh if needed
   */
  async _ensureAuthenticated() {
    if (!this.token || Date.now() >= this.tokenExpiry) {
      await this._authenticate();
    }
  }

  /**
   * Load all secrets from Vault
   */
  async loadSecrets() {
    await this._ensureAuthenticated();

    try {
      const response = await axios.get(
        `${this.vaultAddr}/v1/${this.secretPath}`,
        {
          headers: {
            'X-Vault-Token': this.token,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (!response.data.data) {
        throw new Error('No data in Vault response');
      }

      this.secretsCache = response.data.data.data || {};
      console.log('[VaultService] Successfully loaded secrets from Vault');
      return this.secretsCache;
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to load secrets: ${error.response.status} ${error.response.data?.errors?.[0] || error.response.statusText}`);
      }
      throw new Error(`Failed to load secrets: ${error.message}`);
    }
  }

  /**
   * Load dynamic database credentials from Vault
   */
  async loadDatabaseCredentials() {
    await this._ensureAuthenticated();

    try {
      const response = await axios.get(
        `${this.vaultAddr}/v1/${this.dbPath}`,
        {
          headers: {
            'X-Vault-Token': this.token,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      if (!response.data.data) {
        throw new Error('No data in Vault response');
      }

      this.dbCredentialsCache = {
        username: response.data.data.username,
        password: response.data.data.password,
        leaseId: response.data.lease_id,
        leaseDuration: response.data.lease_duration
      };

      // Set expiry to 1 hour before actual expiry for safety
      this.dbCredentialsExpiry = Date.now() + (this.dbCredentialsCache.leaseDuration * 1000) - (3600 * 1000);

      console.log('[VaultService] Successfully loaded dynamic database credentials');
      return this.dbCredentialsCache;
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to load database credentials: ${error.response.status} ${error.response.data?.errors?.[0] || error.response.statusText}`);
      }
      throw new Error(`Failed to load database credentials: ${error.message}`);
    }
  }

  /**
   * Get a specific secret value
   */
  getSecret(key, defaultValue = null) {
    if (!this.initialized) {
      throw new Error('VaultService not initialized. Call initialize() first.');
    }
    return this.secretsCache[key] !== undefined ? this.secretsCache[key] : defaultValue;
  }

  /**
   * Get all secrets as an object
   */
  getAllSecrets() {
    if (!this.initialized) {
      throw new Error('VaultService not initialized. Call initialize() first.');
    }
    return { ...this.secretsCache };
  }

  /**
   * Get database credentials
   */
  getDatabaseCredentials() {
    if (!this.initialized) {
      throw new Error('VaultService not initialized. Call initialize() first.');
    }
    
    // Check if credentials need refresh
    if (this.dbCredentialsExpiry && Date.now() >= this.dbCredentialsExpiry) {
      console.log('[VaultService] Database credentials expired, refreshing...');
      this.loadDatabaseCredentials().catch(err => {
        console.error('[VaultService] Failed to refresh database credentials:', err.message);
      });
    }

    return this.dbCredentialsCache;
  }

  /**
   * Reload all secrets (for SIGHUP signal handling)
   */
  async reloadSecrets() {
    console.log('[VaultService] Reloading secrets...');
    try {
      await this.loadSecrets();
      await this.loadDatabaseCredentials();
      console.log('[VaultService] Successfully reloaded secrets');
      return true;
    } catch (error) {
      console.error('[VaultService] Failed to reload secrets:', error.message);
      throw error;
    }
  }

  /**
   * Check if Vault is reachable
   */
  async healthCheck() {
    try {
      const response = await axios.get(
        `${this.vaultAddr}/v1/sys/health`,
        {
          timeout: 5000
        }
      );
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Revoke database credentials lease
   */
  async revokeDatabaseCredentials() {
    if (!this.dbCredentialsCache || !this.dbCredentialsCache.leaseId) {
      return;
    }

    try {
      await this._ensureAuthenticated();
      await axios.put(
        `${this.vaultAddr}/v1/sys/leases/revoke`,
        {
          lease_id: this.dbCredentialsCache.leaseId
        },
        {
          headers: {
            'X-Vault-Token': this.token,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );
      console.log('[VaultService] Successfully revoked database credentials');
    } catch (error) {
      console.error('[VaultService] Failed to revoke database credentials:', error.message);
    }
  }

  /**
   * Cleanup on shutdown
   */
  async cleanup() {
    await this.revokeDatabaseCredentials();
    this.token = null;
    this.initialized = false;
    this.initializationPromise = null;
  }
}

// Singleton instance
let vaultServiceInstance = null;

/**
 * Get or create the VaultService singleton
 */
function getVaultService(options = {}) {
  if (!vaultServiceInstance) {
    vaultServiceInstance = new VaultService(options);
  }
  return vaultServiceInstance;
}

/**
 * Reset the VaultService singleton (useful for testing)
 */
function resetVaultService() {
  if (vaultServiceInstance) {
    vaultServiceInstance.cleanup().catch(err => {
      console.error('[VaultService] Error during cleanup:', err.message);
    });
  }
  vaultServiceInstance = null;
}

module.exports = {
  VaultService,
  getVaultService,
  resetVaultService
};
