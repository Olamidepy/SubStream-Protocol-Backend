const GlobalStatsService = require('./src/services/globalStatsService');
const GlobalStatsWorker = require('./src/services/globalStatsWorker');
const { AppDatabase } = require('./src/db/appDatabase');

// Mock Redis for testing
const mockRedis = {
  data: new Map(),
  get: jest.fn((key) => {
    return Promise.resolve(mockRedis.data.get(key) || null);
  }),
  setex: jest.fn((key, ttl, value) => {
    mockRedis.data.set(key, value);
    return Promise.resolve('OK');
  }),
  del: jest.fn((...keys) => {
    keys.forEach(key => mockRedis.data.delete(key));
    return Promise.resolve(keys.length);
  }),
  ttl: jest.fn((key) => {
    return Promise.resolve(mockRedis.data.has(key) ? 45 : -2);
  }),
  pipeline: jest.fn(() => ({
    setex: jest.fn(),
    exec: jest.fn(() => Promise.resolve([]))
  }))
};

// Mock database
const mockDatabase = {
  db: {
    prepare: jest.fn(() => ({
      get: jest.fn(() => ({ totalFlow: 1000, totalUsers: 500, totalCreators: 50, totalVideos: 200, totalSubscriptions: 300 })),
      all: jest.fn(() => [
        { id: 'creator1', subscriber_count: 100, video_count: 10, latest_video_date: '2024-01-15T10:00:00Z' },
        { id: 'creator2', subscriber_count: 80, video_count: 8, latest_video_date: '2024-01-14T15:30:00Z' }
      ])
    }))
  })
};

describe('GlobalStatsService', () => {
  let globalStatsService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.data.clear();
    globalStatsService = new GlobalStatsService(mockDatabase, mockRedis);
  });

  describe('getCachedStats', () => {
    it('should return null when cache is empty', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      const result = await globalStatsService.getCachedStats();
      
      expect(result).toBeNull();
    });

    it('should return cached stats when cache has data', async () => {
      const cachedData = {
        totalValueLocked: 1000,
        trendingCreators: [{ id: 'creator1', subscriberCount: 100 }],
        totalUsers: 500,
        totalCreators: 50,
        totalVideos: 200,
        totalSubscriptions: 300,
        lastUpdated: '2024-01-15T10:00:00Z'
      };

      mockRedis.get.mockImplementation((key) => {
        const data = {
          'global_stats:tvl': JSON.stringify(cachedData.totalValueLocked),
          'global_stats:trending_creators': JSON.stringify(cachedData.trendingCreators),
          'global_stats:total_users': cachedData.totalUsers.toString(),
          'global_stats:total_creators': cachedData.totalCreators.toString(),
          'global_stats:total_videos': cachedData.totalVideos.toString(),
          'global_stats:total_subscriptions': cachedData.totalSubscriptions.toString(),
          'global_stats:last_updated': cachedData.lastUpdated
        };
        return Promise.resolve(data[key] || null);
      });

      const result = await globalStatsService.getCachedStats();
      
      expect(result).toEqual(cachedData);
    });
  });

  describe('computeFreshStats', () => {
    it('should compute fresh statistics from database', async () => {
      const result = await globalStatsService.computeFreshStats();
      
      expect(result).toHaveProperty('totalValueLocked');
      expect(result).toHaveProperty('trendingCreators');
      expect(result).toHaveProperty('totalUsers');
      expect(result).toHaveProperty('totalCreators');
      expect(result).toHaveProperty('totalVideos');
      expect(result).toHaveProperty('totalSubscriptions');
      expect(result).toHaveProperty('lastUpdated');
      
      expect(typeof result.totalValueLocked).toBe('number');
      expect(Array.isArray(result.trendingCreators)).toBe(true);
      expect(typeof result.totalUsers).toBe('number');
    });
  });

  describe('cacheStats', () => {
    it('should cache statistics with TTL', async () => {
      const stats = {
        totalValueLocked: 1000,
        trendingCreators: [{ id: 'creator1' }],
        totalUsers: 500,
        totalCreators: 50,
        totalVideos: 200,
        totalSubscriptions: 300,
        lastUpdated: '2024-01-15T10:00:00Z'
      };

      await globalStatsService.cacheStats(stats);
      
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });
  });

  describe('getGlobalStats', () => {
    it('should return cached stats when available', async () => {
      const cachedStats = {
        totalValueLocked: 1000,
        trendingCreators: [],
        totalUsers: 500,
        totalCreators: 50,
        totalVideos: 200,
        totalSubscriptions: 300,
        lastUpdated: '2024-01-15T10:00:00Z'
      };

      mockRedis.get.mockImplementation((key) => {
        if (key === 'global_stats:tvl') return Promise.resolve(JSON.stringify(cachedStats.totalValueLocked));
        return Promise.resolve(null);
      });

      jest.spyOn(globalStatsService, 'getCachedStats').mockResolvedValue(cachedStats);
      
      const result = await globalStatsService.getGlobalStats();
      
      expect(result).toEqual(cachedStats);
      expect(globalStatsService.getCachedStats).toHaveBeenCalled();
    });

    it('should compute and cache fresh stats when cache is empty', async () => {
      const freshStats = {
        totalValueLocked: 1000,
        trendingCreators: [],
        totalUsers: 500,
        totalCreators: 50,
        totalVideos: 200,
        totalSubscriptions: 300,
        lastUpdated: '2024-01-15T10:00:00Z'
      };

      jest.spyOn(globalStatsService, 'getCachedStats').mockResolvedValue(null);
      jest.spyOn(globalStatsService, 'computeAndCacheStats').mockResolvedValue(freshStats);
      
      const result = await globalStatsService.getGlobalStats();
      
      expect(result).toEqual(freshStats);
      expect(globalStatsService.getCachedStats).toHaveBeenCalled();
      expect(globalStatsService.computeAndCacheStats).toHaveBeenCalled();
    });
  });

  describe('calculateTrendingScore', () => {
    it('should calculate trending score correctly', () => {
      const creator = {
        subscriber_count: 100,
        video_count: 10,
        latest_video_date: '2024-01-15T10:00:00Z'
      };

      const score = globalStatsService.calculateTrendingScore(creator);
      
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThan(0);
    });

    it('should handle creator without latest video', () => {
      const creator = {
        subscriber_count: 100,
        video_count: 10,
        latest_video_date: null
      };

      const score = globalStatsService.calculateTrendingScore(creator);
      
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('GlobalStatsWorker', () => {
  let globalStatsWorker;
  let mockGlobalStatsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    mockGlobalStatsService = {
      refreshCache: jest.fn().mockResolvedValue({
        totalCreators: 50,
        totalUsers: 500,
        totalVideos: 200,
        totalSubscriptions: 300,
        trendingCreators: []
      })
    };
    
    globalStatsWorker = new GlobalStatsWorker(mockDatabase);
    globalStatsWorker.globalStatsService = mockGlobalStatsService;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('start', () => {
    it('should start the worker with initial delay', () => {
      globalStatsWorker.start();
      
      expect(globalStatsWorker.isRunning).toBe(true);
      
      // Fast-forward past initial delay
      jest.advanceTimersByTime(5000);
      
      expect(mockGlobalStatsService.refreshCache).toHaveBeenCalled();
    });

    it('should not start if already running', () => {
      globalStatsWorker.start();
      globalStatsWorker.start();
      
      expect(globalStatsWorker.isRunning).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop the worker', () => {
      globalStatsWorker.start();
      globalStatsWorker.stop();
      
      expect(globalStatsWorker.isRunning).toBe(false);
    });

    it('should handle stopping when not running', () => {
      globalStatsWorker.stop();
      
      expect(globalStatsWorker.isRunning).toBe(false);
    });
  });

  describe('refreshCache', () => {
    it('should refresh cache successfully', async () => {
      globalStatsWorker.start();
      
      jest.advanceTimersByTime(5000); // Trigger initial refresh
      
      await jest.runAllTimersAsync();
      
      expect(mockGlobalStatsService.refreshCache).toHaveBeenCalled();
    });

    it('should handle errors and implement backoff', async () => {
      mockGlobalStatsService.refreshCache.mockRejectedValue(new Error('Database error'));
      
      globalStatsWorker.start();
      
      jest.advanceTimersByTime(5000); // Trigger initial refresh
      await jest.runAllTimersAsync();
      
      expect(globalStatsWorker.errorCount).toBe(1);
      expect(globalStatsWorker.currentInterval).toBeGreaterThan(60000);
    });

    it('should stop after max errors', async () => {
      mockGlobalStatsService.refreshCache.mockRejectedValue(new Error('Database error'));
      
      globalStatsWorker.start();
      
      // Trigger multiple errors
      for (let i = 0; i < 5; i++) {
        jest.advanceTimersByTime(globalStatsWorker.currentInterval);
        await jest.runAllTimersAsync();
      }
      
      expect(globalStatsWorker.isRunning).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return worker status', () => {
      const status = globalStatsWorker.getStatus();
      
      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('refreshInterval');
      expect(status).toHaveProperty('currentInterval');
      expect(status).toHaveProperty('errorCount');
      expect(status).toHaveProperty('maxErrors');
    });
  });

  describe('resetErrors', () => {
    it('should reset error count and interval', () => {
      globalStatsWorker.errorCount = 3;
      globalStatsWorker.currentInterval = 120000;
      
      globalStatsWorker.resetErrors();
      
      expect(globalStatsWorker.errorCount).toBe(0);
      expect(globalStatsWorker.currentInterval).toBe(60000);
    });
  });
});
