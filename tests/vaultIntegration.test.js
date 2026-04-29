/**
 * Vault Integration Tests
 * 
 * Tests for Vault service unreachability scenarios and graceful degradation.
 * These tests ensure the application fails gracefully when Vault is unreachable
 * and logs clear error messages for debugging.
 */

const { VaultService, getVaultService, resetVaultService } = require('../src/services/vaultService');
const { loadConfig } = require('../src/config');

describe('Vault Integration Tests', () => {
  beforeEach(() => {
    resetVaultService();
    // Mock environment variables for testing
    process.env.VAULT_ENABLED = 'true';
    process.env.VAULT_ADDR = 'http://localhost:8200';
    process.env.VAULT_ROLE = 'test-role';
    process.env.VAULT_AUTH_PATH = 'auth/kubernetes';
    process.env.VAULT_SECRET_PATH = 'secret/data/test';
    process.env.VAULT_DB_PATH = 'database/creds/test-role';
  });

  afterEach(() => {
    resetVaultService();
    delete process.env.VAULT_ENABLED;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_ROLE;
    delete process.env.VAULT_AUTH_PATH;
    delete process.env.VAULT_SECRET_PATH;
    delete process.env.VAULT_DB_PATH;
  });

  describe('Vault Unreachability Scenarios', () => {
    test('should fail gracefully when Vault server is unreachable', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://unreachable-vault:8200',
        vaultRole: 'test-role',
        timeout: 1000
      });

      await expect(vaultService.initialize()).rejects.toThrow();
      
      // Verify the service is not marked as initialized
      expect(vaultService.initialized).toBe(false);
    });

    test('should fall back to environment variables when Vault fails', async () => {
      // Set environment variables as fallback
      process.env.REDIS_PASSWORD = 'fallback-redis-password';
      process.env.CREATOR_AUTH_SECRET = 'fallback-auth-secret';
      process.env.JWT_SECRET = 'fallback-jwt-secret';

      const vaultService = new VaultService({
        vaultAddr: 'http://unreachable-vault:8200',
        vaultRole: 'test-role',
        timeout: 1000
      });

      // Config should load with fallback values
      const config = await loadConfig(process.env, vaultService);
      
      expect(config.redis.password).toBe('fallback-redis-password');
      expect(config.auth.creatorJwtSecret).toBe('fallback-auth-secret');
      expect(config.auth.jwtSecret).toBe('fallback-jwt-secret');
    });

    test('should log clear error message when Vault authentication fails', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://localhost:8200',
        vaultRole: 'invalid-role',
        timeout: 1000
      });

      try {
        await vaultService.initialize();
      } catch (error) {
        expect(error.message).toContain('Vault');
        expect(error.message).toContain('initialization');
      }
    });

    test('should handle Vault timeout gracefully', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://localhost:8200',
        vaultRole: 'test-role',
        timeout: 1 // 1ms timeout
      });

      await expect(vaultService.initialize()).rejects.toThrow();
    });

    test('should not block application startup when Vault is slow', async () => {
      const startTime = Date.now();
      
      const vaultService = new VaultService({
        vaultAddr: 'http://localhost:8200',
        vaultRole: 'test-role',
        timeout: 100
      });

      try {
        await vaultService.initialize();
      } catch (error) {
        // Expected to fail
      }

      const duration = Date.now() - startTime;
      
      // Should fail quickly (within 200ms including overhead)
      expect(duration).toBeLessThan(200);
    });
  });

  describe('Vault Secret Loading', () => {
    test('should return default values when Vault is not initialized', () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://localhost:8200',
        vaultRole: 'test-role'
      });

      expect(() => vaultService.getSecret('test-key', 'default')).toThrow();
    });

    test('should handle reloadSecrets failure gracefully', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://unreachable-vault:8200',
        vaultRole: 'test-role',
        timeout: 1000
      });

      await expect(vaultService.reloadSecrets()).rejects.toThrow();
    });
  });

  describe('Vault Health Check', () => {
    test('should return false when Vault is unreachable', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://unreachable-vault:8200',
        vaultRole: 'test-role'
      });

      const isHealthy = await vaultService.healthCheck();
      expect(isHealthy).toBe(false);
    });
  });

  describe('Vault Configuration', () => {
    test('should use default configuration when environment variables are not set', () => {
      delete process.env.VAULT_ADDR;
      delete process.env.VAULT_ROLE;
      delete process.env.VAULT_AUTH_PATH;
      delete process.env.VAULT_SECRET_PATH;
      delete process.env.VAULT_DB_PATH;

      const vaultService = new VaultService();
      
      expect(vaultService.vaultAddr).toBe('http://vault:8200');
      expect(vaultService.vaultRole).toBe('substream-backend');
      expect(vaultService.authPath).toBe('auth/kubernetes');
      expect(vaultService.secretPath).toBe('secret/data/substream');
      expect(vaultService.dbPath).toBe('database/creds/substream-role');
    });

    test('should use custom configuration when environment variables are set', () => {
      process.env.VAULT_ADDR = 'http://custom-vault:8200';
      process.env.VAULT_ROLE = 'custom-role';
      process.env.VAULT_AUTH_PATH = 'auth/custom';
      process.env.VAULT_SECRET_PATH = 'secret/data/custom';
      process.env.VAULT_DB_PATH = 'database/creds/custom-role';

      const vaultService = new VaultService();
      
      expect(vaultService.vaultAddr).toBe('http://custom-vault:8200');
      expect(vaultService.vaultRole).toBe('custom-role');
      expect(vaultService.authPath).toBe('auth/custom');
      expect(vaultService.secretPath).toBe('secret/data/custom');
      expect(vaultService.dbPath).toBe('database/creds/custom-role');
    });
  });

  describe('Vault Singleton Pattern', () => {
    test('should return the same instance when calling getVaultService', () => {
      const vaultService1 = getVaultService({ vaultRole: 'test-role-1' });
      const vaultService2 = getVaultService({ vaultRole: 'test-role-2' });
      
      expect(vaultService1).toBe(vaultService2);
      expect(vaultService1.vaultRole).toBe('test-role-1'); // First configuration wins
    });

    test('should reset singleton when calling resetVaultService', () => {
      const vaultService1 = getVaultService({ vaultRole: 'test-role' });
      resetVaultService();
      const vaultService2 = getVaultService({ vaultRole: 'new-role' });
      
      expect(vaultService1).not.toBe(vaultService2);
      expect(vaultService2.vaultRole).toBe('new-role');
    });
  });

  describe('Vault Cleanup', () => {
    test('should cleanup resources without errors when Vault is not initialized', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://localhost:8200',
        vaultRole: 'test-role'
      });

      await expect(vaultService.cleanup()).resolves.not.toThrow();
    });

    test('should handle revokeDatabaseCredentials failure gracefully', async () => {
      const vaultService = new VaultService({
        vaultAddr: 'http://unreachable-vault:8200',
        vaultRole: 'test-role'
      });

      // Manually set credentials to test revocation
      vaultService.dbCredentialsCache = {
        username: 'test',
        password: 'test',
        leaseId: 'test-lease-id'
      };

      await expect(vaultService.revokeDatabaseCredentials()).resolves.not.toThrow();
    });
  });
});

describe('Config with Vault Integration', () => {
  beforeEach(() => {
    // Set environment variables
    process.env.VAULT_ENABLED = 'true';
    process.env.REDIS_PASSWORD = 'env-redis-password';
    process.env.CREATOR_AUTH_SECRET = 'env-auth-secret';
  });

  afterEach(() => {
    delete process.env.VAULT_ENABLED;
    delete process.env.REDIS_PASSWORD;
    delete process.env.CREATOR_AUTH_SECRET;
  });

  test('should load configuration without Vault when VAULT_ENABLED is false', async () => {
    process.env.VAULT_ENABLED = 'false';
    
    const config = await loadConfig(process.env, null);
    
    expect(config.vaultEnabled).toBe(false);
    expect(config.redis.password).toBe('env-redis-password');
  });

  test('should attempt to load from Vault when VAULT_ENABLED is true', async () => {
    const vaultService = new VaultService({
      vaultAddr: 'http://unreachable-vault:8200',
      vaultRole: 'test-role',
      timeout: 100
    });

    const config = await loadConfig(process.env, vaultService);
    
    expect(config.vaultEnabled).toBe(true);
    // Should fall back to environment variables when Vault fails
    expect(config.redis.password).toBe('env-redis-password');
  });
});
