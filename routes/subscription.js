const express = require('express');
const router = express.Router();

// POST /api/subscription/events - receive subscription events from a chain listener
router.post('/events', async (req, res) => {
  try {
    const app = req.app; // express app
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService) {
      return res.status(503).json({ success: false, error: 'Subscription service not configured' });
    }

    // Optional shared secret validation
    const secretHeader = req.get('x-substream-secret');
    const configured = process.env.SUBSCRIPTION_EVENT_SECRET;
    if (configured && configured.length > 0 && secretHeader !== configured) {
      return res.status(403).json({ success: false, error: 'Invalid subscription event secret' });
    }

    const { type, creatorId, walletAddress, timestamp, ipAddress } = req.body || {};

    if (!type || !creatorId) {
      return res.status(400).json({ success: false, error: 'Missing required fields: type, creatorId' });
    }

    const result = await subscriptionService.handleEvent({ type, creatorId, walletAddress, timestamp, ipAddress });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Subscription event handler error:', error && error.stack ? error.stack : error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to process event' });
  }
});

module.exports = router;
