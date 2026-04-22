const { SorobanDeadLetterQueue } = require('../src/services/sorobanDeadLetterQueue');
const { SlackAlertService } = require('../src/services/slackAlertService');

// Mock dependencies
jest.mock('../src/db/appDatabase');
jest.mock('../src/services/slackAlertService');
jest.mock('bullmq');

describe('SorobanDeadLetterQueue', () => {
  let dlqService;
  let mockDatabase;
  let mockAlertService;
  let mockQueue;
  let mockWorker;
  let mockConfig;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn()
      }
    };

    // Mock alert service
    mockAlertService = {
      sendAlert: jest.fn(),
      sendDlqAlert: jest.fn()
    };

    // Mock BullMQ
    mockQueue = {
      add: jest.fn(),
      close: jest.fn()
    };

    mockWorker = {
      on: jest.fn(),
      close: jest.fn()
    };

    const { Queue, Worker } = require('bullmq');
    Queue.mockImplementation(() => mockQueue);
    Worker.mockImplementation(() => mockWorker);

    mockConfig = {
      redis: {
        host: 'localhost',
        port: 6379
      },
      maxRetries: 3,
      retryDelay: 5000,
      retentionDays: 14,
      logLevel: 'error'
    };

    dlqService = new SorobanDeadLetterQueue(mockConfig, {
      database: mockDatabase,
      alertService: mockAlertService
    });
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(dlqService.config).toBe(mockConfig);
      expect(dlqService.database).toBe(mockDatabase);
      expect(dlqService.alertService).toBe(mockAlertService);
      expect(dlqService.maxRetries).toBe(3);
      expect(dlqService.retentionDays).toBe(14);
    });

    test('should use default alert service if not provided', () => {
      const dlqWithoutAlert = new SorobanDeadLetterQueue(mockConfig, {
        database: mockDatabase
      });

      expect(dlqWithoutAlert.alertService).toBeInstanceOf(SlackAlertService);
    });
  });

  describe('initialize', () => {
    test('should initialize queues and worker', async () => {
      await dlqService.initialize();

      expect(require('bullmq').Queue).toHaveBeenCalledWith('soroban-dlq', expect.any(Object));
      expect(require('bullmq').Queue).toHaveBeenCalledWith('soroban-retry', expect.any(Object));
      expect(require('bullmq').Worker).toHaveBeenCalledWith('soroban-retry', expect.any(Function), expect.any(Object));
    });

    test('should setup worker event handlers', async () => {
      await dlqService.initialize();

      expect(mockWorker.on).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(mockWorker.on).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockWorker.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('addFailedEvent', () => {
    test('should add failed event to DLQ successfully', async () => {
      const mockEvent = {
        id: 'event-1',
        contractId: 'CONTRACT_123',
        transactionHash: 'tx_hash_123',
        eventIndex: 0,
        ledgerSequence: 12345,
        type: 'SubscriptionBilled',
        rawXdr: 'mock-xdr-data'
      };

      const mockError = new Error('XDR parsing failed');
      const mockAttemptCount = 3;

      // Mock database operations
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      // Mock queue add
      mockQueue.add.mockResolvedValue({ id: 'job-123' });

      const result = await dlqService.addFailedEvent(mockEvent, mockError, mockAttemptCount);

      expect(result.success).toBe(true);
      expect(result.dlqId).toBeDefined();
      expect(result.jobId).toBe('job-123');
      expect(result.willRetry).toBe(false); // 3 attempts = max retries

      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO soroban_dlq_items'));
      expect(mockQueue.add).toHaveBeenCalledWith('failed-event', expect.any(Object), expect.any(Object));
      expect(mockAlertService.sendDlqAlert).toHaveBeenCalled();
    });

    test('should categorize errors correctly', async () => {
      const mockEvent = {
        id: 'event-1',
        contractId: 'CONTRACT_123',
        transactionHash: 'tx_hash_123',
        eventIndex: 0,
        ledgerSequence: 12345,
        type: 'SubscriptionBilled'
      };

      const xdrError = new Error('Invalid XDR format');
      const validationError = new Error('Validation failed: missing field');
      const networkError = new Error('Network timeout');

      // Mock database and queue
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);
      mockQueue.add.mockResolvedValue({ id: 'job-123' });

      // Test XDR parsing error
      await dlqService.addFailedEvent(mockEvent, xdrError, 1);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO soroban_dlq_items'),
        expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(Number), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), 'xdr_parsing', expect.any(Number), expect.any(String)])
      );

      // Test validation error
      await dlqService.addFailedEvent(mockEvent, validationError, 1);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO soroban_dlq_items'),
        expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(Number), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), 'validation', expect.any(Number), expect.any(String)])
      );

      // Test network error
      await dlqService.addFailedEvent(mockEvent, networkError, 1);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO soroban_dlq_items'),
        expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(Number), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), 'network', expect.any(Number), expect.any(String)])
      );
    });

    test('should handle queue failure gracefully', async () => {
      const mockEvent = {
        id: 'event-1',
        contractId: 'CONTRACT_123',
        transactionHash: 'tx_hash_123',
        eventIndex: 0,
        ledgerSequence: 12345,
        type: 'SubscriptionBilled'
      };

      const mockError = new Error('XDR parsing failed');

      // Mock database operations
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      // Mock queue failure
      mockQueue.add.mockRejectedValue(new Error('Queue full'));

      const result = await dlqService.addFailedEvent(mockEvent, mockError, 1);

      expect(result.success).toBe(false);
      expect(result.queueError).toBe('Queue full');
      expect(result.dbId).toBeDefined(); // Should still store in database
    });

    test('should handle complete failure', async () => {
      const mockEvent = {
        id: 'event-1',
        contractId: 'CONTRACT_123',
        transactionHash: 'tx_hash_123',
        eventIndex: 0,
        ledgerSequence: 12345,
        type: 'SubscriptionBilled'
      };

      const mockError = new Error('XDR parsing failed');

      // Mock database failure
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      await expect(dlqService.addFailedEvent(mockEvent, mockError, 1)).rejects.toThrow('Failed to add event to DLQ');
    });
  });

  describe('retryDlqItem', () => {
    test('should retry DLQ item successfully', async () => {
      const dlqId = 'dlq_123';

      const mockDlqItem = {
        id: dlqId,
        status: 'failed',
        retry_count: 0
      };

      // Mock getDlqItem
      mockDatabase.db.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(mockDlqItem)
      });

      // Mock updateDlqStatus
      mockDatabase.db.prepare.mockReturnValueOnce({
        run: jest.fn()
      });

      // Mock recordRetryAttempt
      mockDatabase.db.prepare.mockReturnValueOnce({
        run: jest.fn()
      });

      // Mock queue add
      mockQueue.add.mockResolvedValue({ id: 'retry-job-123' });

      const result = await dlqService.retryDlqItem(dlqId, 'admin');

      expect(result.success).toBe(true);
      expect(result.dlqId).toBe(dlqId);
      expect(result.jobId).toBe('retry-job-123');
      expect(result.status).toBe('retrying');

      expect(mockQueue.add).toHaveBeenCalledWith('manual-retry', mockDlqItem, expect.objectContaining({
        priority: 10
      }));
    });

    test('should throw error for non-existent DLQ item', async () => {
      const dlqId = 'non-existent';

      // Mock getDlqItem returns null
      mockDatabase.db.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(null)
      });

      await expect(dlqService.retryDlqItem(dlqId, 'admin')).rejects.toThrow('DLQ item not found');
    });

    test('should throw error for non-retryable status', async () => {
      const dlqId = 'dlq_123';

      const mockDlqItem = {
        id: dlqId,
        status: 'resolved',
        retry_count: 0
      };

      // Mock getDlqItem
      mockDatabase.db.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(mockDlqItem)
      });

      await expect(dlqService.retryDlqItem(dlqId, 'admin')).rejects.toThrow('DLQ item is not in a retryable state');
    });
  });

  describe('listDlqItems', () => {
    test('should list DLQ items with filters', async () => {
      const mockItems = [
        { id: 'dlq_1', status: 'failed', error_category: 'xdr_parsing' },
        { id: 'dlq_2', status: 'retrying', error_category: 'validation' }
      ];

      const mockStmt = {
        all: jest.fn().mockReturnValue(mockItems)
      };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await dlqService.listDlqItems({
        status: 'failed',
        errorCategory: 'xdr_parsing',
        limit: 10,
        offset: 0
      });

      expect(result).toEqual(mockItems);
      expect(mockStmt.all).toHaveBeenCalledWith('failed', 'xdr_parsing', 10, 0);
    });

    test('should use default options', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([])
      };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      await dlqService.listDlqItems();

      expect(mockStmt.all).toHaveBeenCalledWith(50, 0, 'created_at', 'DESC');
    });
  });

  describe('getStats', () => {
    test('should return DLQ statistics', async () => {
      const mockDbStats = {
        total_items: 10,
        failed_items: 5,
        retrying_items: 3,
        retried_items: 1,
        resolved_items: 1,
        expired_items: 0
      };

      const mockStmt = {
        get: jest.fn().mockReturnValue(mockDbStats)
      };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const stats = await dlqService.getStats();

      expect(stats.database).toEqual(mockDbStats);
      expect(stats.itemsAdded).toBe(0); // Default value
      expect(stats.itemsRetried).toBe(0);
      expect(stats.uptime).toBeDefined();
    });

    test('should handle database errors gracefully', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      const stats = await dlqService.getStats();

      expect(stats.itemsAdded).toBe(0);
      expect(stats.itemsRetried).toBe(0);
      expect(stats.database).toBeUndefined();
    });
  });

  describe('processRetryJob', () => {
    test('should process retry job successfully', async () => {
      const mockJob = {
        data: {
          id: 'dlq_123',
          transaction_hash: 'tx_123',
          event_index: 0
        },
        attemptsMade: 0,
        id: 'job_123'
      };

      const mockIndexer = {
        reprocessEvent: jest.fn().mockResolvedValue({ success: true })
      };

      dlqService.indexer = mockIndexer;

      // Mock recordRetryAttempt and markAsResolved
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      const result = await dlqService.processRetryJob(mockJob);

      expect(result.success).toBe(true);
      expect(result.executionTime).toBeDefined();
      expect(mockIndexer.reprocessEvent).toHaveBeenCalledWith(mockJob.data);
    });

    test('should handle reprocessing failure', async () => {
      const mockJob = {
        data: {
          id: 'dlq_123',
          transaction_hash: 'tx_123',
          event_index: 0
        },
        attemptsMade: 0,
        id: 'job_123'
      };

      const mockIndexer = {
        reprocessEvent: jest.fn().mockResolvedValue({ 
          success: false, 
          error: 'Reprocessing failed' 
        })
      };

      dlqService.indexer = mockIndexer;

      await expect(dlqService.processRetryJob(mockJob)).rejects.toThrow('Reprocessing failed');
    });

    test('should handle final retry attempt failure', async () => {
      const mockJob = {
        data: {
          id: 'dlq_123',
          transaction_hash: 'tx_123',
          event_index: 0
        },
        attemptsMade: 3, // Max retries
        id: 'job_123'
      };

      const mockIndexer = {
        reprocessEvent: jest.fn().mockResolvedValue({ 
          success: false, 
          error: 'Final failure' 
        })
      };

      dlqService.indexer = mockIndexer;

      // Mock markAsPermanentlyFailed
      const mockStmt = { run: jest.fn() };
      mockDatabase.db.prepare.mockReturnValue(mockStmt);

      await expect(dlqService.processRetryJob(mockJob)).rejects.toThrow('Final failure');

      // Should mark as permanently failed
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE soroban_dlq_items SET status = \'failed\''),
        'Final failure',
        'dlq_123'
      );
    });
  });

  describe('getPriority', () => {
    test('should return correct priority based on error category', () => {
      expect(dlqService.getPriority('network')).toBe(1);
      expect(dlqService.getPriority('processing')).toBe(5);
      expect(dlqService.getPriority('validation')).toBe(8);
      expect(dlqService.getPriority('xdr_parsing')).toBe(10);
      expect(dlqService.getPriority('database')).toBe(9);
      expect(dlqService.getPriority('unknown')).toBe(5);
    });
  });

  describe('getAlertSeverity', () => {
    test('should return correct severity based on error category', () => {
      expect(dlqService.getAlertSeverity('network')).toBe('warning');
      expect(dlqService.getAlertSeverity('processing')).toBe('warning');
      expect(dlqService.getAlertSeverity('validation')).toBe('error');
      expect(dlqService.getAlertSeverity('xdr_parsing')).toBe('critical');
      expect(dlqService.getAlertSeverity('database')).toBe('critical');
      expect(dlqService.getAlertSeverity('unknown')).toBe('warning');
    });
  });

  describe('cleanupExpiredItems', () => {
    test('should clean up expired items', async () => {
      const mockExpireResult = { expired_count: 5 };
      const mockCleanupResult = { cleanup_count: 2 };

      // Mock database functions
      mockDatabase.db.prepare.mockReturnValueOnce({
        get: jest.fn().mockReturnValue(mockExpireResult)
      }).mockReturnValueOnce({
        get: jest.fn().mockReturnValue(mockCleanupResult)
      });

      await dlqService.cleanupExpiredItems();

      expect(dlqService.stats.itemsExpired).toBe(5);
    });
  });

  describe('close', () => {
    test('should close all queues and workers', async () => {
      await dlqService.initialize();
      await dlqService.close();

      expect(mockWorker.close).toHaveBeenCalled();
      expect(mockQueue.close).toHaveBeenCalledTimes(2); // dlq and retry queues
    });
  });
});
