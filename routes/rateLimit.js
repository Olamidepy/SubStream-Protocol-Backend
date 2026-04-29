/**
 * Rate Limit Management API Routes
 * 
 * Admin endpoints for managing rate limits, IP blacklists, and enterprise merchant configurations.
 */

const express = require('express');
const router = express.Router();
const RateLimitService = require('../services/rateLimitService');
const logger = require('../utils/logger');

/**
 * GET /api/v1/rate-limit/stats
 * 
 * Get rate limiting statistics
 * 
 * Response:
 * {
 *   "totalRedisKeys": 1000,
 *   "rateLimitKeys": 500,
 *   "blacklistedIPs": 10,
 *   "torExitNodes": 5000,
 *   "webhookWhitelisted": 8
 * }
 */
router.get('/stats', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    const stats = await rateLimitService.getStatistics();

    res.status(200).json({
      success: true,
      ...stats
    });
  } catch (error) {
    logger.error('[RateLimit] Stats retrieval failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve statistics',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/rate-limit/tenant/:tenantId/limits
 * 
 * Update rate limits for a tenant (enterprise)
 * 
 * Request Body:
 * {
 *   "requestsPerMinute": 1000,
 *   "requestsPerHour": 50000,
 *   "loginAttemptsPerMinute": 50,
 *   "loginAttemptsPerHour": 200
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Rate limits updated"
 * }
 */
router.post('/tenant/:tenantId/limits', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { tenantId } = req.params;
  const { requestsPerMinute, requestsPerHour, loginAttemptsPerMinute, loginAttemptsPerHour } = req.body;

  // Validate input
  if (!requestsPerMinute || !requestsPerHour) {
    return res.status(400).json({
      success: false,
      error: 'requestsPerMinute and requestsPerHour are required'
    });
  }

  if (requestsPerMinute < 1 || requestsPerMinute > 10000) {
    return res.status(400).json({
      success: false,
      error: 'requestsPerMinute must be between 1 and 10000'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    const success = await rateLimitService.updateTenantRateLimits(tenantId, {
      requestsPerMinute,
      requestsPerHour,
      loginAttemptsPerMinute: loginAttemptsPerMinute || 50,
      loginAttemptsPerHour: loginAttemptsPerHour || 200
    });

    if (success) {
      res.status(200).json({
        success: true,
        message: 'Rate limits updated successfully',
        tenantId,
        limits: {
          requestsPerMinute,
          requestsPerHour,
          loginAttemptsPerMinute,
          loginAttemptsPerHour
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to update rate limits'
      });
    }
  } catch (error) {
    logger.error('[RateLimit] Tenant limit update failed', {
      tenantId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to update rate limits',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/rate-limit/tenant/:tenantId/limits
 * 
 * Get rate limits for a tenant
 * 
 * Response:
 * {
 *   "success": true,
 *   "tenantId": "123",
 *   "limits": { ... },
 *   "isEnterprise": true
 * }
 */
router.get('/tenant/:tenantId/limits', async (req, res) => {
  const { tenantId } = req.params;

  // Allow tenant to view their own limits or admin to view any
  if (!req.user || (req.user.tenantId !== tenantId && !req.user.isAdmin)) {
    return res.status(403).json({
      success: false,
      error: 'Access denied'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    const limits = await rateLimitService.getTenantRateLimits(tenantId, req.user.apiKey);

    res.status(200).json({
      success: true,
      tenantId,
      limits,
      isEnterprise: limits.isEnterprise
    });
  } catch (error) {
    logger.error('[RateLimit] Tenant limit retrieval failed', {
      tenantId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve rate limits',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/rate-limit/blacklist/ip
 * 
 * Add IP to blacklist
 * 
 * Request Body:
 * {
 *   "ip": "1.2.3.4",
 *   "reason": "malicious_activity",
 *   "ttl": 3600
 * }
 */
router.post('/blacklist/ip', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { ip, reason = 'manual', ttl = 3600 } = req.body;

  if (!ip) {
    return res.status(400).json({
      success: false,
      error: 'IP address is required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.blacklistIP(ip, reason, ttl);

    res.status(200).json({
      success: true,
      message: 'IP blacklisted successfully',
      ip,
      reason,
      ttl
    });
  } catch (error) {
    logger.error('[RateLimit] IP blacklist failed', {
      ip,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to blacklist IP',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/rate-limit/blacklist/ip/:ip
 * 
 * Remove IP from blacklist
 */
router.delete('/blacklist/ip/:ip', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { ip } = req.params;

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.unblacklistIP(ip);

    res.status(200).json({
      success: true,
      message: 'IP removed from blacklist',
      ip
    });
  } catch (error) {
    logger.error('[RateLimit] IP unblacklist failed', {
      ip,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to remove IP from blacklist',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/rate-limit/blacklist/ip
 * 
 * Get all blacklisted IPs
 */
router.get('/blacklist/ip', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    const blacklist = Array.from(rateLimitService.ipBlacklist);

    res.status(200).json({
      success: true,
      count: blacklist.length,
      ips: blacklist
    });
  } catch (error) {
    logger.error('[RateLimit] Blacklist retrieval failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve blacklist',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/rate-limit/tor/add
 * 
 * Add Tor exit node
 * 
 * Request Body:
 * {
 *   "ip": "1.2.3.4"
 * }
 */
router.post('/tor/add', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { ip } = req.body;

  if (!ip) {
    return res.status(400).json({
      success: false,
      error: 'IP address is required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.addTorExitNode(ip);

    res.status(200).json({
      success: true,
      message: 'Tor exit node added',
      ip
    });
  } catch (error) {
    logger.error('[RateLimit] Tor node add failed', {
      ip,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to add Tor exit node',
      message: error.message
    });
  }
});

/**
 * DELETE /api/v1/rate-limit/tor/:ip
 * 
 * Remove Tor exit node
 */
router.delete('/tor/:ip', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { ip } = req.params;

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.removeTorExitNode(ip);

    res.status(200).json({
      success: true,
      message: 'Tor exit node removed',
      ip
    });
  } catch (error) {
    logger.error('[RateLimit] Tor node remove failed', {
      ip,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to remove Tor exit node',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/rate-limit/tor
 * 
 * Get all Tor exit nodes
 */
router.get('/tor', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    const torNodes = Array.from(rateLimitService.torExitNodes);

    res.status(200).json({
      success: true,
      count: torNodes.length,
      nodes: torNodes
    });
  } catch (error) {
    logger.error('[RateLimit] Tor nodes retrieval failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve Tor exit nodes',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/rate-limit/reset/:key
 * 
 * Reset rate limit for a specific key
 * 
 * Request Body:
 * {
 *   "key": "api:1.2.3.4"
 * }
 */
router.post('/reset/:key', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  const { key } = req.params;

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.resetRateLimit(key);

    res.status(200).json({
      success: true,
      message: 'Rate limit reset',
      key
    });
  } catch (error) {
    logger.error('[RateLimit] Rate limit reset failed', {
      key,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to reset rate limit',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/rate-limit/cleanup
 * 
 * Trigger cleanup of expired rate limit entries
 */
router.post('/cleanup', async (req, res) => {
  // Admin authentication check
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }

  try {
    const rateLimitService = new RateLimitService();
    await rateLimitService.cleanup();

    res.status(200).json({
      success: true,
      message: 'Cleanup completed'
    });
  } catch (error) {
    logger.error('[RateLimit] Cleanup failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'Failed to perform cleanup',
      message: error.message
    });
  }
});

module.exports = router;
