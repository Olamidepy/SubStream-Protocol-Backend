const request = require('supertest');
const { createApp } = require('./index');
const { SubscriptionService } = require('./src/services/subscriptionService');

describe('Subscription events and stats', () => {
  let app;
  let mockDb;
  let subscriptionService;

  beforeEach(() => {
    // Simple in-memory mock for the database methods used by subscription service
    const counts = new Map();
    const subs = new Map(); // key = `${creatorId}:${wallet}` -> active 1/0

    mockDb = {
      ensureCreator: (creatorId) => {
        if (!counts.has(creatorId)) counts.set(creatorId, 0);
      },
      getCreatorSubscriberCount: (creatorId) => {
        return counts.get(creatorId) || 0;
      },
      incrementCreatorSubscriberCount: (creatorId) => {
        mockDb.ensureCreator(creatorId);
        counts.set(creatorId, (counts.get(creatorId) || 0) + 1);
        return counts.get(creatorId);
      },
      decrementCreatorSubscriberCount: (creatorId) => {
        mockDb.ensureCreator(creatorId);
        const val = Math.max(0, (counts.get(creatorId) || 0) - 1);
        counts.set(creatorId, val);
        return val;
      },
      getSubscription: (creatorId, walletAddress) => {
        const key = `${creatorId}:${walletAddress}`;
        const active = subs.get(key);
        if (active === undefined) return null;
        return { creatorId, walletAddress, active };
      },
      createOrActivateSubscription: (creatorId, walletAddress) => {
        const key = `${creatorId}:${walletAddress}`;
        const prev = subs.get(key);
        if (prev === 1) return { changed: false, count: mockDb.getCreatorSubscriberCount(creatorId) };
        subs.set(key, 1);
        mockDb.incrementCreatorSubscriberCount(creatorId);
        return { changed: true, count: mockDb.getCreatorSubscriberCount(creatorId) };
      },
      deactivateSubscription: (creatorId, walletAddress) => {
        const key = `${creatorId}:${walletAddress}`;
        const prev = subs.get(key);
        if (prev !== 1) return { changed: false, count: mockDb.getCreatorSubscriberCount(creatorId) };
        subs.set(key, 0);
        mockDb.decrementCreatorSubscriberCount(creatorId);
        return { changed: true, count: mockDb.getCreatorSubscriberCount(creatorId) };
      },
    };

    subscriptionService = new SubscriptionService({ database: mockDb, auditLogService: { append: () => {} } });

    app = createApp({ database: mockDb, subscriptionService });
  });

  test('POST subscribed increments count and GET stats returns it', async () => {
    const res = await request(app)
      .post('/api/subscription/events')
      .send({ type: 'subscribed', creatorId: 'creator-1', walletAddress: 'W1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.creatorId).toBe('creator-1');
    expect(res.body.data.newCount).toBe(1);

    const stats = await request(app).get('/api/creator/creator-1/stats');
    expect(stats.statusCode).toBe(200);
    expect(stats.body.success).toBe(true);
    expect(stats.body.data.subscriberCount).toBe(1);
  });

  test('POST unsubscribed decrements count', async () => {
    // subscribe twice (second is idempotent)
    await request(app).post('/api/subscription/events').send({ type: 'subscribed', creatorId: 'creator-2', walletAddress: 'W2' });
    await request(app).post('/api/subscription/events').send({ type: 'subscribed', creatorId: 'creator-2', walletAddress: 'W2' });

    const res = await request(app).post('/api/subscription/events').send({ type: 'unsubscribed', creatorId: 'creator-2', walletAddress: 'W2' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.newCount).toBe(0);

    const stats = await request(app).get('/api/creator/creator-2/stats');
    expect(stats.body.data.subscriberCount).toBe(0);
  });
});
