const request = require('supertest');
const app = require('../index');

describe('Tax API', () => {
  describe('GET /tax/report/:creatorAddress/:year', () => {
    it('should generate tax report', async () => {
      const response = await request(app)
        .get('/tax/report/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/2024');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.creatorAddress).toBeDefined();
      expect(response.body.data.year).toBeDefined();
      expect(response.body.data.reportData).toBeDefined();
      expect(response.body.data.summary).toBeDefined();
    });
  });

  describe('GET /tax/summary/:creatorAddress/:year', () => {
    it('should get tax summary', async () => {
      const response = await request(app)
        .get('/tax/summary/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/2024');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.creatorAddress).toBeDefined();
      expect(response.body.data.year).toBeDefined();
      expect(response.body.data.summary).toBeDefined();
    });
  });

  describe('GET /tax/years/:creatorAddress', () => {
    it('should get available years', async () => {
      const response = await request(app)
        .get('/tax/years/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.creatorAddress).toBeDefined();
      expect(response.body.data.availableYears).toBeDefined();
      expect(Array.isArray(response.body.data.availableYears)).toBe(true);
    });
  });

  describe('GET /tax/csv/:creatorAddress/:year', () => {
    it('should generate CSV download', async () => {
      const response = await request(app)
        .get('/tax/csv/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/2024');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.text).toContain('Transaction ID');
      expect(response.text).toContain('Date');
      expect(response.text).toContain('Asset');
    });
  });
});
