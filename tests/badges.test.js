const request = require('supertest');
const app = require('../index');

describe('Badges API', () => {
  describe('GET /badges/user/:userAddress', () => {
    it('should get user badges', async () => {
      const response = await request(app)
        .get('/badges/user/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.badges).toBeDefined();
      expect(response.body.data.totalBadges).toBeDefined();
    });
  });

  describe('POST /badges/check-milestones/:userAddress', () => {
    it('should check user milestones', async () => {
      const response = await request(app)
        .post('/badges/check-milestones/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.newlyEarnedBadges).toBeDefined();
      expect(response.body.data.count).toBeDefined();
    });
  });

  describe('GET /badges/milestones', () => {
    it('should get all available milestones', async () => {
      const response = await request(app)
        .get('/badges/milestones');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.milestones).toBeDefined();
      expect(response.body.data.totalMilestones).toBeDefined();
      expect(Array.isArray(response.body.data.milestones)).toBe(true);
    });
  });

  describe('POST /badges/award', () => {
    it('should award badge manually', async () => {
      const response = await request(app)
        .post('/badges/award')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
          badgeId: 'early_adopter'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('should return error for missing data', async () => {
      const response = await request(app)
        .post('/badges/award')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('User address and badge ID are required');
    });
  });
});
