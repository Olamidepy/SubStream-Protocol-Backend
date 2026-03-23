const express = require('express');
const router = express.Router();
const { generateNonce, nonces, verifySignature, generateToken } = require('../middleware/auth');

// Get nonce for SIWE
router.get('/nonce', (req, res) => {
  const { address } = req.query;
  
  if (!address) {
    return res.status(400).json({
      success: false,
      error: 'Wallet address required'
    });
  }
  
  const nonce = generateNonce();
  nonces.set(address.toLowerCase(), {
    nonce,
    timestamp: Date.now(),
    used: false
  });
  
  res.json({
    success: true,
    nonce,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
  });
});

// Login with SIWE signature
router.post('/login', (req, res) => {
  try {
    const { address, signature, message, nonce } = req.body;
    
    if (!address || !signature || !message || !nonce) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: address, signature, message, nonce'
      });
    }
    
    const normalizedAddress = address.toLowerCase();
    const storedNonce = nonces.get(normalizedAddress);
    
    // Validate nonce
    if (!storedNonce || storedNonce.nonce !== nonce || storedNonce.used) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired nonce'
      });
    }
    
    // Check nonce expiration (5 minutes)
    if (Date.now() - storedNonce.timestamp > 5 * 60 * 1000) {
      nonces.delete(normalizedAddress);
      return res.status(400).json({
        success: false,
        error: 'Nonce expired'
      });
    }
    
    // Verify signature
    const isValidSignature = verifySignature(message, signature, address);
    
    if (!isValidSignature) {
      return res.status(400).json({
        success: false,
        error: 'Invalid signature'
      });
    }
    
    // Mark nonce as used
    storedNonce.used = true;
    
    // Determine user tier (in production, fetch from database)
    // For now, assign bronze tier to all users
    const userTier = 'bronze';
    
    // Generate JWT token
    const token = generateToken(address, userTier);
    
    res.json({
      success: true,
      token,
      user: {
        address: normalizedAddress,
        tier: userTier
      },
      expiresIn: 86400 // 24 hours
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;
