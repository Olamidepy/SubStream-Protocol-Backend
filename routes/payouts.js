const express = require('express');
const router = express.Router();

// GET /api/payouts?creator_address=...
router.get('/', (req, res) => {
  const db = req.app.get('db');
  const { creator_address } = req.query;
  try {
    const payouts = db.getPayouts(creator_address);
    res.json({ payouts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

module.exports = router;
