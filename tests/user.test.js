const request = require('supertest');
const app = require('../index');

describe('User API', () => {
  describe('GET /user/summary/:userAddress', () => {
    it('should get user data summary', async () => {
      const response = await request(app)
        .get('/user/summary/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.userAddress).toBeDefined();
      expect(response.body.data.dataSummary).toBeDefined();
      expect(response.body.data.estimatedSize).toBeDefined();
    });
  });

  describe('POST /user/export', () => {
    it('should export user data', async () => {
      const response = await request(app)
        .post('/user/export')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.filename).toBeDefined();
      expect(response.body.data.downloadUrl).toBeDefined();
      expect(response.body.data.size).toBeDefined();
    });

    it('should return error for missing user address', async () => {
      const response = await request(app)
        .post('/user/export')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('User address is required');
    });
  });

  describe('POST /user/delete', () => {
    it('should require explicit confirmation', async () => {
      const response = await request(app)
        .post('/user/delete')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Explicit confirmation required. Send "DELETE_MY_DATA" in the confirmation field.');
    });

    it('should delete user data with confirmation', async () => {
      const response = await request(app)
        .post('/user/delete')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
          confirmation: 'DELETE_MY_DATA'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.operations).toBeDefined();
      expect(response.body.data.deletionDate).toBeDefined();
    });
  });

  describe('POST /user/cleanup-exports', () => {
    it('should cleanup expired exports', async () => {
      const response = await request(app)
        .post('/user/cleanup-exports');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.cleanedUpFiles).toBeDefined();
      expect(response.body.data.count).toBeDefined();
    });
  });
});
