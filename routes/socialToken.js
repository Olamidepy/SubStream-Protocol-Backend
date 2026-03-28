const express = require('express');
const router = express.Router();
const { authenticateToken, requireCreator } = require('../middleware/auth');
const { logger } = require('../utils/logger');

/**
 * Social Token Gating API Routes
 * Provides endpoints for managing Stellar Asset-based content gating
 */

/**
 * Set social token gating for content (creator only)
 * POST /api/social-token/gating
 */
router.post('/gating', authenticateToken, requireCreator, async (req, res) => {
  try {
    const {
      contentId,
      assetCode,
      assetIssuer,
      minimumBalance,
      verificationInterval = 60000 // 1 minute default
    } = req.body;

    // Validate required fields
    if (!contentId || !assetCode || !assetIssuer || !minimumBalance) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: contentId, assetCode, assetIssuer, minimumBalance',
        code: 'MISSING_FIELDS'
      });
    }

    // Validate numeric fields
    const minBalance = parseFloat(minimumBalance);
    if (isNaN(minBalance) || minBalance <= 0) {
      return res.status(400).json({
        success: false,
        error: 'minimumBalance must be a positive number',
        code: 'INVALID_BALANCE'
      });
    }

    const verifyInterval = parseInt(verificationInterval);
    if (isNaN(verifyInterval) || verifyInterval < 30000) { // Minimum 30 seconds
      return res.status(400).json({
        success: false,
        error: 'verificationInterval must be at least 30 seconds',
        code: 'INVALID_INTERVAL'
      });
    }

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify creator owns the content
    const content = req.database.db.prepare(`
      SELECT creator_address FROM content WHERE id = ?
    `).get(contentId);

    if (!content || content.creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'You can only set gating for your own content',
        code: 'NOT_CONTENT_OWNER'
      });
    }

    // Set up gating
    const gating = await socialTokenService.setContentGating({
      contentId,
      creatorAddress: req.user.address,
      assetCode,
      assetIssuer,
      minimumBalance: minBalance,
      verificationInterval: verifyInterval
    });

    res.status(201).json({
      success: true,
      data: {
        contentId,
        gating,
        message: 'Social token gating enabled successfully'
      }
    });

  } catch (error) {
    logger.error('Set social token gating error', {
      error: error.message,
      creatorAddress: req.user.address,
      contentId: req.body.contentId
    });

    if (error.message.includes('does not exist')) {
      return res.status(400).json({
        success: false,
        error: error.message,
        code: 'ASSET_NOT_FOUND'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to set social token gating',
      code: 'GATING_SETUP_FAILED'
    });
  }
});

/**
 * Update social token gating for content (creator only)
 * PUT /api/social-token/gating/:contentId
 */
router.put('/gating/:contentId', authenticateToken, requireCreator, async (req, res) => {
  try {
    const { contentId } = req.params;
    const {
      assetCode,
      assetIssuer,
      minimumBalance,
      verificationInterval,
      active = true
    } = req.body;

    // Verify creator owns the content
    const content = req.database.db.prepare(`
      SELECT creator_address FROM content WHERE id = ?
    `).get(contentId);

    if (!content || content.creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'You can only update gating for your own content',
        code: 'NOT_CONTENT_OWNER'
      });
    }

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Update gating
    const gating = await socialTokenService.setContentGating({
      contentId,
      creatorAddress: req.user.address,
      assetCode,
      assetIssuer,
      minimumBalance,
      verificationInterval,
      active
    });

    res.json({
      success: true,
      data: {
        contentId,
        gating,
        message: 'Social token gating updated successfully'
      }
    });

  } catch (error) {
    logger.error('Update social token gating error', {
      error: error.message,
      creatorAddress: req.user.address,
      contentId: req.params.contentId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to update social token gating',
      code: 'GATING_UPDATE_FAILED'
    });
  }
});

/**
 * Remove social token gating for content (creator only)
 * DELETE /api/social-token/gating/:contentId
 */
router.delete('/gating/:contentId', authenticateToken, requireCreator, async (req, res) => {
  try {
    const { contentId } = req.params;

    // Verify creator owns the content
    const content = req.database.db.prepare(`
      SELECT creator_address FROM content WHERE id = ?
    `).get(contentId);

    if (!content || content.creator_address !== req.user.address) {
      return res.status(403).json({
        success: false,
        error: 'You can only remove gating for your own content',
        code: 'NOT_CONTENT_OWNER'
      });
    }

    // Deactivate gating
    req.database.db.prepare(`
      UPDATE social_token_gated_content 
      SET active = 0, updated_at = ?
      WHERE content_id = ? AND creator_address = ?
    `).run(new Date().toISOString(), contentId, req.user.address);

    res.json({
      success: true,
      data: {
        contentId,
        message: 'Social token gating removed successfully'
      }
    });

  } catch (error) {
    logger.error('Remove social token gating error', {
      error: error.message,
      creatorAddress: req.user.address,
      contentId: req.params.contentId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to remove social token gating',
      code: 'GATING_REMOVAL_FAILED'
    });
  }
});

/**
 * Get gating requirements for content
 * GET /api/social-token/gating/:contentId
 */
router.get('/gating/:contentId', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const gating = await socialTokenService.getContentGatingRequirements(contentId);

    if (!gating) {
      return res.status(404).json({
        success: false,
        error: 'No gating requirements found for this content',
        code: 'NO_GATING_FOUND'
      });
    }

    res.json({
      success: true,
      data: {
        contentId,
        gating
      }
    });

  } catch (error) {
    logger.error('Get gating requirements error', {
      error: error.message,
      contentId: req.params.contentId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get gating requirements',
      code: 'GATING_FETCH_FAILED'
    });
  }
});

/**
 * Check user access to gated content
 * GET /api/social-token/access/:contentId
 */
router.get('/access/:contentId', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.params;
    const userAddress = req.user.address;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const accessResult = await socialTokenService.checkContentAccess(userAddress, contentId);

    res.json({
      success: true,
      data: {
        contentId,
        userAddress,
        accessResult
      }
    });

  } catch (error) {
    logger.error('Check content access error', {
      error: error.message,
      userAddress: req.user.address,
      contentId: req.params.contentId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to check content access',
      code: 'ACCESS_CHECK_FAILED'
    });
  }
});

/**
 * Start balance re-verification session
 * POST /api/social-token/session
 */
router.post('/session', authenticateToken, async (req, res) => {
  try {
    const { contentId } = req.body;
    const userAddress = req.user.address;

    if (!contentId) {
      return res.status(400).json({
        success: false,
        error: 'contentId is required',
        code: 'CONTENT_ID_REQUIRED'
      });
    }

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Check if content requires token gating
    const accessResult = await socialTokenService.checkContentAccess(userAddress, contentId);

    if (!accessResult.hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        code: 'ACCESS_DENIED',
        details: accessResult
      });
    }

    // Start re-verification session
    const sessionData = await socialTokenService.startBalanceReverification(
      null, // Will generate session ID
      userAddress,
      contentId
    );

    res.status(201).json({
      success: true,
      data: {
        sessionId: sessionData.sessionId,
        contentId,
        userAddress,
        requiresReverification: sessionData.requiresReverification,
        verificationInterval: sessionData.verificationInterval,
        assetInfo: sessionData.requiresReverification ? {
          code: sessionData.assetCode,
          issuer: sessionData.assetIssuer,
          minimumBalance: sessionData.minimumBalance
        } : null
      }
    });

  } catch (error) {
    logger.error('Start re-verification session error', {
      error: error.message,
      userAddress: req.user.address,
      contentId: req.body.contentId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to start re-verification session',
      code: 'SESSION_START_FAILED'
    });
  }
});

/**
 * Re-verify token balance for session
 * POST /api/social-token/session/:sessionId/verify
 */
router.post('/session/:sessionId/verify', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userAddress = req.user.address;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify session belongs to user
    const sessionQuery = `
      SELECT user_address, content_id FROM social_token_sessions 
      WHERE session_id = ? AND still_valid = 1
    `;
    const session = req.database.db.prepare(sessionQuery).get(sessionId);

    if (!session || session.user_address !== userAddress) {
      return res.status(404).json({
        success: false,
        error: 'Session not found or access denied',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Re-verify balance
    const stillValid = await socialTokenService.reverifyBalance(sessionId);

    res.json({
      success: true,
      data: {
        sessionId,
        stillValid,
        contentId: session.content_id,
        verifiedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Re-verify balance error', {
      error: error.message,
      sessionId: req.params.sessionId,
      userAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to re-verify balance',
      code: 'BALANCE_VERIFICATION_FAILED'
    });
  }
});

/**
 * End re-verification session
 * DELETE /api/social-token/session/:sessionId
 */
router.delete('/session/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userAddress = req.user.address;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    // Verify session belongs to user
    const sessionQuery = `
      SELECT user_address FROM social_token_sessions 
      WHERE session_id = ?
    `;
    const session = req.database.db.prepare(sessionQuery).get(sessionId);

    if (!session || session.user_address !== userAddress) {
      return res.status(404).json({
        success: false,
        error: 'Session not found or access denied',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // End session
    const ended = await socialTokenService.endReverificationSession(sessionId);

    res.json({
      success: true,
      data: {
        sessionId,
        ended,
        message: ended ? 'Session ended successfully' : 'Session was not found'
      }
    });

  } catch (error) {
    logger.error('End session error', {
      error: error.message,
      sessionId: req.params.sessionId,
      userAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to end session',
      code: 'SESSION_END_FAILED'
    });
  }
});

/**
 * Validate Stellar Asset
 * POST /api/social-token/validate-asset
 */
router.post('/validate-asset', authenticateToken, async (req, res) => {
  try {
    const { assetCode, assetIssuer } = req.body;

    if (!assetCode || !assetIssuer) {
      return res.status(400).json({
        success: false,
        error: 'assetCode and assetIssuer are required',
        code: 'MISSING_ASSET_DATA'
      });
    }

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const validation = await socialTokenService.verifyAssetExists(assetCode, assetIssuer);

    res.json({
      success: true,
      data: {
        assetCode,
        assetIssuer,
        exists: validation,
        validatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Asset validation error', {
      error: error.message,
      assetCode: req.body.assetCode,
      assetIssuer: req.body.assetIssuer
    });

    res.status(500).json({
      success: false,
      error: 'Failed to validate asset',
      code: 'ASSET_VALIDATION_FAILED'
    });
  }
});

/**
 * Get creator's social token statistics (creator only)
 * GET /api/social-token/stats
 */
router.get('/stats', authenticateToken, requireCreator, async (req, res) => {
  try {
    const creatorAddress = req.user.address;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const stats = await socialTokenService.getCreatorTokenStats(creatorAddress);

    if (!stats) {
      return res.status(404).json({
        success: false,
        error: 'No statistics available',
        code: 'NO_STATS_FOUND'
      });
    }

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Get creator stats error', {
      error: error.message,
      creatorAddress: req.user.address
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get creator statistics',
      code: 'STATS_FETCH_FAILED'
    });
  }
});

/**
 * Get user's token holdings
 * GET /api/social-token/tokens/:assetCode/:assetIssuer
 */
router.get('/tokens/:assetCode/:assetIssuer', authenticateToken, async (req, res) => {
  try {
    const { assetCode, assetIssuer } = req.params;
    const userAddress = req.user.address;

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const balance = await socialTokenService.fetchTokenBalance(userAddress, assetCode, assetIssuer);

    res.json({
      success: true,
      data: {
        userAddress,
        assetCode,
        assetIssuer,
        balance,
        checkedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Get token holdings error', {
      error: error.message,
      userAddress: req.user.address,
      assetCode: req.params.assetCode,
      assetIssuer: req.params.assetIssuer
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get token holdings',
      code: 'TOKEN_HOLDINGS_FAILED'
    });
  }
});

/**
 * Get social token gating statistics (admin only)
 * GET /api/social-token/admin/stats
 */
router.get('/admin/stats', authenticateToken, async (req, res) => {
  try {
    // This should be restricted to admins in production
    const socialTokenMiddleware = req.app.get('socialTokenMiddleware');
    if (!socialTokenMiddleware) {
      return res.status(503).json({
        success: false,
        error: 'Social token middleware not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const stats = await socialTokenMiddleware.getStatistics();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Get admin stats error', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to get admin statistics',
      code: 'ADMIN_STATS_FAILED'
    });
  }
});

/**
 * Force terminate session (admin only)
 * POST /api/social-token/admin/session/:sessionId/terminate
 */
router.post('/admin/session/:sessionId/terminate', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { reason } = req.body;

    // This should be restricted to admins in production
    const socialTokenMiddleware = req.app.get('socialTokenMiddleware');
    if (!socialTokenMiddleware) {
      return res.status(503).json({
        success: false,
        error: 'Social token middleware not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const terminated = await socialTokenMiddleware.terminateSession(sessionId, reason);

    res.json({
      success: true,
      data: {
        sessionId,
        terminated,
        reason: reason || 'Admin termination',
        terminatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Force terminate session error', {
      error: error.message,
      sessionId: req.params.sessionId
    });

    res.status(500).json({
      success: false,
      error: 'Failed to terminate session',
      code: 'SESSION_TERMINATION_FAILED'
    });
  }
});

/**
 * Clean up expired sessions (admin only)
 * POST /api/social-token/admin/cleanup
 */
router.post('/admin/cleanup', authenticateToken, async (req, res) => {
  try {
    const { maxAge = 3600000 } = req.body; // 1 hour default

    const socialTokenService = req.app.get('socialTokenService');
    if (!socialTokenService) {
      return res.status(503).json({
        success: false,
        error: 'Social token service not available',
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const cleanedCount = await socialTokenService.cleanupExpiredSessions(maxAge);

    res.json({
      success: true,
      data: {
        cleanedCount,
        maxAge,
        cleanedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Cleanup sessions error', { error: error.message });

    res.status(500).json({
      success: false,
      error: 'Failed to cleanup sessions',
      code: 'CLEANUP_FAILED'
    });
  }
});

module.exports = router;
