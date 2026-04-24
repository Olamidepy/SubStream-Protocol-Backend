
const express = require('express');
const router = express.Router();
const { PrivacyService } = require('../src/services/privacyService');
const { attachTier } = require('../middleware/tierAuth');

/**
 * Privacy Preferences API
 */
function createPrivacyRoutes({ database }) {
  const privacyService = new PrivacyService(database);

  /**
   * @route PATCH /api/v1/users/privacy
   * @description Update user privacy preferences
   * @access Authenticated
   */
  router.patch('/privacy', attachTier, async (req, res) => {
    try {
      const walletAddress = req.user?.address;
      
      if (!walletAddress) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }

      const { share_email_with_merchants, allow_marketing } = req.body;
      
      const preferences = {};
      if (share_email_with_merchants !== undefined) preferences.share_email_with_merchants = share_email_with_merchants;
      if (allow_marketing !== undefined) preferences.allow_marketing = allow_marketing;

      const updated = await privacyService.updatePreferences(walletAddress, preferences);

      return res.status(200).json({
        success: true,
        data: updated
      });
    } catch (error) {
      console.error('Privacy update error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });

  /**
   * @route GET /api/v1/users/privacy
   * @description Get user privacy preferences
   * @access Authenticated
   */
  router.get('/privacy', attachTier, async (req, res) => {
    try {
      const walletAddress = req.user?.address;
      
      if (!walletAddress) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }

      const preferences = await privacyService.getPreferences(walletAddress);

      return res.status(200).json({
        success: true,
        data: preferences
      });
    } catch (error) {
      console.error('Privacy fetch error:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });

  return router;
}

module.exports = createPrivacyRoutes;
