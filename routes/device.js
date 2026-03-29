const express = require('express');
const router = express.Router();
const { DeviceFingerprintService } = require('../src/services/deviceFingerprintService');
const { getRedisClient } = require('../src/config/redis');

// Initialize service with Redis
let deviceFingerprintService;

try {
  const redis = getRedisClient();
  deviceFingerprintService = new DeviceFingerprintService(redis);
} catch (error) {
  console.warn('Device Fingerprint Service not available - Redis not configured');
}

/**
 * @swagger
 * /api/device/fingerprint:
 *   post:
 *     summary: Generate or retrieve device fingerprint
 *     description: Creates a unique device ID based on browser headers, hardware specs, and canvas rendering
 *     tags: [Device, Security]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               walletAddress:
 *                 type: string
 *                 description: Stellar wallet address to link
 *               userAgent:
 *                 type: string
 *               platform:
 *                 type: string
 *               screenResolution:
 *                 type: string
 *               timezone:
 *                 type: string
 *               webglVendor:
 *                 type: string
 *               webglRenderer:
 *                 type: string
 *               canvasHash:
 *                 type: string
 *               audioContextHash:
 *                 type: string
 *               fonts:
 *                 type: string
 *               plugins:
 *                 type: string
 *               touchSupport:
 *                 type: string
 *               hardwareConcurrency:
 *                 type: number
 *               deviceMemory:
 *                 type: number
 *     responses:
 *       200:
 *         description: Device fingerprint generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deviceId:
 *                   type: string
 *                 fingerprint:
 *                   type: string
 *                 confidence:
 *                   type: number
 *                 riskLevel:
 *                   type: string
 *                 isNew:
 *                   type: boolean
 */
router.post('/fingerprint', async (req, res) => {
  try {
    if (!deviceFingerprintService) {
      return res.status(503).json({
        success: false,
        error: 'Device fingerprinting service unavailable',
      });
    }

    const clientData = req.body || {};
    const requestData = {
      ip: req.headers['x-forwarded-for']?.split(',')[0] || 
          req.headers['x-real-ip'] || 
          req.ip,
      headers: req.headers,
    };

    const result = await deviceFingerprintService.identifyDevice(
      requestData,
      clientData
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Device fingerprint error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate device fingerprint',
    });
  }
});

/**
 * @swagger
 * /api/device/{deviceId}/sybil-analysis:
 *   get:
 *     summary: Analyze device for Sybil attack patterns
 *     description: Checks if a device has multiple wallets linked (potential multi-accounting fraud)
 *     tags: [Device, Security, Fraud Prevention]
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID to analyze
 *     responses:
 *       200:
 *         description: Sybil analysis completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deviceId:
 *                   type: string
 *                 riskLevel:
 *                   type: string
 *                   enum: [low, medium, high, critical]
 *                 riskScore:
 *                   type: number
 *                 walletCount:
 *                   type: number
 *                 wallets:
 *                   type: array
 *                   items:
 *                     type: string
 *                 flags:
 *                   type: array
 *                   items:
 *                     type: string
 *                 flagged:
 *                   type: boolean
 */
router.get('/:deviceId/sybil-analysis', async (req, res) => {
  try {
    if (!deviceFingerprintService) {
      return res.status(503).json({
        success: false,
        error: 'Device fingerprinting service unavailable',
      });
    }

    const { deviceId } = req.params;
    const analysis = await deviceFingerprintService.analyzeSybilRisk(deviceId);

    res.json({
      success: true,
      ...analysis,
    });
  } catch (error) {
    console.error('Sybil analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze device',
    });
  }
});

/**
 * @swagger
 * /api/device/{deviceId}/wallets:
 *   get:
 *     summary: Get all wallets linked to a device
 *     description: Returns list of wallet addresses associated with a specific device ID
 *     tags: [Device, Security]
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID to query
 *     responses:
 *       200:
 *         description: Wallets retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deviceId:
 *                   type: string
 *                 wallets:
 *                   type: array
 *                   items:
 *                     type: string
 *                 count:
 *                   type: number
 */
router.get('/:deviceId/wallets', async (req, res) => {
  try {
    if (!deviceFingerprintService) {
      return res.status(503).json({
        success: false,
        error: 'Device fingerprinting service unavailable',
      });
    }

    const { deviceId } = req.params;
    const wallets = await deviceFingerprintService.getWalletsForDevice(deviceId);

    res.json({
      success: true,
      deviceId,
      wallets,
      count: wallets.length,
    });
  } catch (error) {
    console.error('Get wallets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve wallets',
    });
  }
});

/**
 * @swagger
 * /api/device/wallet/{walletAddress}:
 *   get:
 *     summary: Get device ID for a wallet
 *     description: Retrieves the device ID associated with a specific wallet address
 *     tags: [Device, Security]
 *     parameters:
 *       - in: path
 *         name: walletAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar wallet address
 *     responses:
 *       200:
 *         description: Device ID retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deviceId:
 *                   type: string
 *                 found:
 *                   type: boolean
 */
router.get('/wallet/:walletAddress', async (req, res) => {
  try {
    if (!deviceFingerprintService) {
      return res.status(503).json({
        success: false,
        error: 'Device fingerprinting service unavailable',
      });
    }

    const { walletAddress } = req.params;
    const deviceId = await deviceFingerprintService.getDeviceForWallet(walletAddress);

    res.json({
      success: true,
      deviceId: deviceId || null,
      found: !!deviceId,
    });
  } catch (error) {
    console.error('Get device for wallet error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve device',
    });
  }
});

/**
 * @swagger
 * /api/device/sybil/flagged:
 *   get:
 *     summary: Get list of flagged Sybil devices
 *     description: Returns devices flagged as potential Sybil attacks (10+ wallets from same device)
 *     tags: [Security, Fraud Prevention, Admin]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 20
 *         description: Maximum number of results
 *     responses:
 *       200:
 *         description: Flagged Sybil devices retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 devices:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       deviceId:
 *                         type: string
 *                       walletCount:
 *                         type: number
 *                       flaggedAt:
 *                         type: string
 */
router.get('/sybil/flagged', async (req, res) => {
  try {
    if (!deviceFingerprintService) {
      return res.status(503).json({
        success: false,
        error: 'Device fingerprinting service unavailable',
      });
    }

    const limit = parseInt(req.query.limit, 10) || 20;
    
    // Get top Sybil-flagged devices
    const flaggedDevices = await deviceFingerprintService.redis.zrevrange(
      'sybil:devices',
      0,
      limit - 1,
      'WITHSCORES'
    );

    const devices = [];
    for (let i = 0; i < flaggedDevices.length; i += 2) {
      const deviceId = flaggedDevices[i];
      const walletCount = parseInt(flaggedDevices[i + 1], 10);
      
      const deviceData = await deviceFingerprintService.getDeviceData(deviceId);
      devices.push({
        deviceId,
        walletCount,
        flaggedAt: deviceData?.lastSeen || null,
        wallets: deviceData?.associatedWallets || [],
      });
    }

    res.json({
      success: true,
      devices,
      count: devices.length,
    });
  } catch (error) {
    console.error('Get flagged Sybil error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve flagged devices',
    });
  }
});

module.exports = router;
