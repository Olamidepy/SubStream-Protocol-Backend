/**
 * Device Fingerprinting Service
 * 
 * Generates unique device fingerprints based on browser headers, hardware specs,
 * and canvas rendering to detect multi-accounting fraud.
 * 
 * Features:
 * - Canvas fingerprinting (rendering-based)
 * - Hardware/consumer software analysis
 * - Browser/header fingerprinting
 * - IP address correlation
 * - Sybil attack detection
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class DeviceFingerprintService {
  constructor(redisClient) {
    this.redis = redisClient;
    // Keys for Redis storage
    this.DEVICE_PREFIX = 'device:';
    this.WALLET_DEVICE_MAP_PREFIX = 'wallet:device:';
    this.SYBIL_FLAGGED_PREFIX = 'sybil:flagged:device:';
    this.CANVAS_SAMPLES_KEY = 'device:canvas:samples';
  }

  /**
   * Generate a comprehensive device fingerprint from multiple data points
   * @param {Object} requestData - Request information including headers
   * @param {Object} clientData - Client-provided fingerprinting data
   * @returns {Promise<Object>} Device fingerprint details
   */
  async generateFingerprint(requestData, clientData = {}) {
    const {
      userAgent,
      acceptLanguage,
      acceptEncoding,
      platform,
      screenResolution,
      timezone,
      webglVendor,
      webglRenderer,
      canvasHash,
      audioContextHash,
      fonts,
      plugins,
      touchSupport,
      hardwareConcurrency,
      deviceMemory,
    } = clientData;

    // Extract IP from request
    const ipAddress = requestData.ip || 
                     requestData.headers?.['x-forwarded-for']?.split(',')[0] || 
                     requestData.headers?.['x-real-ip'] || 
                     'unknown';

    // Build fingerprint components
    const fingerprintComponents = {
      // Browser/HTTP headers
      ua: userAgent || '',
      lang: acceptLanguage || '',
      encoding: acceptEncoding || '',
      platform: platform || '',
      
      // Screen/Display
      screen: screenResolution || '',
      tz: timezone || '',
      
      // WebGL (GPU identification)
      webglV: webglVendor || '',
      webglR: webglRenderer || '',
      
      // Canvas rendering hash (if provided by client)
      canvas: canvasHash || '',
      
      // Audio context fingerprint (if provided)
      audio: audioContextHash || '',
      
      // System fonts (hash of font list)
      fonts: fonts || '',
      
      // Browser plugins
      plugins: plugins || '',
      
      // Touch support (mobile vs desktop)
      touch: touchSupport || '',
      
      // Hardware specs
      cpuCores: hardwareConcurrency || '',
      memory: deviceMemory || '',
      
      // Network layer
      ip: this._anonymizeIP(ipAddress),
    };

    // Generate composite hash
    const fingerprintString = JSON.stringify(fingerprintComponents);
    const deviceFingerprint = crypto
      .createHash('sha256')
      .update(fingerprintString)
      .digest('hex');

    // Generate stable device ID (persistent across sessions)
    const deviceId = this._generateStableDeviceId(deviceFingerprint, ipAddress);

    // Store device fingerprint data
    await this._storeDeviceData(deviceId, {
      fingerprint: deviceFingerprint,
      components: fingerprintComponents,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      associatedWallets: [],
      riskScore: 0,
      sybilFlags: [],
    });

    // Track wallet-to-device mapping if wallet provided
    if (clientData.walletAddress) {
      await this._linkWalletToDevice(clientData.walletAddress, deviceId);
    }

    return {
      deviceId,
      fingerprint: deviceFingerprint,
      confidence: this._calculateConfidence(fingerprintComponents),
      riskLevel: this._assessInitialRisk(fingerprintComponents),
      components: fingerprintComponents,
    };
  }

  /**
   * Link a wallet address to a device ID
   * @param {string} walletAddress - Stellar wallet address
   * @param {string} deviceId - Unique device identifier
   */
  async linkWalletToDevice(walletAddress, deviceId) {
    const normalizedWallet = walletAddress.toLowerCase();
    
    // Map wallet to device
    await this.redis.hset(
      `${this.WALLET_DEVICE_MAP_PREFIX}${normalizedWallet}`,
      {
        deviceId,
        linkedAt: new Date().toISOString(),
      }
    );

    // Add wallet to device's associated wallets list
    const deviceKey = `${this.DEVICE_PREFIX}${deviceId}`;
    await this.redis.sadd(`${deviceKey}:wallets`, normalizedWallet);
    
    // Update device data
    const deviceData = await this.getDeviceData(deviceId);
    if (deviceData && !deviceData.associatedWallets.includes(normalizedWallet)) {
      deviceData.associatedWallets.push(normalizedWallet);
      deviceData.lastSeen = new Date().toISOString();
      await this._storeDeviceData(deviceId, deviceData);
    }

    // Check for potential Sybil attack
    const sybilRisk = await this._detectSybilFromWalletLink(deviceId, normalizedWallet);
    
    return sybilRisk;
  }

  /**
   * Get device ID for a wallet address
   * @param {string} walletAddress - Wallet address
   * @returns {Promise<string|null>} Device ID or null
   */
  async getDeviceForWallet(walletAddress) {
    const normalizedWallet = walletAddress.toLowerCase();
    const deviceData = await this.redis.hgetall(
      `${this.WALLET_DEVICE_MAP_PREFIX}${normalizedWallet}`
    );
    return deviceData?.deviceId || null;
  }

  /**
   * Get all wallets associated with a device
   * @param {string} deviceId - Device ID
   * @returns {Promise<Array<string>>} List of wallet addresses
   */
  async getWalletsForDevice(deviceId) {
    const wallets = await this.redis.smembers(`${this.DEVICE_PREFIX}${deviceId}:wallets`);
    return wallets || [];
  }

  /**
   * Detect potential Sybil attacks based on device-wallet patterns
   * @param {string} deviceId - Device ID to analyze
   * @returns {Promise<Object>} Sybil analysis result
   */
  async analyzeSybilRisk(deviceId) {
    const deviceData = await this.getDeviceData(deviceId);
    if (!deviceData) {
      return { risk: 'unknown', wallets: 0, flagged: false };
    }

    const walletCount = deviceData.associatedWallets.length;
    let riskLevel = 'low';
    let flags = [];

    // Multiple wallets from same device is primary Sybil indicator
    if (walletCount >= 10) {
      riskLevel = 'critical';
      flags.push('CRITICAL_MULTI_WALLET');
    } else if (walletCount >= 5) {
      riskLevel = 'high';
      flags.push('HIGH_MULTI_WALLET');
    } else if (walletCount >= 3) {
      riskLevel = 'medium';
      flags.push('MEDIUM_MULTI_WALLET');
    }

    // Check for similar fingerprint patterns
    const similarDevices = await this._findSimilarFingerprints(deviceData.fingerprint);
    if (similarDevices.length > 0) {
      flags.push('SIMILAR_FINGERPRINT_CLUSTER');
      riskLevel = riskLevel === 'low' ? 'medium' : 'high';
    }

    // Update device risk score
    const riskScore = this._calculateRiskScore(walletCount, flags);
    await this._updateDeviceRisk(deviceId, { riskScore, flags });

    // Flag as Sybil if critical risk
    if (riskLevel === 'critical') {
      await this._flagAsSybil(deviceId, deviceData.associatedWallets);
    }

    return {
      deviceId,
      riskLevel,
      riskScore,
      walletCount,
      wallets: deviceData.associatedWallets,
      flags,
      flagged: riskLevel === 'critical' || riskLevel === 'high',
      similarDevices,
    };
  }

  /**
   * Get or create device ID from request
   * @param {Object} requestData - Request information
   * @param {Object} clientData - Client fingerprint data
   * @returns {Promise<Object>} Device identification result
   */
  async identifyDevice(requestData, clientData = {}) {
    // Try to identify from existing wallet
    if (clientData.walletAddress) {
      const existingDeviceId = await this.getDeviceForWallet(clientData.walletAddress);
      if (existingDeviceId) {
        // Update last seen
        await this._updateDeviceLastSeen(existingDeviceId);
        return {
          deviceId: existingDeviceId,
          isNew: false,
          identified: true,
        };
      }
    }

    // Generate new fingerprint
    const fingerprint = await this.generateFingerprint(requestData, clientData);
    
    return {
      deviceId: fingerprint.deviceId,
      fingerprint: fingerprint.fingerprint,
      isNew: true,
      identified: false,
      riskLevel: fingerprint.riskLevel,
    };
  }

  /**
   * Internal: Generate stable device ID using consistent hashing
   * @private
   */
  _generateStableDeviceId(fingerprint, ipAddress) {
    // Use first 16 chars of fingerprint + anonymized IP for stability
    const ipComponent = this._anonymizeIP(ipAddress).replace(/\./g, '');
    return `dev_${fingerprint.substring(0, 16)}${ipComponent}`;
  }

  /**
   * Internal: Anonymize IP address for privacy compliance
   * @private
   */
  _anonymizeIP(ip) {
    if (!ip || ip === 'unknown') return '0.0.0.0';
    
    // IPv4: Remove last octet
    if (ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      return ip.replace(/\.\d+$/, '.0');
    }
    
    // IPv6: Truncate
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return parts.slice(0, 5).join(':') + '::0';
    }
    
    return ip;
  }

  /**
   * Internal: Store device data in Redis
   * @private
   */
  async _storeDeviceData(deviceId, data) {
    const deviceKey = `${this.DEVICE_PREFIX}${deviceId}`;
    await this.redis.hmset(deviceKey, {
      fingerprint: data.fingerprint,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
      riskScore: String(data.riskScore || 0),
      sybilFlags: JSON.stringify(data.sybilFlags || []),
    });

    // Store associated wallets as a set
    if (data.associatedWallets?.length > 0) {
      await this.redis.del(`${deviceKey}:wallets`);
      await this.redis.sadd(`${deviceKey}:wallets`, ...data.associatedWallets);
    }

    // Set TTL (90 days)
    await this.redis.expire(deviceKey, 7776000);
  }

  /**
   * Internal: Get device data from Redis
   * @private
   */
  async getDeviceData(deviceId) {
    const deviceKey = `${this.DEVICE_PREFIX}${deviceId}`;
    const data = await this.redis.hgetall(deviceKey);
    
    if (!data || !data.fingerprint) return null;

    // Parse stored values
    const wallets = await this.redis.smembers(`${deviceKey}:wallets`);
    
    return {
      fingerprint: data.fingerprint,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
      riskScore: parseInt(data.riskScore, 10) || 0,
      sybilFlags: JSON.parse(data.sybilFlags || '[]'),
      associatedWallets: wallets,
    };
  }

  /**
   * Internal: Link wallet to device and check for Sybil patterns
   * @private
   */
  async _detectSybilFromWalletLink(deviceId, walletAddress) {
    const analysis = await this.analyzeSybilRisk(deviceId);
    
    if (analysis.flagged) {
      console.warn(
        `[DeviceFingerprint] Potential Sybil attack detected: Device ${deviceId} ` +
        `has ${analysis.walletCount} wallets with risk level ${analysis.riskLevel}`
      );
    }
    
    return analysis;
  }

  /**
   * Internal: Find devices with similar fingerprints
   * @private
   */
  async _findSimilarFingerprints(fingerprint) {
    // Compare first 8 characters (partial match)
    const prefix = fingerprint.substring(0, 8);
    const similarDevices = [];
    
    // This is a simplified check - in production, use more sophisticated matching
    // For now, just return count of similar prefixes
    return similarDevices;
  }

  /**
   * Internal: Calculate risk score based on various factors
   * @private
   */
  _calculateRiskScore(walletCount, flags) {
    let score = 0;
    
    // Base score from wallet count
    score += walletCount * 10;
    
    // Additional flags
    score += flags.length * 20;
    
    return Math.min(score, 100); // Cap at 100
  }

  /**
   * Internal: Update device risk assessment
   * @private
   */
  async _updateDeviceRisk(deviceId, { riskScore, flags }) {
    const deviceKey = `${this.DEVICE_PREFIX}${deviceId}`;
    await this.redis.hmset(deviceKey, {
      riskScore: String(riskScore),
      sybilFlags: JSON.stringify(flags),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Internal: Update device last seen timestamp
   * @private
   */
  async _updateDeviceLastSeen(deviceId) {
    const deviceKey = `${this.DEVICE_PREFIX}${deviceId}`;
    await this.redis.hmset(deviceKey, {
      lastSeen: new Date().toISOString(),
    });
  }

  /**
   * Internal: Flag device as Sybil attack entity
   * @private
   */
  async _flagAsSybil(deviceId, wallets) {
    const sybilKey = `${this.SYBIL_FLAGGED_PREFIX}${deviceId}`;
    await this.redis.hmset(sybilKey, {
      deviceId,
      flaggedAt: new Date().toISOString(),
      walletCount: String(wallets.length),
      wallets: JSON.stringify(wallets),
    });
    
    // Also add to sorted set for ranking
    await this.redis.zadd('sybil:devices', wallets.length, deviceId);
  }

  /**
   * Internal: Calculate confidence score of fingerprint
   * @private
   */
  _calculateConfidence(components) {
    let confidence = 0;
    let totalFactors = 0;

    // Count available fingerprinting factors
    if (components.ua) totalFactors++;
    if (components.canvas) totalFactors++;
    if (components.webglV || components.webglR) totalFactors++;
    if (components.audio) totalFactors++;
    if (components.fonts) totalFactors++;
    if (components.screen) totalFactors++;
    if (components.cpuCores) totalFactors++;

    // Higher confidence with more factors
    if (totalFactors >= 5) confidence = 95;
    else if (totalFactors >= 3) confidence = 75;
    else if (totalFactors >= 2) confidence = 50;
    else confidence = 25;

    return confidence;
  }

  /**
   * Internal: Assess initial risk level
   * @private
   */
  _assessInitialRisk(components) {
    // Basic risk assessment on initial fingerprint
    // More detailed analysis happens when linking wallets
    
    // Tor/Proxy detection (simplified)
    if (components.encoding?.includes('br') && !components.platform) {
      return 'medium';
    }
    
    return 'low';
  }
}

module.exports = { DeviceFingerprintService };
