const { IPIntelligenceService } = require('../src/services/ipIntelligenceService');
const { IPIntelligenceMiddleware } = require('../src/middleware/ipIntelligenceMiddleware');
const { IPBlockingService } = require('../src/services/ipBlockingService');
const { IPMonitoringService } = require('../src/services/ipMonitoringService');

describe('IP Intelligence System', () => {
  let ipIntelligenceService;
  let ipMiddleware;
  let ipBlockingService;
  let ipMonitoringService;
  let mockDatabase;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn(),
        exec: jest.fn()
      }
    };

    // Mock configuration
    const mockConfig = {
      providers: {
        ipinfo: { enabled: false },
        maxmind: { enabled: false },
        abuseipdb: { enabled: false },
        ipqualityscore: { enabled: false }
      },
      riskThresholds: {
        low: 30,
        medium: 60,
        high: 80,
        critical: 90
      },
      cache: {
        enabled: true,
        ttl: 3600000,
        maxSize: 1000
      }
    };

    // Initialize services
    ipIntelligenceService = new IPIntelligenceService(mockConfig);
    ipMiddleware = new IPIntelligenceMiddleware(ipIntelligenceService, {});
    ipBlockingService = new IPBlockingService(mockDatabase, {});
    ipMonitoringService = new IPMonitoringService(mockDatabase, {});

    // Mock database methods
    mockDatabase.db.prepare.mockReturnValue({
      get: jest.fn(),
      all: jest.fn(),
      run: jest.fn()
    });
  });

  describe('IPIntelligenceService', () => {
    describe('IP Validation', () => {
      test('should validate valid IPv4 addresses', () => {
        expect(ipIntelligenceService.isValidIP('192.168.1.1')).toBe(true);
        expect(ipIntelligenceService.isValidIP('8.8.8.8')).toBe(true);
        expect(ipIntelligenceService.isValidIP('255.255.255.255')).toBe(true);
      });

      test('should validate valid IPv6 addresses', () => {
        expect(ipIntelligenceService.isValidIP('::1')).toBe(true);
        expect(ipIntelligenceService.isValidIP('2001:db8::1')).toBe(true);
      });

      test('should reject invalid IP addresses', () => {
        expect(ipIntelligenceService.isValidIP('invalid')).toBe(false);
        expect(ipIntelligenceService.isValidIP('999.999.999.999')).toBe(false);
        expect(ipIntelligenceService.isValidIP('')).toBe(false);
      });
    });

    describe('Private IP Detection', () => {
      test('should detect private IPv4 addresses', () => {
        expect(ipIntelligenceService.isPrivateIP('192.168.1.1')).toBe(true);
        expect(ipIntelligenceService.isPrivateIP('10.0.0.1')).toBe(true);
        expect(ipIntelligenceService.isPrivateIP('172.16.0.1')).toBe(true);
        expect(ipIntelligenceService.isPrivateIP('127.0.0.1')).toBe(true);
      });

      test('should detect private IPv6 addresses', () => {
        expect(ipIntelligenceService.isPrivateIP('::1')).toBe(true);
        expect(ipIntelligenceService.isPrivateIP('fc00::')).toBe(true);
        expect(ipIntelligenceService.isPrivateIP('fe80::')).toBe(true);
      });

      test('should not detect public IPs as private', () => {
        expect(ipIntelligenceService.isPrivateIP('8.8.8.8')).toBe(false);
        expect(ipIntelligenceService.isPrivateIP('1.1.1.1')).toBe(false);
      });
    });

    describe('Risk Assessment', () => {
      test('should create invalid IP result for invalid addresses', async () => {
        const result = await ipIntelligenceService.assessIPRisk('invalid');
        
        expect(result.riskScore).toBe(100);
        expect(result.riskLevel).toBe('critical');
        expect(result.riskFactors).toContain('Invalid IP address format');
      });

      test('should create private IP result for private addresses', async () => {
        const result = await ipIntelligenceService.assessIPRisk('192.168.1.1');
        
        expect(result.riskScore).toBe(0);
        expect(result.riskLevel).toBe('minimal');
        expect(result.riskFactors).toContain('Private/internal IP address');
      });

      test('should handle API errors gracefully', async () => {
        // Mock all providers to fail
        jest.spyOn(ipIntelligenceService, 'collectProviderData').mockRejectedValue(new Error('API Error'));
        
        const result = await ipIntelligenceService.assessIPRisk('8.8.8.8');
        
        expect(result.riskScore).toBe(50);
        expect(result.riskLevel).toBe('medium');
        expect(result.riskFactors).toContain('Assessment failed - using default risk');
      });

      test('should use cached results when available', async () => {
        const ipAddress = '8.8.8.8';
        
        // First call
        const result1 = await ipIntelligenceService.assessIPRisk(ipAddress);
        
        // Second call should use cache
        const result2 = await ipIntelligenceService.assessIPRisk(ipAddress);
        
        expect(result1).toEqual(result2);
        expect(ipIntelligenceService.getCachedResult(ipAddress)).toBeDefined();
      });
    });

    describe('Risk Level Calculation', () => {
      test('should calculate correct risk levels', () => {
        expect(ipIntelligenceService.getRiskLevel(95)).toBe('critical');
        expect(ipIntelligenceService.getRiskLevel(85)).toBe('high');
        expect(ipIntelligenceService.getRiskLevel(70)).toBe('medium');
        expect(ipIntelligenceService.getRiskLevel(40)).toBe('low');
        expect(ipIntelligenceService.getRiskLevel(20)).toBe('minimal');
      });
    });

    describe('Rate Limiting', () => {
      test('should enforce rate limits', () => {
        // Fill rate limit bucket
        for (let i = 0; i < 150; i++) {
          ipIntelligenceService.checkRateLimit();
        }
        
        // Should be rate limited now
        expect(ipIntelligenceService.checkRateLimit()).toBe(false);
      });

      test('should reset rate limit after time passes', () => {
        // Fill rate limit bucket
        for (let i = 0; i < 150; i++) {
          ipIntelligenceService.checkRateLimit();
        }
        
        // Mock time passing
        const originalTimestamps = ipIntelligenceService.requestTimestamps;
        ipIntelligenceService.requestTimestamps = originalTimestamps.map(ts => ts - 70000); // 70 seconds ago
        
        // Should be allowed now
        expect(ipIntelligenceService.checkRateLimit()).toBe(true);
      });
    });

    describe('Cache Management', () => {
      test('should cache results', async () => {
        const ipAddress = '8.8.8.8';
        const result = await ipIntelligenceService.assessIPRisk(ipAddress);
        
        expect(ipIntelligenceService.getCachedResult(ipAddress)).toEqual(result);
      });

      test('should clean up expired cache entries', async () => {
        // Add expired cache entry
        const ipAddress = '8.8.8.8';
        ipIntelligenceService.cacheResult(ipAddress, { riskScore: 50 });
        
        // Mock expired timestamp
        ipIntelligenceService.cacheTimestamps.set(ipAddress, Date.now() - 4000000); // 70 minutes ago
        
        // Clean up should remove expired entry
        ipIntelligenceService.cleanupCache();
        
        expect(ipIntelligenceService.getCachedResult(ipAddress)).toBeNull();
      });

      test('should limit cache size', async () => {
        // Fill cache beyond limit
        for (let i = 0; i < 150; i++) {
          ipIntelligenceService.cacheResult(`192.168.1.${i}`, { riskScore: i });
        }
        
        const stats = ipIntelligenceService.getCacheStats();
        expect(stats.size).toBeLessThanOrEqual(1000);
      });
    });
  });

  describe('IPIntelligenceMiddleware', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
      mockReq = {
        ip: '192.168.1.1',
        get: jest.fn(),
        logger: { fields: { traceId: 'test-trace-123' } }
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };
      mockNext = jest.fn();
    });

    describe('SIWS Middleware', () => {
      test('should allow private IPs in SIWS flow', async () => {
        const middleware = ipMiddleware.createSIWSMiddleware();
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.ipIntelligence).toBeDefined();
        expect(mockReq.ipIntelligence.riskLevel).toBe('minimal');
      });

      test('should block high risk IPs in SIWS flow', async () => {
        mockReq.ip = '8.8.8.8';
        
        // Mock high risk assessment
        jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
          riskScore: 95,
          riskLevel: 'critical',
          riskFactors: ['Tor exit node']
        });
        
        const middleware = ipMiddleware.createSIWSMiddleware();
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockRes.json).toHaveBeenCalledWith({
          success: false,
          error: 'Access denied due to security restrictions',
          code: 'IP_BLOCKED',
          metadata: {
            riskLevel: 'critical',
            reason: 'High risk IP detected during authentication'
          }
        });
      });

      test('should require additional verification for medium risk IPs', async () => {
        mockReq.ip = '8.8.8.8';
        
        // Mock medium risk assessment
        jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
          riskScore: 70,
          riskLevel: 'medium',
          riskFactors: ['VPN detected']
        });
        
        const middleware = ipMiddleware.createSIWSMiddleware();
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(429);
        expect(mockRes.json).toHaveBeenCalledWith({
          success: false,
          error: 'Additional verification required',
          code: 'IP_RESTRICTED',
          metadata: {
            riskLevel: 'medium',
            requiresAdditionalVerification: true,
            allowedActions: expect.any(Array)
          }
        });
      });

      test('should handle assessment errors gracefully', async () => {
        mockReq.ip = '8.8.8.8';
        
        // Mock assessment error
        jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockRejectedValue(new Error('API Error'));
        
        const middleware = ipMiddleware.createSIWSMiddleware();
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).toHaveBeenCalled(); // Fail safe - allow
        expect(mockReq.ipIntelligence.error).toBeDefined();
      });
    });

    describe('General Middleware', () => {
      test('should allow low risk actions', async () => {
        mockReq.ip = '8.8.8.8';
        
        // Mock low risk assessment
        jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
          riskScore: 25,
          riskLevel: 'low',
          riskFactors: []
        });
        
        const middleware = ipMiddleware.createGeneralMiddleware('create_subscription');
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.ipIntelligence.riskLevel).toBe('low');
      });

      test('should block high risk actions', async () => {
        mockReq.ip = '8.8.8.8';
        
        // Mock high risk assessment
        jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
          riskScore: 85,
          riskLevel: 'high',
          riskFactors: ['Tor exit node']
        });
        
        const middleware = ipMiddleware.createGeneralMiddleware('create_creator');
        
        await middleware(mockReq, mockRes, mockNext);
        
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
      });
    });

    describe('Risk Level Comparison', () => {
      test('should compare risk levels correctly', () => {
        expect(ipMiddleware.compareRiskLevels('high', 'medium')).toBeGreaterThan(0);
        expect(ipMiddleware.compareRiskLevels('low', 'high')).toBeLessThan(0);
        expect(ipMiddleware.compareRiskLevels('medium', 'medium')).toBe(0);
      });
    });

    describe('Action Permission', () => {
      test('should allow appropriate actions for risk levels', () => {
        expect(ipMiddleware.isActionAllowed('view_content', 'low')).toBe(true);
        expect(ipMiddleware.isActionAllowed('view_content', 'high')).toBe(true);
        expect(ipMiddleware.isActionAllowed('create_creator', 'high')).toBe(false);
        expect(ipMiddleware.isActionAllowed('create_creator', 'critical')).toBe(false);
      });
    });
  });

  describe('IPBlockingService', () => {
    describe('Block Evaluation', () => {
      test('should block IPs exceeding threshold', async () => {
        const riskAssessment = {
          riskScore: 95,
          riskLevel: 'critical',
          riskFactors: ['Tor exit node']
        };
        
        const decision = await ipBlockingService.evaluateIP('8.8.8.8', riskAssessment, {
          actionType: 'create_creator'
        });
        
        expect(decision.action).toBe('temporary'); // or 'permanent'
        expect(decision.reason).toContain('High risk score');
      });

      test('should restrict medium risk IPs', async () => {
        const riskAssessment = {
          riskScore: 70,
          riskLevel: 'medium',
          riskFactors: ['VPN detected']
        };
        
        const decision = await ipBlockingService.evaluateIP('8.8.8.8', riskAssessment);
        
        expect(decision.action).toBe('restrict');
        expect(decision.reason).toContain('Elevated risk score');
      });

      test('should allow low risk IPs', async () => {
        const riskAssessment = {
          riskScore: 25,
          riskLevel: 'low',
          riskFactors: []
        };
        
        const decision = await ipBlockingService.evaluateIP('8.8.8.8', riskAssessment);
        
        expect(decision.action).toBe('allow');
      });
    });

    describe('Manual Blocking', () => {
      test('should manually block IP', async () => {
        const result = await ipBlockingService.manualBlockIP('8.8.8.8', {
          type: 'temporary',
          duration: 3600000, // 1 hour
          reason: 'Test block'
        });
        
        expect(result.success).toBe(true);
        expect(result.blockId).toBeDefined();
        expect(result.type).toBe('temporary');
      });

      test('should manually unblock IP', async () => {
        // First block
        await ipBlockingService.manualBlockIP('8.8.8.8');
        
        // Then unblock
        const result = await ipBlockingService.manualUnblockIP('8.8.8.8', 'Test unblock');
        
        expect(result.success).toBe(true);
        expect(result.reason).toBe('Test unblock');
      });
    });

    describe('Block Status', () => {
      test('should check if IP is blocked', () => {
        // Block an IP first
        ipBlockingService.activeBlocks.set('8.8.8.8', {
          block_type: 'temporary',
          reason: 'Test block',
          expires_at: new Date(Date.now() + 3600000).toISOString()
        });
        
        const blockInfo = ipBlockingService.isIPBlocked('8.8.8.8');
        
        expect(blockInfo).toBeDefined();
        expect(blockInfo.blockType).toBe('temporary');
        expect(blockInfo.reason).toBe('Test block');
      });

      test('should return null for unblocked IPs', () => {
        const blockInfo = ipBlockingService.isIPBlocked('1.1.1.1');
        
        expect(blockInfo).toBeNull();
      });
    });

    describe('Statistics', () => {
      test('should provide blocking statistics', () => {
        // Add some blocks
        ipBlockingService.activeBlocks.set('8.8.8.8', {
          block_type: 'temporary',
          risk_level: 'high'
        });
        ipBlockingService.activeBlocks.set('1.1.1.1', {
          block_type: 'permanent',
          risk_level: 'critical'
        });
        
        const stats = ipBlockingService.getBlockingStats();
        
        expect(stats.activeBlocks).toBe(2);
        expect(stats.blockTypes.temporary).toBe(1);
        expect(stats.blockTypes.permanent).toBe(1);
        expect(stats.riskLevels.high).toBe(1);
        expect(stats.riskLevels.critical).toBe(1);
      });
    });
  });

  describe('IPMonitoringService', () => {
    describe('Event Recording', () => {
      test('should record monitoring events', async () => {
        await ipMonitoringService.recordEvent('8.8.8.8', 'risk_assessment', {
          riskScore: 75,
          riskLevel: 'medium'
        });
        
        expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO ip_monitoring_events'),
          expect.any(Array)
        );
      });
    });

    describe('Analytics Generation', () => {
      test('should generate analytics data', async () => {
        // Mock database responses
        mockDatabase.db.prepare.mockReturnValue({
          get: jest.fn().mockReturnValue({
            total_events: 100,
            unique_ips: 50,
            avg_risk_score: 45.5,
            max_risk_score: 95,
            high_risk_events: 10,
            blocks: 5,
            violations: 3
          }),
          all: jest.fn().mockReturnValue([
            { risk_level: 'medium', count: 50 },
            { risk_level: 'high', count: 30 },
            { risk_level: 'low', count: 20 }
          ])
        });

        const analytics = await ipMonitoringService.getAnalytics({ period: '24h' });
        
        expect(analytics).toBeDefined();
        expect(analytics.summary).toBeDefined();
        expect(analytics.riskDistribution).toBeDefined();
      });
    });

    describe('Monitoring Status', () => {
      test('should provide monitoring status', () => {
        const status = ipMonitoringService.getMonitoringStatus();
        
        expect(status).toBeDefined();
        expect(status.isRunning).toBe(false); // Not started
        expect(status.config).toBeDefined();
      });
    });

    describe('Service Lifecycle', () => {
      test('should start monitoring service', async () => {
        await ipMonitoringService.start();
        
        expect(ipMonitoringService.isRunning).toBe(true);
        expect(ipMonitoringService.monitoringTimer).toBeDefined();
      });

      test('should stop monitoring service', async () => {
        await ipMonitoringService.start();
        await ipMonitoringService.stop();
        
        expect(ipMonitoringService.isRunning).toBe(false);
        expect(ipMonitoringService.monitoringTimer).toBeNull();
      });
    });
  });

  describe('Integration Tests', () => {
    test('should handle complete IP intelligence workflow', async () => {
      const ipAddress = '8.8.8.8';
      
      // 1. Assess IP risk
      const riskAssessment = await ipIntelligenceService.assessIPRisk(ipAddress);
      expect(riskAssessment).toBeDefined();
      
      // 2. Evaluate for blocking
      const blockDecision = await ipBlockingService.evaluateIP(ipAddress, riskAssessment);
      expect(blockDecision).toBeDefined();
      
      // 3. Record monitoring event
      await ipMonitoringService.recordEvent(ipAddress, 'risk_assessment', riskAssessment);
      
      // 4. Check if blocked
      const isBlocked = ipBlockingService.isIPBlocked(ipAddress);
      expect(typeof isBlocked).toBe('boolean');
    });

    test('should handle SIWS flow with IP intelligence', async () => {
      const mockReq = {
        ip: '8.8.8.8',
        get: jest.fn(),
        logger: { fields: { traceId: 'test-trace-456' } }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };
      const mockNext = jest.fn();

      // Mock low risk assessment
      jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
        riskScore: 25,
        riskLevel: 'low',
        riskFactors: []
      });

      const middleware = ipMiddleware.createSIWSMiddleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.ipIntelligence).toBeDefined();
      expect(mockReq.ipIntelligence.riskLevel).toBe('low');
    });

    test('should handle high risk IP in SIWS flow', async () => {
      const mockReq = {
        ip: '8.8.8.8',
        get: jest.fn(),
        logger: { fields: { traceId: 'test-trace-789' } }
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };
      const mockNext = jest.fn();

      // Mock high risk assessment
      jest.spyOn(ipIntelligenceService, 'assessIPRisk').mockResolvedValue({
        riskScore: 95,
        riskLevel: 'critical',
        riskFactors: ['Tor exit node']
      });

      const middleware = ipMiddleware.createSIWSMiddleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Access denied due to security restrictions',
        code: 'IP_BLOCKED',
        metadata: {
          riskLevel: 'critical',
          reason: 'High risk IP detected during authentication'
        }
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle database errors gracefully', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(ipMonitoringService.recordEvent('8.8.8.8', 'test', {}))
        .rejects.toThrow('Database error');
    });

    test('should handle network errors gracefully', async () => {
      // Mock network error
      jest.spyOn(ipIntelligenceService, 'collectProviderData').mockRejectedValue(new Error('Network error'));

      const result = await ipIntelligenceService.assessIPRisk('8.8.8.8');
      
      expect(result.riskScore).toBe(50);
      expect(result.riskLevel).toBe('medium');
      expect(result.riskFactors).toContain('Assessment failed - using default risk');
    });
  });

  describe('Performance', () => {
    test('should handle concurrent requests', async () => {
      const promises = [];
      
      // Create multiple concurrent requests
      for (let i = 0; i < 10; i++) {
        promises.push(ipIntelligenceService.assessIPRisk(`192.168.1.${i}`));
      }
      
      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.ipAddress).toMatch(/^192\.168\.1\.\d+$/);
      });
    });

    test('should use cache efficiently', async () => {
      const ipAddress = '8.8.8.8';
      
      // First request
      const start1 = Date.now();
      await ipIntelligenceService.assessIPRisk(ipAddress);
      const duration1 = Date.now() - start1;
      
      // Second request (should use cache)
      const start2 = Date.now();
      await ipIntelligenceService.assessIPRisk(ipAddress);
      const duration2 = Date.now() - start2;
      
      // Cached request should be much faster
      expect(duration2).toBeLessThan(duration1 / 2);
    });
  });
});
