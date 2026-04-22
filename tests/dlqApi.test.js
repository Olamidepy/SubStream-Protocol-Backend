const request = require('supertest');
const express = require('express');

// Mock dependencies
jest.mock('../src/services/sorobanDeadLetterQueue');

describe('DLQ Admin API', () => {
  let app;
  let mockDlqService;

  beforeEach(() => {
    // Create Express app
    app = express();
    app.use(express.json());

    // Mock DLQ service
    mockDlqService = {
      retryDlqItem: jest.fn(),
      listDlqItems: jest.fn(),
      getDlqItem: jest.fn(),
      getRetryAttempts: jest.fn(),
      getStats: jest.fn(),
      markAsResolved: jest.fn(),
      cleanupExpiredItems: jest.fn()
    };

    // Set mock service in app locals
    app.locals.dlqService = mockDlqService;

    // Import and use DLQ routes
    const dlqRoutes = require('../routes/admin/dlq');
    app.use('/admin/dlq', dlqRoutes);
  });

  describe('POST /admin/dlq/retry', () => {
    test('should retry DLQ item successfully', async () => {
      const dlqId = 'dlq_123';
      const mockResult = {
        success: true,
        dlqId,
        jobId: 'job_123',
        status: 'retrying'
      };

      mockDlqService.retryDlqItem.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/admin/dlq/retry')
        .send({ dlqId });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: mockResult
      });

      expect(mockDlqService.retryDlqItem).toHaveBeenCalledWith(dlqId, 'admin');
    });

    test('should return 400 when dlqId is missing', async () => {
      const response = await request(app)
        .post('/admin/dlq/retry')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'dlqId is required'
      });
    });

    test('should return 503 when DLQ service is not available', async () => {
      app.locals.dlqService = null;

      const response = await request(app)
        .post('/admin/dlq/retry')
        .send({ dlqId: 'dlq_123' });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        success: false,
        error: 'DLQ service not available'
      });
    });

    test('should handle service errors', async () => {
      const dlqId = 'dlq_123';
      mockDlqService.retryDlqItem.mockRejectedValue(new Error('Service error'));

      const response = await request(app)
        .post('/admin/dlq/retry')
        .send({ dlqId });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: 'Service error'
      });
    });
  });

  describe('POST /admin/dlq/batch-retry', () => {
    test('should retry multiple DLQ items', async () => {
      const dlqIds = ['dlq_1', 'dlq_2', 'dlq_3'];
      const mockResults = [
        { dlqId: 'dlq_1', success: true, data: { jobId: 'job_1' } },
        { dlqId: 'dlq_2', success: true, data: { jobId: 'job_2' } },
        { dlqId: 'dlq_3', success: false, error: 'Item not found' }
      ];

      mockDlqService.retryDlqItem
        .mockResolvedValueOnce(mockResults[0].data)
        .mockResolvedValueOnce(mockResults[1].data)
        .mockRejectedValueOnce(new Error(mockResults[2].error));

      const response = await request(app)
        .post('/admin/dlq/batch-retry')
        .send({ dlqIds });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual({
        results: mockResults,
        total: 3,
        successful: 2,
        failed: 1
      });

      expect(mockDlqService.retryDlqItem).toHaveBeenCalledTimes(3);
    });

    test('should return 400 when dlqIds is not an array', async () => {
      const response = await request(app)
        .post('/admin/dlq/batch-retry')
        .send({ dlqIds: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'dlqIds must be a non-empty array'
      });
    });

    test('should return 400 when dlqIds is empty', async () => {
      const response = await request(app)
        .post('/admin/dlq/batch-retry')
        .send({ dlqIds: [] });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'dlqIds must be a non-empty array'
      });
    });
  });

  describe('GET /admin/dlq/items', () => {
    test('should list DLQ items with filters', async () => {
      const mockItems = [
        { id: 'dlq_1', status: 'failed', error_category: 'xdr_parsing' },
        { id: 'dlq_2', status: 'retrying', error_category: 'validation' }
      ];

      mockDlqService.listDlqItems.mockResolvedValue(mockItems);

      const response = await request(app)
        .get('/admin/dlq/items')
        .query({
          status: 'failed',
          errorCategory: 'xdr_parsing',
          limit: 10,
          offset: 0
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          items: mockItems,
          pagination: {
            limit: 10,
            offset: 0,
            total: 2
          }
        }
      });

      expect(mockDlqService.listDlqItems).toHaveBeenCalledWith({
        status: 'failed',
        errorCategory: 'xdr_parsing',
        limit: 10,
        offset: 0,
        sortBy: 'created_at',
        sortOrder: 'DESC'
      });
    });

    test('should use default parameters', async () => {
      mockDlqService.listDlqItems.mockResolvedValue([]);

      const response = await request(app)
        .get('/admin/dlq/items');

      expect(response.status).toBe(200);
      expect(mockDlqService.listDlqItems).toHaveBeenCalledWith({
        status: null,
        errorCategory: null,
        limit: 50,
        offset: 0,
        sortBy: 'created_at',
        sortOrder: 'DESC'
      });
    });
  });

  describe('GET /admin/dlq/item/:dlqId', () => {
    test('should get DLQ item details', async () => {
      const dlqId = 'dlq_123';
      const mockItem = {
        id: dlqId,
        status: 'failed',
        error_category: 'xdr_parsing',
        transaction_hash: 'tx_123'
      };
      const mockRetryAttempts = [
        { attempt_number: 1, attempted_at: '2023-01-01T00:00:00Z', success: false },
        { attempt_number: 2, attempted_at: '2023-01-01T01:00:00Z', success: true }
      ];

      mockDlqService.getDlqItem.mockResolvedValue(mockItem);
      mockDlqService.getRetryAttempts.mockResolvedValue(mockRetryAttempts);

      const response = await request(app)
        .get(`/admin/dlq/item/${dlqId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          item: mockItem,
          retryAttempts: mockRetryAttempts
        }
      });

      expect(mockDlqService.getDlqItem).toHaveBeenCalledWith(dlqId);
      expect(mockDlqService.getRetryAttempts).toHaveBeenCalledWith(dlqId);
    });

    test('should return 404 when item not found', async () => {
      const dlqId = 'non-existent';
      mockDlqService.getDlqItem.mockResolvedValue(null);

      const response = await request(app)
        .get(`/admin/dlq/item/${dlqId}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: 'DLQ item not found'
      });
    });
  });

  describe('GET /admin/dlq/stats', () => {
    test('should get DLQ statistics', async () => {
      const mockStats = {
        itemsAdded: 100,
        itemsRetried: 20,
        itemsResolved: 15,
        database: {
          total_items: 50,
          failed_items: 30,
          retrying_items: 10
        }
      };

      mockDlqService.getStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/admin/dlq/stats');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: mockStats
      });

      expect(mockDlqService.getStats).toHaveBeenCalled();
    });
  });

  describe('POST /admin/dlq/resolve', () => {
    test('should mark DLQ item as resolved', async () => {
      const dlqId = 'dlq_123';
      const resolutionNotes = 'Manually resolved by admin';

      mockDlqService.markAsResolved.mockResolvedValue();

      const response = await request(app)
        .post('/admin/dlq/resolve')
        .send({ dlqId, resolutionNotes });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          dlqId,
          status: 'resolved',
          resolvedBy: 'admin',
          resolutionNotes
        }
      });

      expect(mockDlqService.markAsResolved).toHaveBeenCalledWith(
        dlqId,
        'admin',
        resolutionNotes
      );
    });

    test('should return 400 when dlqId is missing', async () => {
      const response = await request(app)
        .post('/admin/dlq/resolve')
        .send({ resolutionNotes: 'Some notes' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'dlqId is required'
      });
    });
  });

  describe('POST /admin/dlq/cleanup', () => {
    test('should trigger cleanup of expired items', async () => {
      mockDlqService.cleanupExpiredItems.mockResolvedValue();

      const response = await request(app)
        .post('/admin/dlq/cleanup');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'Cleanup completed'
      });

      expect(mockDlqService.cleanupExpiredItems).toHaveBeenCalled();
    });
  });

  describe('GET /admin/dlq/health', () => {
    test('should return healthy status when DLQ is working', async () => {
      const mockStats = {
        database: {
          total_items: 50,
          failed_items: 10
        }
      };

      mockDlqService.getStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/admin/dlq/health');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.healthy).toBe(true);
      expect(response.body.data.stats).toEqual(mockStats);
      expect(response.body.data.timestamp).toBeDefined();
    });

    test('should return degraded status when too many items', async () => {
      const mockStats = {
        database: {
          total_items: 1500, // Above threshold
          failed_items: 100
        }
      };

      mockDlqService.getStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/admin/dlq/health');

      expect(response.status).toBe(200);
      expect(response.body.data.healthy).toBe(false);
    });
  });
});
