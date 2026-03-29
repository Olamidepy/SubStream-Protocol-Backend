const request = require('supertest');
const app = require('../index');

describe('Feed API', () => {
  describe('POST /feed/secret-url', () => {
    it('should generate secret feed URL', async () => {
      const response = await request(app)
        .post('/feed/secret-url')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
          contentType: 'podcast',
          format: 'rss'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.feedUrl).toBeDefined();
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.expiresAt).toBeDefined();
    });

    it('should return error for missing user address', async () => {
      const response = await request(app)
        .post('/feed/secret-url')
        .send({
          contentType: 'podcast'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('User address is required');
    });
  });

  describe('GET /feed/:userAddress/:token', () => {
    it('should return RSS feed for valid token', async () => {
      // First generate a token
      const tokenResponse = await request(app)
        .post('/feed/secret-url')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      const { token } = tokenResponse.body.data;

      // Then get the feed
      const response = await request(app)
        .get(`/feed/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/${token}`)
        .query({ format: 'rss', type: 'podcast' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
      expect(response.text).toContain('<?xml version="1.0"?>');
      expect(response.text).toContain('<rss');
    });

    it('should return Atom feed for valid token', async () => {
      // First generate a token
      const tokenResponse = await request(app)
        .post('/feed/secret-url')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      const { token } = tokenResponse.body.data;

      // Then get the feed
      const response = await request(app)
        .get(`/feed/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/${token}`)
        .query({ format: 'atom', type: 'podcast' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/atom+xml; charset=utf-8');
      expect(response.text).toContain('<?xml version="1.0"?>');
      expect(response.text).toContain('<feed');
    });

    it('should return error for invalid token', async () => {
      const response = await request(app)
        .get('/feed/0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45/invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid or expired access token');
    });
  });

  describe('POST /feed/rotate-token', () => {
    it('should rotate access token', async () => {
      const response = await request(app)
        .post('/feed/rotate-token')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.token).toBeDefined();
      expect(response.body.data.expiresAt).toBeDefined();
    });
  });

  describe('POST /feed/validate-token', () => {
    it('should validate token', async () => {
      // First generate a token
      const tokenResponse = await request(app)
        .post('/feed/secret-url')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45'
        });

      const { token } = tokenResponse.body.data;

      // Then validate it
      const response = await request(app)
        .post('/feed/validate-token')
        .send({
          userAddress: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
          token
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
    });
  });
});
