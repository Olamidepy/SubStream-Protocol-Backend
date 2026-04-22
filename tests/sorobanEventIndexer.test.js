const { SorobanEventIndexer } = require('../src/services/sorobanEventIndexer');
const { SorobanRpcService } = require('../src/services/sorobanRpcService');
const { SorobanXdrParser } = require('../src/utils/sorobanXdrParser');

// Mock dependencies
jest.mock('../src/services/sorobanRpcService');
jest.mock('../src/utils/sorobanXdrParser');

describe('SorobanEventIndexer', () => {
  let indexer;
  let mockConfig;
  let mockDatabase;
  let mockRpcService;
  let mockXdrParser;
  let mockEventPublisher;
  let mockLogger;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn()
      }
    };

    // Mock RPC service
    mockRpcService = {
      getLatestLedger: jest.fn(),
      getEvents: jest.fn(),
      getHealthStatus: jest.fn()
    };
    SorobanRpcService.mockImplementation(() => mockRpcService);

    // Mock XDR parser
    mockXdrParser = {
      parseEvent: jest.fn(),
      validateEventData: jest.fn()
    };
    SorobanXdrParser.mockImplementation(() => mockXdrParser);

    // Mock event publisher
    mockEventPublisher = {
      publish: jest.fn(),
      publishSubscriptionBilled: jest.fn(),
      publishTrialStarted: jest.fn(),
      publishPaymentFailed: jest.fn()
    };

    mockConfig = {
      contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
      soroban: {
        rpcUrl: 'https://rpc.stellar.org',
        networkPassphrase: 'Public Network',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L'
      },
      database: {
        filename: ':memory:'
      },
      processingInterval: 100
    };

    indexer = new SorobanEventIndexer(mockConfig, {
      logger: mockLogger,
      database: mockDatabase,
      eventPublisher: mockEventPublisher
    });
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(indexer.contractId).toBe(mockConfig.contractId);
      expect(indexer.eventTypes).toEqual(['SubscriptionBilled', 'TrialStarted', 'PaymentFailed']);
      expect(indexer.processingInterval).toBe(mockConfig.processingInterval);
    });
  });

  describe('initializeIngestionState', () => {
    test('should resume from existing state', async () => {
      const mockState = {
        last_ingested_ledger: 1000,
        last_ingested_timestamp: '2023-01-01T00:00:00Z'
      };

      const mockStmt = { get: jest.fn().mockReturnValue(mockState) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);
      mockRpcService.getLatestLedger.mockResolvedValue(2000);

      await indexer.initializeIngestionState();

      expect(indexer.currentLedger).toBe(1000);
      expect(indexer.lastProcessedLedger).toBe(1000);
      expect(mockLogger.info).toHaveBeenCalledWith('Resumed indexing from saved state', expect.any(Object));
    });

    test('should start from latest ledger when no state exists', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue(null) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);
      mockRpcService.getLatestLedger.mockResolvedValue(2000);

      await indexer.initializeIngestionState();

      expect(indexer.currentLedger).toBe(2000);
      expect(indexer.lastProcessedLedger).toBe(2000);
      expect(mockLogger.info).toHaveBeenCalledWith('Started indexing from latest ledger', expect.any(Object));
    });

    test('should handle database errors gracefully', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(indexer.initializeIngestionState()).rejects.toThrow('Database error');
    });
  });

  describe('processEvent', () => {
    test('should process valid event successfully', async () => {
      const mockEvent = {
        id: 'event-1',
        contractId: mockConfig.contractId,
        transactionHash: 'abc123',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: 'mock-xdr'
      };

      const mockParsedEvent = {
        isValid: true,
        type: 'SubscriptionBilled',
        transactionHash: 'abc123',
        eventIndex: 0,
        parsedData: {
          eventType: 'SubscriptionBilled',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...',
          amount: '10000000'
        }
      };

      mockXdrParser.parseEvent.mockReturnValue(mockParsedEvent);
      mockXdrParser.validateEventData.mockReturnValue({ isValid: true, errors: [] });

      // Mock database operations
      const mockStmt = { get: jest.fn().mockReturnValue(null), run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await indexer.processEvent(mockEvent);

      expect(result).toBe(true);
      expect(mockXdrParser.parseEvent).toHaveBeenCalledWith(mockEvent);
      expect(mockXdrParser.validateEventData).toHaveBeenCalledWith(mockParsedEvent);
      expect(mockEventPublisher.publish).toHaveBeenCalled();
      expect(indexer.stats.eventsProcessed).toBe(1);
    });

    test('should skip invalid events', async () => {
      const mockEvent = {
        id: 'event-invalid',
        contractId: mockConfig.contractId,
        transactionHash: 'invalid',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: 'invalid-xdr'
      };

      const mockParsedEvent = {
        isValid: false,
        error: 'Invalid XDR'
      };

      mockXdrParser.parseEvent.mockReturnValue(mockParsedEvent);

      const result = await indexer.processEvent(mockEvent);

      expect(result).toBe(false);
      expect(indexer.stats.eventsFailed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Skipping invalid event', expect.any(Object));
    });

    test('should skip events with validation errors', async () => {
      const mockEvent = {
        id: 'event-invalid-data',
        contractId: mockConfig.contractId,
        transactionHash: 'invalid-data',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: 'mock-xdr'
      };

      const mockParsedEvent = {
        isValid: true,
        type: 'SubscriptionBilled',
        transactionHash: 'invalid-data',
        eventIndex: 0,
        parsedData: {
          eventType: 'SubscriptionBilled'
          // Missing required fields
        }
      };

      mockXdrParser.parseEvent.mockReturnValue(mockParsedEvent);
      mockXdrParser.validateEventData.mockReturnValue({
        isValid: false,
        errors: ['Missing subscriber address', 'Missing creator address']
      });

      const result = await indexer.processEvent(mockEvent);

      expect(result).toBe(false);
      expect(indexer.stats.eventsFailed).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Skipping event with invalid data', expect.any(Object));
    });

    test('should skip duplicate events', async () => {
      const mockEvent = {
        id: 'event-duplicate',
        contractId: mockConfig.contractId,
        transactionHash: 'duplicate',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: 'mock-xdr'
      };

      const mockParsedEvent = {
        isValid: true,
        type: 'SubscriptionBilled',
        transactionHash: 'duplicate',
        eventIndex: 0,
        parsedData: {
          eventType: 'SubscriptionBilled',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...',
          amount: '10000000'
        }
      };

      mockXdrParser.parseEvent.mockReturnValue(mockParsedEvent);
      mockXdrParser.validateEventData.mockReturnValue({ isValid: true, errors: [] });

      // Mock database to return existing event (duplicate)
      const mockStmt = { get: jest.fn().mockReturnValue({ id: 'existing-id' }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await indexer.processEvent(mockEvent);

      expect(result).toBe(false);
      expect(indexer.stats.duplicatesSkipped).toBe(1);
      expect(mockLogger.debug).toHaveBeenCalledWith('Skipping duplicate event', expect.any(Object));
    });

    test('should skip irrelevant event types', async () => {
      const mockEvent = {
        id: 'event-irrelevant',
        contractId: mockConfig.contractId,
        transactionHash: 'irrelevant',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: 'mock-xdr'
      };

      const mockParsedEvent = {
        isValid: true,
        type: 'OtherEvent',
        transactionHash: 'irrelevant',
        eventIndex: 0
      };

      mockXdrParser.parseEvent.mockReturnValue(mockParsedEvent);

      const result = await indexer.processEvent(mockEvent);

      expect(result).toBe(false);
      expect(mockXdrParser.validateEventData).not.toHaveBeenCalled();
    });
  });

  describe('isDuplicateEvent', () => {
    test('should detect duplicate events', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue({ id: 'existing' }) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const parsedEvent = {
        transactionHash: 'duplicate',
        eventIndex: 0
      };

      const result = await indexer.isDuplicateEvent(parsedEvent);

      expect(result).toBe(true);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT id FROM soroban_events'));
    });

    test('should return false for new events', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue(null) };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const parsedEvent = {
        transactionHash: 'new',
        eventIndex: 0
      };

      const result = await indexer.isDuplicateEvent(parsedEvent);

      expect(result).toBe(false);
    });

    test('should handle database errors gracefully', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      const parsedEvent = {
        transactionHash: 'error',
        eventIndex: 0
      };

      const result = await indexer.isDuplicateEvent(parsedEvent);

      expect(result).toBe(false); // Assume not duplicate to avoid data loss
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to check for duplicate event', expect.any(Object));
    });
  });

  describe('storeEvent', () => {
    test('should store event successfully', async () => {
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const parsedEvent = {
        contractId: mockConfig.contractId,
        transactionHash: 'new',
        eventIndex: 0,
        type: 'SubscriptionBilled',
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        parsedData: { eventType: 'SubscriptionBilled' },
        rawXdr: 'mock-xdr'
      };

      const eventId = await indexer.storeEvent(parsedEvent);

      expect(eventId).toBeDefined();
      expect(eventId).toMatch(/^evt_\d+_[a-z0-9]+$/);
      expect(mockStmt.run).toHaveBeenCalledWith(
        expect.any(String), // id
        parsedEvent.contractId,
        parsedEvent.transactionHash,
        parsedEvent.eventIndex,
        parsedEvent.ledgerSequence,
        parsedEvent.type,
        JSON.stringify(parsedEvent.parsedData),
        parsedEvent.rawXdr,
        parsedEvent.ledgerTimestamp,
        expect.any(String), // ingested_at
        'processed',
        0
      );
    });

    test('should handle duplicate constraint violation', async () => {
      const mockStmt = { 
        run: jest.fn().mockImplementation(() => {
          const error = new Error('UNIQUE constraint failed');
          throw error;
        })
      };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const parsedEvent = {
        contractId: mockConfig.contractId,
        transactionHash: 'duplicate',
        eventIndex: 0,
        type: 'SubscriptionBilled',
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        parsedData: { eventType: 'SubscriptionBilled' },
        rawXdr: 'mock-xdr'
      };

      await expect(indexer.storeEvent(parsedEvent)).rejects.toThrow('Duplicate event');
    });
  });

  describe('getStats', () => {
    test('should return current statistics', () => {
      indexer.stats = {
        eventsProcessed: 100,
        eventsFailed: 5,
        duplicatesSkipped: 10,
        ledgersProcessed: 50,
        startTime: '2023-01-01T00:00:00Z',
        lastEventTime: '2023-01-01T01:00:00Z'
      };
      indexer.currentLedger = 1500;
      indexer.lastProcessedLedger = 1499;
      indexer.isRunning = true;

      const stats = indexer.getStats();

      expect(stats.eventsProcessed).toBe(100);
      expect(stats.eventsFailed).toBe(5);
      expect(stats.duplicatesSkipped).toBe(10);
      expect(stats.ledgersProcessed).toBe(50);
      expect(stats.currentLedger).toBe(1500);
      expect(stats.lastProcessedLedger).toBe(1499);
      expect(stats.isRunning).toBe(true);
      expect(stats.contractId).toBe(mockConfig.contractId);
      expect(stats.uptime).toBeDefined();
      expect(stats.eventsPerSecond).toBeDefined();
    });
  });

  describe('getHealthStatus', () => {
    test('should return healthy status when all components are working', async () => {
      indexer.isRunning = true;
      mockRpcService.getHealthStatus.mockResolvedValue({
        healthy: true,
        responseTime: 100
      });

      const health = await indexer.getHealthStatus();

      expect(health.healthy).toBe(true);
      expect(health.indexer).toBeDefined();
      expect(health.rpc).toBeDefined();
      expect(health.rpc.healthy).toBe(true);
    });

    test('should return unhealthy status when indexer is not running', async () => {
      indexer.isRunning = false;

      const health = await indexer.getHealthStatus();

      expect(health.healthy).toBe(false);
      expect(health.indexer.isRunning).toBe(false);
    });

    test('should return unhealthy status when RPC is unhealthy', async () => {
      indexer.isRunning = true;
      mockRpcService.getHealthStatus.mockResolvedValue({
        healthy: false,
        error: 'RPC unavailable'
      });

      const health = await indexer.getHealthStatus();

      expect(health.healthy).toBe(false);
      expect(health.rpc.healthy).toBe(false);
    });
  });

  describe('updateIngestionState', () => {
    test('should update ingestion state successfully', async () => {
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      await indexer.updateIngestionState(1500);

      expect(mockStmt.run).toHaveBeenCalledWith(
        mockConfig.contractId,
        1500,
        expect.any(String)
      );
    });

    test('should handle database errors', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(indexer.updateIngestionState(1500)).rejects.toThrow('Database error');
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to update ingestion state', expect.any(Object));
    });
  });

  describe('publishEvent', () => {
    test('should publish event when publisher is available', async () => {
      const parsedEvent = {
        type: 'SubscriptionBilled',
        contractId: mockConfig.contractId,
        transactionHash: 'abc123',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        parsedData: { eventType: 'SubscriptionBilled' }
      };

      await indexer.publishEvent(parsedEvent, 'event-id');

      expect(mockEventPublisher.publish).toHaveBeenCalledWith('soroban.events', expect.objectContaining({
        id: 'event-id',
        type: 'SubscriptionBilled',
        contractId: mockConfig.contractId
      }));
    });

    test('should handle publishing errors gracefully', async () => {
      mockEventPublisher.publish.mockRejectedValue(new Error('Publishing failed'));

      const parsedEvent = {
        type: 'SubscriptionBilled',
        contractId: mockConfig.contractId,
        transactionHash: 'abc123',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        parsedData: { eventType: 'SubscriptionBilled' }
      };

      // Should not throw error
      await expect(indexer.publishEvent(parsedEvent, 'event-id')).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to publish event', expect.any(Object));
    });

    test('should skip publishing when no publisher is available', async () => {
      const indexerWithoutPublisher = new SorobanEventIndexer(mockConfig, {
        logger: mockLogger,
        database: mockDatabase,
        eventPublisher: null
      });

      const parsedEvent = {
        type: 'SubscriptionBilled',
        contractId: mockConfig.contractId,
        transactionHash: 'abc123',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        parsedData: { eventType: 'SubscriptionBilled' }
      };

      // Should not throw error
      await expect(indexerWithoutPublisher.publishEvent(parsedEvent, 'event-id')).resolves.toBeUndefined();
    });
  });
});
