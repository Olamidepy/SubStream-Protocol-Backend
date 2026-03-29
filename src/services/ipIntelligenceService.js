const axios = require('axios');
const { logger } = require('../utils/logger');

/**
 * IP Intelligence Service for risk assessment and fraud detection
 * Integrates with multiple IP intelligence providers to calculate risk scores
 */
class IPIntelligenceService {
  constructor(config) {
    this.config = {
      // Multiple providers for redundancy and accuracy
      providers: {
        ipinfo: {
          enabled: config.ipinfo?.enabled || false,
          apiKey: config.ipinfo?.apiKey || process.env.IPINFO_API_KEY || '',
          baseUrl: 'https://ipinfo.io',
          timeout: config.ipinfo?.timeout || 5000
        },
        maxmind: {
          enabled: config.maxmind?.enabled || false,
          apiKey: config.maxmind?.apiKey || process.env.MAXMIND_API_KEY || '',
          baseUrl: 'https://geoip.maxmind.com/geoip/v2.1',
          timeout: config.maxmind?.timeout || 5000
        },
        abuseipdb: {
          enabled: config.abuseipdb?.enabled || false,
          apiKey: config.abuseipdb?.apiKey || process.env.ABUSEIPDB_API_KEY || '',
          baseUrl: 'https://api.abuseipdb.com/api/v2',
          timeout: config.abuseipdb?.timeout || 5000
        },
        ipqualityscore: {
          enabled: config.ipqualityscore?.enabled || false,
          apiKey: config.ipqualityscore?.apiKey || process.env.IPQUALITYSCORE_API_KEY || '',
          baseUrl: 'https://ipqualityscore.com/api/json',
          timeout: config.ipqualityscore?.timeout || 5000
        }
      },
      // Risk scoring configuration
      riskThresholds: {
        low: config.riskThresholds?.low || 30,
        medium: config.riskThresholds?.medium || 60,
        high: config.riskThresholds?.high || 80,
        critical: config.riskThresholds?.critical || 90
      },
      // Caching configuration
      cache: {
        enabled: config.cache?.enabled !== false,
        ttl: config.cache?.ttl || 3600000, // 1 hour
        maxSize: config.cache?.maxSize || 10000
      },
      // Rate limiting
      rateLimit: {
        requestsPerMinute: config.rateLimit?.requestsPerMinute || 100,
        burstLimit: config.rateLimit?.burstLimit || 20
      }
    };

    // Initialize cache
    this.cache = new Map();
    this.cacheTimestamps = new Map();
    
    // Rate limiting
    this.requestTimestamps = [];
    
    // Known malicious patterns
    this.maliciousPatterns = {
      torExitNodes: new Set(),
      vpnProviders: new Set(),
      proxyServers: new Set(),
      dataCenters: new Set()
    };

    // Initialize known threats
    this.initializeKnownThreats();
  }

  /**
   * Initialize known threat patterns
   */
  initializeKnownThreats() {
    // Tor exit node patterns (simplified - in production, use real-time data)
    this.maliciousPatterns.torExitNodes = new Set([
      '185.220.101.', '185.220.102.', '185.220.103.',
      '185.220.104.', '185.220.105.', '185.220.106.'
    ]);

    // Known VPN provider ranges (simplified)
    this.maliciousPatterns.vpnProviders = new Set([
      '1.1.1.', '8.8.8.', '208.67.222.', '208.67.220.'
    ]);

    // Known proxy server patterns
    this.maliciousPatterns.proxyServers = new Set([
      '192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.',
      '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
      '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'
    ]);

    // Known data center ranges
    this.maliciousPatterns.dataCenters = new Set([
      '52.', '54.', '107.', '172.', '174.', '175.', '204.'
    ]);
  }

  /**
   * Assess IP risk using multiple intelligence providers
   * @param {string} ipAddress - IP address to assess
   * @param {object} options - Assessment options
   * @returns {Promise<object>} Risk assessment result
   */
  async assessIPRisk(ipAddress, options = {}) {
    try {
      // Check cache first
      const cached = this.getCachedResult(ipAddress);
      if (cached && !options.bypassCache) {
        logger.debug('IP risk assessment served from cache', {
          ipAddress,
          riskScore: cached.riskScore,
          traceId: logger.defaultMeta?.traceId
        });
        return cached;
      }

      // Rate limiting check
      if (!this.checkRateLimit()) {
        throw new Error('Rate limit exceeded for IP intelligence requests');
      }

      // Validate IP address
      if (!this.isValidIP(ipAddress)) {
        return this.createInvalidIPResult(ipAddress);
      }

      // Skip private/internal IPs
      if (this.isPrivateIP(ipAddress)) {
        return this.createPrivateIPResult(ipAddress);
      }

      // Collect intelligence from all enabled providers
      const providerResults = await this.collectProviderData(ipAddress);
      
      // Calculate comprehensive risk score
      const riskAssessment = this.calculateRiskScore(ipAddress, providerResults);
      
      // Cache the result
      this.cacheResult(ipAddress, riskAssessment);

      logger.info('IP risk assessment completed', {
        ipAddress,
        riskScore: riskAssessment.riskScore,
        riskLevel: riskAssessment.riskLevel,
        providers: Object.keys(providerResults),
        traceId: logger.defaultMeta?.traceId
      });

      return riskAssessment;

    } catch (error) {
      logger.error('IP risk assessment failed', {
        ipAddress,
        error: error.message,
        traceId: logger.defaultMeta?.traceId
      });

      // Fail safe - return medium risk on errors
      return this.createErrorResult(ipAddress, error);
    }
  }

  /**
   * Collect data from all enabled providers
   * @param {string} ipAddress 
   * @returns {Promise<object>} Provider results
   */
  async collectProviderData(ipAddress) {
    const results = {};
    const providerPromises = [];

    // IPInfo provider
    if (this.config.providers.ipinfo.enabled) {
      providerPromises.push(
        this.queryIPInfo(ipAddress)
          .then(data => { results.ipinfo = data; })
          .catch(error => { 
            logger.warn('IPInfo provider failed', { ipAddress, error: error.message });
            results.ipinfo = { error: error.message };
          })
      );
    }

    // MaxMind provider
    if (this.config.providers.maxmind.enabled) {
      providerPromises.push(
        this.queryMaxMind(ipAddress)
          .then(data => { results.maxmind = data; })
          .catch(error => { 
            logger.warn('MaxMind provider failed', { ipAddress, error: error.message });
            results.maxmind = { error: error.message };
          })
      );
    }

    // AbuseIPDB provider
    if (this.config.providers.abuseipdb.enabled) {
      providerPromises.push(
        this.queryAbuseIPDB(ipAddress)
          .then(data => { results.abuseipdb = data; })
          .catch(error => { 
            logger.warn('AbuseIPDB provider failed', { ipAddress, error: error.message });
            results.abuseipdb = { error: error.message };
          })
      );
    }

    // IPQualityScore provider
    if (this.config.providers.ipqualityscore.enabled) {
      providerPromises.push(
        this.queryIPQualityScore(ipAddress)
          .then(data => { results.ipqualityscore = data; })
          .catch(error => { 
            logger.warn('IPQualityScore provider failed', { ipAddress, error: error.message });
            results.ipqualityscore = { error: error.message };
          })
      );
    }

    // Wait for all provider requests
    await Promise.allSettled(providerPromises);

    return results;
  }

  /**
   * Query IPInfo provider
   * @param {string} ipAddress 
   * @returns {Promise<object>} IPInfo data
   */
  async queryIPInfo(ipAddress) {
    const url = `${this.config.providers.ipinfo.baseUrl}/${ipAddress}/json`;
    const headers = this.config.providers.ipinfo.apiKey ? 
      { Authorization: `Bearer ${this.config.providers.ipinfo.apiKey}` } : {};

    const response = await axios.get(url, {
      headers,
      timeout: this.config.providers.ipinfo.timeout
    });

    const data = response.data;
    
    return {
      provider: 'ipinfo',
      ip: data.ip,
      country: data.country,
      region: data.region,
      city: data.city,
      org: data.org,
      postal: data.postal,
      timezone: data.timezone,
      hostname: data.hostname,
      isVPN: this.isVPNIndicator(data.org, data.hostname),
      isHosting: this.isHostingProvider(data.org),
      riskFactors: this.extractIPInfoRiskFactors(data)
    };
  }

  /**
   * Query MaxMind provider
   * @param {string} ipAddress 
   * @returns {Promise<object>} MaxMind data
   */
  async queryMaxMind(ipAddress) {
    const url = `${this.config.providers.maxmind.baseUrl}/country/${ipAddress}`;
    const headers = {
      'Authorization': `Bearer ${this.config.providers.maxmind.apiKey}`
    };

    const response = await axios.get(url, {
      headers,
      timeout: this.config.providers.maxmind.timeout
    });

    const data = response.data;
    
    return {
      provider: 'maxmind',
      country: data.country?.iso_code,
      riskFactors: this.extractMaxMindRiskFactors(data)
    };
  }

  /**
   * Query AbuseIPDB provider
   * @param {string} ipAddress 
   * @returns {Promise<object>} AbuseIPDB data
   */
  async queryAbuseIPDB(ipAddress) {
    const url = this.config.providers.abuseipdb.baseUrl;
    const params = {
      ipAddress,
      maxAgeInDays: 90,
      verbose: ''
    };
    const headers = {
      'Key': this.config.providers.abuseipdb.apiKey,
      'Accept': 'application/json'
    };

    const response = await axios.get(url, {
      params,
      headers,
      timeout: this.config.providers.abuseipdb.timeout
    });

    const data = response.data;
    
    return {
      provider: 'abuseipdb',
      abuseConfidenceScore: data.data.abuseConfidenceScore,
      countryCode: data.data.countryCode,
      usageType: data.data.usageType,
      isTor: data.data.isTor,
      isPublicProxy: data.data.isPublicProxy,
      reports: data.data.totalReports,
      lastReportedAt: data.data.lastReportedAt,
      riskFactors: this.extractAbuseIPDBRiskFactors(data.data)
    };
  }

  /**
   * Query IPQualityScore provider
   * @param {string} ipAddress 
   * @returns {Promise<object>} IPQualityScore data
   */
  async queryIPQualityScore(ipAddress) {
    const url = this.config.providers.ipqualityscore.baseUrl;
    const params = {
      IP: ipAddress,
      key: this.config.providers.ipqualityscore.apiKey,
      strictness: 1,
      allow_public_access_points: 'true',
      fast: 'false',
      lighter_penalties: 'false'
    };

    const response = await axios.get(url, {
      params,
      timeout: this.config.providers.ipqualityscore.timeout
    });

    const data = response.data;
    
    return {
      provider: 'ipqualityscore',
      fraudScore: data.fraud_score,
      vpn: data.vpn,
      tor: data.tor,
      proxy: data.proxy,
      activeVPN: data.active_vpn,
      activeTor: data.active_tor,
      activeProxy: data.active_proxy,
      recentAbuse: data.recent_abuse,
      botStatus: data.bot_status,
      riskFactors: this.extractIPQualityScoreRiskFactors(data)
    };
  }

  /**
   * Calculate comprehensive risk score
   * @param {string} ipAddress 
   * @param {object} providerResults 
   * @returns {object} Risk assessment
   */
  calculateRiskScore(ipAddress, providerResults) {
    let riskScore = 0;
    const riskFactors = [];
    const providerScores = {};

    // Process each provider's data
    Object.entries(providerResults).forEach(([provider, data]) => {
      if (data.error) {
        providerScores[provider] = { score: 0, error: data.error };
        return;
      }

      const providerScore = this.calculateProviderScore(provider, data);
      providerScores[provider] = providerScore;
      riskScore += providerScore.score * providerScore.weight;

      // Collect risk factors
      if (providerScore.riskFactors && providerScore.riskFactors.length > 0) {
        riskFactors.push(...providerScore.riskFactors);
      }
    });

    // Normalize score (0-100)
    riskScore = Math.min(Math.max(riskScore, 0), 100);

    // Determine risk level
    const riskLevel = this.getRiskLevel(riskScore);

    // Add pattern-based risk factors
    const patternFactors = this.checkMaliciousPatterns(ipAddress);
    riskFactors.push(...patternFactors);

    return {
      ipAddress,
      riskScore: Math.round(riskScore),
      riskLevel,
      providerScores,
      riskFactors: [...new Set(riskFactors)], // Remove duplicates
      assessedAt: new Date().toISOString(),
      recommendations: this.generateRecommendations(riskLevel, riskFactors),
      metadata: {
        providers: Object.keys(providerResults),
        assessmentTime: Date.now()
      }
    };
  }

  /**
   * Calculate score for individual provider
   * @param {string} provider 
   * @param {object} data 
   * @returns {object} Provider score
   */
  calculateProviderScore(provider, data) {
    let score = 0;
    const riskFactors = [];
    let weight = 0.25; // Default weight

    switch (provider) {
      case 'ipinfo':
        weight = 0.25;
        if (data.isVPN) {
          score += 40;
          riskFactors.push('VPN detected via IPInfo');
        }
        if (data.isHosting) {
          score += 20;
          riskFactors.push('Hosting provider detected');
        }
        if (data.riskFactors && data.riskFactors.length > 0) {
          score += 15;
          riskFactors.push(...data.riskFactors);
        }
        break;

      case 'maxmind':
        weight = 0.15;
        if (data.riskFactors && data.riskFactors.length > 0) {
          score += 20;
          riskFactors.push(...data.riskFactors);
        }
        break;

      case 'abuseipdb':
        weight = 0.35;
        if (data.abuseConfidenceScore > 75) {
          score += 60;
          riskFactors.push('High abuse confidence');
        } else if (data.abuseConfidenceScore > 50) {
          score += 40;
          riskFactors.push('Medium abuse confidence');
        } else if (data.abuseConfidenceScore > 25) {
          score += 20;
          riskFactors.push('Low abuse confidence');
        }
        if (data.isTor) {
          score += 50;
          riskFactors.push('Tor exit node detected');
        }
        if (data.isPublicProxy) {
          score += 30;
          riskFactors.push('Public proxy detected');
        }
        if (data.reports > 10) {
          score += 25;
          riskFactors.push('High abuse reports');
        }
        if (data.riskFactors && data.riskFactors.length > 0) {
          riskFactors.push(...data.riskFactors);
        }
        break;

      case 'ipqualityscore':
        weight = 0.25;
        if (data.fraudScore > 75) {
          score += 50;
          riskFactors.push('High fraud score');
        } else if (data.fraudScore > 50) {
          score += 30;
          riskFactors.push('Medium fraud score');
        }
        if (data.vpn || data.activeVPN) {
          score += 35;
          riskFactors.push('VPN detected via IPQualityScore');
        }
        if (data.tor || data.activeTor) {
          score += 45;
          riskFactors.push('Tor detected via IPQualityScore');
        }
        if (data.proxy || data.activeProxy) {
          score += 25;
          riskFactors.push('Proxy detected via IPQualityScore');
        }
        if (data.recentAbuse) {
          score += 30;
          riskFactors.push('Recent abuse detected');
        }
        if (data.botStatus === 'bad') {
          score += 40;
          riskFactors.push('Bot activity detected');
        }
        if (data.riskFactors && data.riskFactors.length > 0) {
          riskFactors.push(...data.riskFactors);
        }
        break;
    }

    return {
      score,
      weight,
      riskFactors
    };
  }

  /**
   * Check for malicious patterns
   * @param {string} ipAddress 
   * @returns {array} Risk factors
   */
  checkMaliciousPatterns(ipAddress) {
    const riskFactors = [];

    // Check Tor exit nodes
    for (const pattern of this.maliciousPatterns.torExitNodes) {
      if (ipAddress.startsWith(pattern)) {
        riskFactors.push('Known Tor exit node pattern');
        break;
      }
    }

    // Check VPN providers
    for (const pattern of this.maliciousPatterns.vpnProviders) {
      if (ipAddress.startsWith(pattern)) {
        riskFactors.push('Known VPN provider pattern');
        break;
      }
    }

    // Check proxy servers
    for (const pattern of this.maliciousPatterns.proxyServers) {
      if (ipAddress.startsWith(pattern)) {
        riskFactors.push('Proxy server pattern');
        break;
      }
    }

    // Check data centers
    for (const pattern of this.maliciousPatterns.dataCenters) {
      if (ipAddress.startsWith(pattern)) {
        riskFactors.push('Data center IP range');
        break;
      }
    }

    return riskFactors;
  }

  /**
   * Extract risk factors from IPInfo data
   * @param {object} data 
   * @returns {array} Risk factors
   */
  extractIPInfoRiskFactors(data) {
    const factors = [];
    
    if (data.org && data.org.toLowerCase().includes('vpn')) {
      factors.push('VPN organization detected');
    }
    if (data.org && data.org.toLowerCase().includes('hosting')) {
      factors.push('Hosting organization detected');
    }
    if (data.hostname && data.hostname.toLowerCase().includes('tor')) {
      factors.push('Tor hostname detected');
    }
    
    return factors;
  }

  /**
   * Extract risk factors from MaxMind data
   * @param {object} data 
   * @returns {array} Risk factors
   */
  extractMaxMindRiskFactors(data) {
    const factors = [];
    
    // Add MaxMind-specific risk factors
    if (data.country) {
      const highRiskCountries = ['CN', 'RU', 'IR', 'KP'];
      if (highRiskCountries.includes(data.country.iso_code)) {
        factors.push(`High-risk country: ${data.country.iso_code}`);
      }
    }
    
    return factors;
  }

  /**
   * Extract risk factors from AbuseIPDB data
   * @param {object} data 
   * @returns {array} Risk factors
   */
  extractAbuseIPDBRiskFactors(data) {
    const factors = [];
    
    if (data.usageType) {
      const highRiskUsageTypes = ['commercial', 'search engine spider', 'scraper'];
      if (highRiskUsageTypes.includes(data.usageType.toLowerCase())) {
        factors.push(`High-risk usage type: ${data.usageType}`);
      }
    }
    
    return factors;
  }

  /**
   * Extract risk factors from IPQualityScore data
   * @param {object} data 
   * @returns {array} Risk factors
   */
  extractIPQualityScoreRiskFactors(data) {
    const factors = [];
    
    if (data.mobile && data.mobile === false) {
      factors.push('Non-mobile connection (potentially automated)');
    }
    
    return factors;
  }

  /**
   * Check if IP is a VPN indicator
   * @param {string} org 
   * @param {string} hostname 
   * @returns {boolean}
   */
  isVPNIndicator(org, hostname) {
    if (!org && !hostname) return false;
    
    const vpnKeywords = ['vpn', 'private', 'anonymous', 'hide', 'proxy'];
    const checkString = `${org} ${hostname}`.toLowerCase();
    
    return vpnKeywords.some(keyword => checkString.includes(keyword));
  }

  /**
   * Check if IP is a hosting provider
   * @param {string} org 
   * @returns {boolean}
   */
  isHostingProvider(org) {
    if (!org) return false;
    
    const hostingKeywords = ['hosting', 'server', 'datacenter', 'cloud', 'aws', 'azure', 'gcp'];
    return hostingKeywords.some(keyword => org.toLowerCase().includes(keyword));
  }

  /**
   * Get risk level based on score
   * @param {number} score 
   * @returns {string} Risk level
   */
  getRiskLevel(score) {
    if (score >= this.config.riskThresholds.critical) return 'critical';
    if (score >= this.config.riskThresholds.high) return 'high';
    if (score >= this.config.riskThresholds.medium) return 'medium';
    if (score >= this.config.riskThresholds.low) return 'low';
    return 'minimal';
  }

  /**
   * Generate recommendations based on risk level and factors
   * @param {string} riskLevel 
   * @param {array} riskFactors 
   * @returns {array} Recommendations
   */
  generateRecommendations(riskLevel, riskFactors) {
    const recommendations = [];

    switch (riskLevel) {
      case 'critical':
        recommendations.push('BLOCK - Immediate blocking recommended');
        recommendations.push('Manual review required');
        recommendations.push('Consider legal action if abuse detected');
        break;
      case 'high':
        recommendations.push('RESTRICT - Limit critical actions');
        recommendations.push('Enhanced monitoring required');
        recommendations.push('Additional verification steps');
        break;
      case 'medium':
        recommendations.push('MONITOR - Increased monitoring');
        recommendations.push('Rate limiting recommended');
        recommendations.push('Periodic review advised');
        break;
      case 'low':
        recommendations.push('STANDARD - Normal processing');
        recommendations.push('Basic monitoring sufficient');
        break;
      case 'minimal':
        recommendations.push('TRUSTED - Minimal restrictions');
        break;
    }

    // Add factor-specific recommendations
    if (riskFactors.includes('VPN detected')) {
      recommendations.push('VPN users may require additional verification');
    }
    if (riskFactors.includes('Tor exit node')) {
      recommendations.push('Tor users should be carefully monitored');
    }
    if (riskFactors.includes('High abuse confidence')) {
      recommendations.push('High abuse history - consider blocking');
    }

    return recommendations;
  }

  /**
   * Validate IP address format
   * @param {string} ipAddress 
   * @returns {boolean}
   */
  isValidIP(ipAddress) {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    return ipv4Regex.test(ipAddress) || ipv6Regex.test(ipAddress);
  }

  /**
   * Check if IP is private/internal
   * @param {string} ipAddress 
   * @returns {boolean}
   */
  isPrivateIP(ipAddress) {
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/
    ];

    return privateRanges.some(range => range.test(ipAddress));
  }

  /**
   * Create result for invalid IP
   * @param {string} ipAddress 
   * @returns {object} Invalid IP result
   */
  createInvalidIPResult(ipAddress) {
    return {
      ipAddress,
      riskScore: 100,
      riskLevel: 'critical',
      providerScores: {},
      riskFactors: ['Invalid IP address format'],
      assessedAt: new Date().toISOString(),
      recommendations: ['BLOCK - Invalid IP address'],
      metadata: {
        providers: [],
        assessmentTime: Date.now(),
        error: 'Invalid IP address format'
      }
    };
  }

  /**
   * Create result for private IP
   * @param {string} ipAddress 
   * @returns {object} Private IP result
   */
  createPrivateIPResult(ipAddress) {
    return {
      ipAddress,
      riskScore: 0,
      riskLevel: 'minimal',
      providerScores: {},
      riskFactors: ['Private/internal IP address'],
      assessedAt: new Date().toISOString(),
      recommendations: ['TRUSTED - Internal network address'],
      metadata: {
        providers: [],
        assessmentTime: Date.now(),
        isPrivate: true
      }
    };
  }

  /**
   * Create result for errors
   * @param {string} ipAddress 
   * @param {Error} error 
   * @returns {object} Error result
   */
  createErrorResult(ipAddress, error) {
    return {
      ipAddress,
      riskScore: 50,
      riskLevel: 'medium',
      providerScores: {},
      riskFactors: ['Assessment failed - using default risk'],
      assessedAt: new Date().toISOString(),
      recommendations: ['MONITOR - Assessment service unavailable'],
      metadata: {
        providers: [],
        assessmentTime: Date.now(),
        error: error.message
      }
    };
  }

  /**
   * Check rate limiting
   * @returns {boolean} True if request is allowed
   */
  checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > oneMinuteAgo);

    // Check if under rate limit
    if (this.requestTimestamps.length >= this.config.rateLimit.requestsPerMinute) {
      return false;
    }

    // Add current timestamp
    this.requestTimestamps.push(now);
    return true;
  }

  /**
   * Get cached result
   * @param {string} ipAddress 
   * @returns {object|null} Cached result
   */
  getCachedResult(ipAddress) {
    if (!this.config.cache.enabled) return null;

    const cached = this.cache.get(ipAddress);
    const timestamp = this.cacheTimestamps.get(ipAddress);

    if (cached && timestamp && (Date.now() - timestamp) < this.config.cache.ttl) {
      return cached;
    }

    // Remove expired cache entry
    if (cached) {
      this.cache.delete(ipAddress);
      this.cacheTimestamps.delete(ipAddress);
    }

    return null;
  }

  /**
   * Cache assessment result
   * @param {string} ipAddress 
   * @param {object} result 
   */
  cacheResult(ipAddress, result) {
    if (!this.config.cache.enabled) return;

    // Clean up cache if over size limit
    if (this.cache.size >= this.config.cache.maxSize) {
      this.cleanupCache();
    }

    this.cache.set(ipAddress, result);
    this.cacheTimestamps.set(ipAddress, Date.now());
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [ip, timestamp] of this.cacheTimestamps.entries()) {
      if (now - timestamp > this.config.cache.ttl) {
        expiredKeys.push(ip);
      }
    }

    expiredKeys.forEach(ip => {
      this.cache.delete(ip);
      this.cacheTimestamps.delete(ip);
    });

    // If still over limit, remove oldest entries
    if (this.cache.size >= this.config.cache.maxSize) {
      const entries = Array.from(this.cacheTimestamps.entries())
        .sort((a, b) => a[1] - b[1]);

      const toRemove = entries.slice(0, Math.floor(this.config.cache.maxSize * 0.2));
      toRemove.forEach(([ip]) => {
        this.cache.delete(ip);
        this.cacheTimestamps.delete(ip);
      });
    }
  }

  /**
   * Get cache statistics
   * @returns {object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.config.cache.maxSize,
      ttl: this.config.cache.ttl,
      enabled: this.config.cache.enabled
    };
  }

  /**
   * Get service statistics
   * @returns {object} Service stats
   */
  getServiceStats() {
    return {
      providers: Object.keys(this.config.providers).filter(key => this.config.providers[key].enabled),
      cacheStats: this.getCacheStats(),
      rateLimit: {
        requestsPerMinute: this.config.rateLimit.requestsPerMinute,
        currentUsage: this.requestTimestamps.length
      },
      riskThresholds: this.config.riskThresholds
    };
  }
}

module.exports = { IPIntelligenceService };
