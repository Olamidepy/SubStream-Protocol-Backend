const { SorobanRpcService } = require('../src/services/sorobanRpcService');
const { Server } = require('@stellar/stellar-sdk');

// Mock the Stellar SDK Server
jest.mock('@stellar/stellar-sdk', () => ({
  Server: jest.fn(),
  Networks: {
    PUBLIC: 'Public Network'
  },
  xdr: {
    ScVal: {
      fromXDR: jest.fn()
    }
  }
}));

describe('SorobanRpcService', () => {
  let service;
  let mockServer;
  let mockConfig;

  beforeEach(() => {
    mockServer = {
      getLatestLedger: jest.fn(),
      events: jest.fn(),
      getTransaction: jest.fn(),
      getLedger: jest.fn()
    };

    Server.mockImplementation(() => mockServer);

    mockConfig = {
      rpcUrl: 'https://rpc.stellar.org',
      networkPassphrase: 'Public Network',
      contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 1000,
      failureThreshold: 3,
      resetTimeout: 5000,
      requestsPerSecond: 10
    };

    service = new SorobanRpcService(mockConfig);
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(service.rpcUrl).toBe(mockConfig.rpcUrl);
      expect(service.networkPassphrase).toBe(mockConfig.networkPassphrase);
      expect(service.contractId).toBe(mockConfig.contractId);
      expect(service.maxRetries).toBe(mockConfig.maxRetries);
      expect(service.baseDelay).toBe(mockConfig.baseDelay);
      expect(service.maxDelay).toBe(mockConfig.maxDelay);
    });

    test('should initialize circuit breaker in CLOSED state', () => {
      expect(service.circuitBreaker.state).toBe('CLOSED');
      expect(service.circuitBreaker.failureCount).toBe(0);
    });
  });

  describe('circuit breaker', () => {
    test('should open circuit breaker after failure threshold', () => {
      // Simulate failures
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      expect(service.circuitBreaker.state).toBe('OPEN');
      expect(service.circuitBreaker.failureCount).toBe(mockConfig.failureThreshold);
    });

    test('should reset circuit breaker after timeout', () => {
      // Open circuit breaker
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      // Simulate time passing
      const originalTime = Date.now;
      Date.now = jest.fn(() => originalTime() + mockConfig.resetTimeout + 1000);

      service.checkCircuitBreaker();
      expect(service.circuitBreaker.state).toBe('HALF_OPEN');

      // Restore Date.now
      Date.now = originalTime;
    });

    test('should close circuit breaker on success after HALF_OPEN', () => {
      // Open circuit breaker
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      // Move to HALF_OPEN
      service.circuitBreaker.state = 'HALF_OPEN';

      // Record success
      service.recordSuccess();

      expect(service.circuitBreaker.state).toBe('CLOSED');
      expect(service.circuitBreaker.failureCount).toBe(0);
    });

    test('should throw error when circuit breaker is OPEN', () => {
      // Open circuit breaker
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      expect(() => service.checkCircuitBreaker()).toThrow('Circuit breaker is OPEN');
    });
  });

  describe('rate limiting', () => {
    test('should allow requests within rate limit', () => {
      const originalTime = Date.now;
      const now = originalTime();
      Date.now = jest.fn(() => now);

      // Should not throw for requests within limit
      for (let i = 0; i < mockConfig.requestsPerSecond; i++) {
        expect(() => service.checkRateLimit()).not.toThrow();
      }

      // Restore Date.now
      Date.now = originalTime;
    });

    test('should throw error when rate limit exceeded', () => {
      const originalTime = Date.now;
      const now = originalTime();
      Date.now = jest.fn(() => now);

      // Fill up rate limit
      for (let i = 0; i < mockConfig.requestsPerSecond; i++) {
        service.checkRateLimit();
      }

      // Next request should throw
      expect(() => service.checkRateLimit()).toThrow('Rate limit exceeded');

      // Restore Date.now
      Date.now = originalTime;
    });

    test('should reset rate limit after time window', () => {
      const originalTime = Date.now;
      const now = originalTime();
      Date.now = jest.fn(() => now);

      // Fill up rate limit
      for (let i = 0; i < mockConfig.requestsPerSecond; i++) {
        service.checkRateLimit();
      }

      // Simulate time passing (more than 1 second)
      Date.now = jest.fn(() => now + 1100);

      // Should allow new requests
      expect(() => service.checkRateLimit()).not.toThrow();

      // Restore Date.now
      Date.now = originalTime;
    });
  });

  describe('executeWithRetry', () => {
    test('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      
      const result = await service.executeWithRetry(operation);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry on failure and eventually succeed', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('failure 1'))
        .mockRejectedValueOnce(new Error('failure 2'))
        .mockResolvedValue('success');

      const result = await service.executeWithRetry(operation);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should fail after max retries', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('persistent failure'));
      
      await expect(service.executeWithRetry(operation)).rejects.toThrow('persistent failure');
      expect(operation).toHaveBeenCalledTimes(mockConfig.maxRetries + 1);
    });

    test('should respect circuit breaker', async () => {
      // Open circuit breaker
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      const operation = jest.fn().mockResolvedValue('success');
      
      await expect(service.executeWithRetry(operation)).rejects.toThrow('Circuit breaker is OPEN');
      expect(operation).not.toHaveBeenCalled();
    });
  });

  describe('getLatestLedger', () => {
    test('should get latest ledger successfully', async () => {
      const mockLedgerSequence = 12345;
      mockServer.getLatestLedger.mockResolvedValue({ sequence: mockLedgerSequence });

      const result = await service.getLatestLedger();

      expect(result).toBe(mockLedgerSequence);
      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    test('should retry on failure', async () => {
      mockServer.getLatestLedger
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue({ sequence: 12345 });

      const result = await service.getLatestLedger();

      expect(result).toBe(12345);
      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(2);
    });
  });

  describe('getEvents', () => {
    test('should get events successfully', async () => {
      const mockEvents = { events: [] };
      mockServer.events.mockResolvedValue(mockEvents);

      const result = await service.getEvents(100, 200);

      expect(result).toBe(mockEvents);
      expect(mockServer.events).toHaveBeenCalledWith({
        startLedger: 100,
        endLedger: 200,
        filters: {
          contractIds: [mockConfig.contractId]
        }
      });
    });

    test('should merge custom filters', async () => {
      const mockEvents = { events: [] };
      mockServer.events.mockResolvedValue(mockEvents);

      const customFilters = { eventTypes: ['subscription'] };
      await service.getEvents(100, 200, customFilters);

      expect(mockServer.events).toHaveBeenCalledWith({
        startLedger: 100,
        endLedger: 200,
        filters: {
          contractIds: [mockConfig.contractId],
          ...customFilters
        }
      });
    });
  });

  describe('getTransaction', () => {
    test('should get transaction successfully', async () => {
      const mockTransaction = { hash: 'abc123' };
      mockServer.getTransaction.mockResolvedValue(mockTransaction);

      const result = await service.getTransaction('abc123');

      expect(result).toBe(mockTransaction);
      expect(mockServer.getTransaction).toHaveBeenCalledWith('abc123');
    });
  });

  describe('getLedger', () => {
    test('should get ledger successfully', async () => {
      const mockLedger = { sequence: 12345 };
      mockServer.getLedger.mockResolvedValue(mockLedger);

      const result = await service.getLedger(12345);

      expect(result).toBe(mockLedger);
      expect(mockServer.getLedger).toHaveBeenCalledWith(12345);
    });
  });

  describe('isRelevantEvent', () => {
    test('should identify relevant events', () => {
      const mockEvent = {
        body: 'mock-xdr-data',
        type: 'contract'
      };

      // Mock the XDR parsing
      const { xdr } = require('@stellar/stellar-sdk');
      xdr.ScVal.fromXDR.mockReturnValue({
        switch: () => ({ name: 'instance' }),
        instance: () => ({
          switch: () => ({ name: 'vec' }),
          vec: () => [
            {
              switch: () => ({ name: 'symbol' }),
              symbol: () => 'SubscriptionBilled'
            }
          ]
        })
      });

      const result = service.isRelevantEvent(mockEvent, ['SubscriptionBilled']);
      expect(result).toBe(true);
    });

    test('should reject non-contract events', () => {
      const mockEvent = {
        body: 'mock-xdr-data',
        type: 'system'
      };

      const result = service.isRelevantEvent(mockEvent, ['SubscriptionBilled']);
      expect(result).toBe(false);
    });

    test('should handle XDR parsing errors gracefully', () => {
      const mockEvent = {
        body: 'invalid-xdr',
        type: 'contract'
      };

      // Mock XDR parsing to throw
      const { xdr } = require('@stellar/stellar-sdk');
      xdr.ScVal.fromXDR.mockImplementation(() => {
        throw new Error('Invalid XDR');
      });

      const result = service.isRelevantEvent(mockEvent, ['SubscriptionBilled']);
      expect(result).toBe(false);
    });
  });

  describe('getHealthStatus', () => {
    test('should return healthy status when RPC is working', async () => {
      mockServer.getLatestLedger.mockResolvedValue({ sequence: 12345 });

      const status = await service.getHealthStatus();

      expect(status.healthy).toBe(true);
      expect(status.responseTime).toBeDefined();
      expect(status.circuitBreakerState).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
      expect(status.rpcUrl).toBe(mockConfig.rpcUrl);
    });

    test('should return unhealthy status when RPC fails', async () => {
      mockServer.getLatestLedger.mockRejectedValue(new Error('RPC error'));

      const status = await service.getHealthStatus();

      expect(status.healthy).toBe(false);
      expect(status.error).toBe('RPC error');
      expect(status.rpcUrl).toBe(mockConfig.rpcUrl);
    });
  });

  describe('resetCircuitBreaker', () => {
    test('should reset circuit breaker to CLOSED state', () => {
      // Open circuit breaker
      for (let i = 0; i < mockConfig.failureThreshold; i++) {
        service.recordFailure();
      }

      expect(service.circuitBreaker.state).toBe('OPEN');

      // Reset
      service.resetCircuitBreaker();

      expect(service.circuitBreaker.state).toBe('CLOSED');
      expect(service.circuitBreaker.failureCount).toBe(0);
      expect(service.circuitBreaker.lastFailureTime).toBeNull();
    });
  });

  describe('sleep utility', () => {
    test('should sleep for specified time', async () => {
      const startTime = Date.now();
      await service.sleep(100);
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow some tolerance
    });
  });
});
