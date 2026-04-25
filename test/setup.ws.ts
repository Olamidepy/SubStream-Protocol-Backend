import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';

// Mock Redis for testing
jest.mock('../src/redis/redis.service');

beforeAll(async () => {
  // Setup test environment
  process.env.JWT_SECRET = 'test-secret';
  process.env.REDIS_PUBSUB_URL = 'redis://localhost:6379/1'; // Use different DB for tests
});

afterAll(async () => {
  // Cleanup test environment
  delete process.env.JWT_SECRET;
  delete process.env.REDIS_PUBSUB_URL;
});

// Mock Redis methods globally
const mockRedisService = {
  publish: jest.fn().mockResolvedValue(true),
  subscribe: jest.fn().mockResolvedValue(true),
  unsubscribe: jest.fn().mockResolvedValue(true),
  getPublisherStatus: jest.fn().mockReturnValue('ready'),
  getSubscriberStatus: jest.fn().mockReturnValue('ready'),
  onModuleInit: jest.fn().mockResolvedValue(undefined),
  onModuleDestroy: jest.fn().mockResolvedValue(undefined),
};

(RedisService as jest.MockedClass<typeof RedisService>).mockImplementation(() => mockRedisService as any);
