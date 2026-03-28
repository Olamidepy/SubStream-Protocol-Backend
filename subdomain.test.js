const { AppDatabase } = require('../src/db/appDatabase');
const { SubdomainService } = require('../src/services/subdomainService');
const { SubdomainMiddleware } = require('../src/middleware/subdomainMiddleware');
const { loadConfig } = require('../src/config');

describe('Subdomain Service', () => {
  let database;
  let subdomainService;
  let config;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    config = loadConfig();
    subdomainService = new SubdomainService(database, config);
  });

  afterEach(() => {
    if (database && database.db) {
      database.db.close();
    }
  });

  describe('createSubdomain', () => {
    it('should create a subdomain for a creator', () => {
      const creatorId = 'test-creator-123';
      const subdomain = 'testcreator';
      
      const result = subdomainService.createSubdomain({
        creatorId,
        subdomain
      });

      expect(result).toBeDefined();
      expect(result.creatorId).toBe(creatorId);
      expect(result.subdomain).toBe(subdomain);
      expect(result.status).toBe('active');
    });

    it('should throw error for reserved subdomain', () => {
      expect(() => {
        subdomainService.createSubdomain({
          creatorId: 'test-creator-123',
          subdomain: 'www'
        });
      }).toThrow('www" is a reserved subdomain');
    });

    it('should throw error for invalid subdomain format', () => {
      expect(() => {
        subdomainService.createSubdomain({
          creatorId: 'test-creator-123',
          subdomain: 'invalid_domain'
        });
      }).toThrow('can only contain letters, numbers, and hyphens');
    });

    it('should throw error for duplicate subdomain', () => {
      const creatorId1 = 'test-creator-123';
      const creatorId2 = 'test-creator-456';
      const subdomain = 'duplicate';
      
      subdomainService.createSubdomain({ creatorId: creatorId1, subdomain });
      
      expect(() => {
        subdomainService.createSubdomain({ creatorId: creatorId2, subdomain });
      }).toThrow('already taken');
    });
  });

  describe('isSubdomainAvailable', () => {
    it('should return true for available subdomain', () => {
      const result = subdomainService.isSubdomainAvailable('available123');
      expect(result).toBe(true);
    });

    it('should return false for reserved subdomain', () => {
      const result = subdomainService.isSubdomainAvailable('api');
      expect(result).toBe(false);
    });

    it('should return false for taken subdomain', () => {
      subdomainService.createSubdomain({
        creatorId: 'test-creator-123',
        subdomain: 'taken'
      });
      
      const result = subdomainService.isSubdomainAvailable('taken');
      expect(result).toBe(false);
    });
  });

  describe('getAvailableSubdomainSuggestions', () => {
    it('should return suggestions for a preferred name', () => {
      const suggestions = subdomainService.getAvailableSubdomainSuggestions('preferred', 3);
      
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeLessThanOrEqual(3);
      suggestions.forEach(suggestion => {
        expect(typeof suggestion).toBe('string');
        expect(suggestion.includes('preferred')).toBe(true);
      });
    });

    it('should return empty array for invalid name', () => {
      const suggestions = subdomainService.getAvailableSubdomainSuggestions('ab', 5);
      expect(suggestions).toEqual([]);
    });
  });

  describe('validateSubdomain', () => {
    it('should validate correct subdomain', () => {
      expect(() => {
        subdomainService.validateSubdomain('valid-subdomain123');
      }).not.toThrow();
    });

    it('should throw error for subdomain that is too short', () => {
      expect(() => {
        subdomainService.validateSubdomain('ab');
      }).toThrow('at least 3 characters long');
    });

    it('should throw error for subdomain that is too long', () => {
      expect(() => {
        subdomainService.validateSubdomain('a'.repeat(64));
      }).toThrow('less than 63 characters long');
    });

    it('should throw error for subdomain with invalid characters', () => {
      expect(() => {
        subdomainService.validateSubdomain('invalid_domain');
      }).toThrow('can only contain letters, numbers, and hyphens');
    });

    it('should throw error for subdomain starting with hyphen', () => {
      expect(() => {
        subdomainService.validateSubdomain('-invalid');
      }).toThrow('cannot start or end with a hyphen');
    });

    it('should throw error for subdomain ending with hyphen', () => {
      expect(() => {
        subdomainService.validateSubdomain('invalid-');
      }).toThrow('cannot start or end with a hyphen');
    });

    it('should throw error for subdomain with consecutive hyphens', () => {
      expect(() => {
        subdomainService.validateSubdomain('invalid--domain');
      }).toThrow('cannot contain consecutive hyphens');
    });
  });

  describe('getSubdomainUrl', () => {
    it('should generate correct URL', () => {
      const url = subdomainService.getSubdomainUrl('testcreator', '/path');
      expect(url).toBe('http://testcreator.substream.app/path');
    });

    it('should handle path without leading slash', () => {
      const url = subdomainService.getSubdomainUrl('testcreator', 'path');
      expect(url).toBe('http://testcreator.substream.app/path');
    });

    it('should handle empty path', () => {
      const url = subdomainService.getSubdomainUrl('testcreator');
      expect(url).toBe('http://testcreator.substream.app/');
    });
  });

  describe('generateRandomSubdomain', () => {
    it('should generate available random subdomain', () => {
      const subdomain = subdomainService.generateRandomSubdomain('test');
      
      expect(subdomain).toBeDefined();
      expect(typeof subdomain).toBe('string');
      expect(subdomain.startsWith('test-')).toBe(true);
      expect(subdomainService.isSubdomainAvailable(subdomain)).toBe(true);
    });
  });
});

describe('Subdomain Middleware', () => {
  let database;
  let subdomainMiddleware;
  let config;
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    config = loadConfig();
    subdomainMiddleware = new SubdomainMiddleware(database, config);
    
    mockReq = {
      hostname: 'testcreator.substream.app',
      headers: {},
      path: '/api/test'
    };
    
    mockRes = {
      header: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    mockNext = jest.fn();
  });

  afterEach(() => {
    if (database && database.db) {
      database.db.close();
    }
  });

  describe('middleware', () => {
    it('should skip subdomain resolution for API paths', () => {
      mockReq.path = '/api/test';
      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.creatorContext).toBeUndefined();
    });

    it('should skip subdomain resolution for health endpoint', () => {
      mockReq.path = '/health';
      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.creatorContext).toBeUndefined();
    });

    it('should resolve valid subdomain to creator context', () => {
      // Create a subdomain first
      const subdomainService = new SubdomainService(database, config);
      const creatorId = 'test-creator-123';
      const subdomainName = 'testcreator';
      
      subdomainService.createSubdomain({
        creatorId,
        subdomain: subdomainName
      });

      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.creatorContext).toBeDefined();
      expect(mockReq.creatorContext.creatorId).toBe(creatorId);
      expect(mockReq.creatorContext.subdomain).toBe(subdomainName);
      expect(mockReq.creatorContext.isSubdomainRequest).toBe(true);
    });

    it('should return 404 for unknown subdomain', () => {
      mockReq.hostname = 'unknown.substream.app';
      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Creator not found',
        message: 'The subdomain "unknown" is not registered.'
      });
    });

    it('should handle requests without subdomain', () => {
      mockReq.hostname = 'substream.app';
      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.creatorContext).toBeUndefined();
    });

    it('should handle requests with www prefix', () => {
      mockReq.hostname = 'www.testcreator.substream.app';
      
      // Create a subdomain first
      const subdomainService = new SubdomainService(database, config);
      subdomainService.createSubdomain({
        creatorId: 'test-creator-123',
        subdomain: 'testcreator'
      });

      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.creatorContext).toBeDefined();
      expect(mockReq.creatorContext.subdomain).toBe('testcreator');
    });

    it('should set CORS headers for subdomain requests', () => {
      // Create a subdomain first
      const subdomainService = new SubdomainService(database, config);
      subdomainService.createSubdomain({
        creatorId: 'test-creator-123',
        subdomain: 'testcreator'
      });

      const middleware = subdomainMiddleware.middleware();
      
      middleware(mockReq, mockRes, mockNext);
      
      expect(mockRes.header).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://testcreator.substream.app'
      );
      expect(mockRes.header).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS'
      );
      expect(mockRes.header).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      );
    });
  });

  describe('extractSubdomain', () => {
    it('should extract subdomain from hostname', () => {
      const subdomain = subdomainMiddleware.extractSubdomain('testcreator.substream.app');
      expect(subdomain).toBe('testcreator');
    });

    it('should return null for base domain', () => {
      const subdomain = subdomainMiddleware.extractSubdomain('substream.app');
      expect(subdomain).toBe(null);
    });

    it('should handle hostname with port', () => {
      const subdomain = subdomainMiddleware.extractSubdomain('testcreator.substream.app:8080');
      expect(subdomain).toBe('testcreator');
    });

    it('should handle multi-level subdomains', () => {
      const subdomain = subdomainMiddleware.extractSubdomain('api.testcreator.substream.app');
      expect(subdomain).toBe('api.testcreator');
    });

    it('should handle www prefix', () => {
      const subdomain = subdomainMiddleware.extractSubdomain('www.testcreator.substream.app');
      expect(subdomain).toBe('testcreator');
    });
  });

  describe('resolveSubdomain', () => {
    it('should resolve subdomain from database', () => {
      const subdomainService = new SubdomainService(database, config);
      const creatorId = 'test-creator-123';
      const subdomainName = 'testcreator';
      
      subdomainService.createSubdomain({
        creatorId,
        subdomain: subdomainName
      });

      const result = subdomainMiddleware.resolveSubdomain(subdomainName);
      
      expect(result).toBeDefined();
      expect(result.creatorId).toBe(creatorId);
      expect(result.subdomain).toBe(subdomainName);
      expect(result.status).toBe('active');
    });

    it('should return null for unknown subdomain', () => {
      const result = subdomainMiddleware.resolveSubdomain('unknown');
      expect(result).toBe(null);
    });

    it('should cache subdomain lookups', () => {
      const subdomainService = new SubdomainService(database, config);
      const creatorId = 'test-creator-123';
      const subdomainName = 'testcreator';
      
      subdomainService.createSubdomain({
        creatorId,
        subdomain: subdomainName
      });

      // First call should query database
      const result1 = subdomainMiddleware.resolveSubdomain(subdomainName);
      expect(result1).toBeDefined();

      // Second call should use cache
      const result2 = subdomainMiddleware.resolveSubdomain(subdomainName);
      expect(result2).toEqual(result1);
    });
  });

  describe('static methods', () => {
    it('should get creator context from request', () => {
      mockReq.creatorContext = {
        creatorId: 'test-creator-123',
        subdomain: 'testcreator',
        isSubdomainRequest: true
      };

      const context = SubdomainMiddleware.getCreatorContext(mockReq);
      expect(context).toEqual(mockReq.creatorContext);
    });

    it('should check if request is subdomain request', () => {
      mockReq.creatorContext = { isSubdomainRequest: true };
      expect(SubdomainMiddleware.isSubdomainRequest(mockReq)).toBe(true);

      mockReq.creatorContext = { isSubdomainRequest: false };
      expect(SubdomainMiddleware.isSubdomainRequest(mockReq)).toBe(false);

      mockReq.creatorContext = undefined;
      expect(SubdomainMiddleware.isSubdomainRequest(mockReq)).toBe(false);
    });

    it('should get creator ID from request', () => {
      mockReq.creatorContext = { creatorId: 'test-creator-123' };
      expect(SubdomainMiddleware.getCreatorId(mockReq)).toBe('test-creator-123');

      mockReq.creatorContext = undefined;
      expect(SubdomainMiddleware.getCreatorId(mockReq)).toBe(null);
    });
  });
});
