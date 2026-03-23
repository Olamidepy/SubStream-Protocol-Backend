const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Generate nonce for SIWE
const generateNonce = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// Store nonces (in production, use Redis)
const nonces = new Map();

// Verify SIWE signature
const verifySignature = (message, signature, address) => {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === address.toLowerCase();
  } catch (error) {
    return false;
  }
};

// Generate JWT token
const generateToken = (address, tier = 'bronze') => {
  return jwt.sign(
    { 
      address: address.toLowerCase(),
      tier,
      iat: Math.floor(Date.now() / 1000)
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
};

// Verify JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }
    req.user = user;
    next();
  });
};

// Tier-based access middleware
const requireTier = (requiredTier) => {
  const tierHierarchy = { bronze: 1, silver: 2, gold: 3 };
  
  return (req, res, next) => {
    const userTier = req.user?.tier || 'bronze';
    
    if (tierHierarchy[userTier] < tierHierarchy[requiredTier]) {
      return res.status(403).json({ 
        success: false, 
        error: `Access denied. ${requiredTier} tier required.` 
      });
    }
    
    next();
  };
};

module.exports = {
  generateNonce,
  nonces,
  verifySignature,
  generateToken,
  authenticateToken,
  requireTier
};
