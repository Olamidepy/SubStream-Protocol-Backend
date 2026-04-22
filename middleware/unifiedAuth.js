const jwt = require('jsonwebtoken');
const { authenticateToken: ethAuthenticateToken, requireTier } = require('./auth');
const { authenticateStellarToken } = require('./stellarAuth');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * Unified authentication middleware that supports both Ethereum and Stellar tokens
 * Checks for token type and validates accordingly
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  try {
    // Decode token to check type without verification
    const decoded = jwt.decode(token);
    
    if (!decoded || !decoded.type) {
      // Default to Ethereum authentication for backward compatibility
      return ethAuthenticateToken(req, res, next);
    }

    // Route to appropriate authentication based on token type
    if (decoded.type === 'stellar') {
      return authenticateStellarToken(req, res, next);
    } else if (decoded.type === 'ethereum' || !decoded.type) {
      return ethAuthenticateToken(req, res, next);
    } else {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid token type' 
      });
    }
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: 'Invalid token format' 
    });
  }
};

/**
 * Middleware to require specific authentication type
 */
const requireAuthType = (type) => {
  return (req, res, next) => {
    if (!req.user || !req.user.type) {
      return res.status(403).json({ 
        success: false, 
        error: 'Authentication type not found' 
      });
    }

    if (req.user.type !== type) {
      return res.status(403).json({ 
        success: false, 
        error: `${type} authentication required` 
      });
    }

    next();
  };
};

/**
 * Middleware to require Stellar authentication specifically
 */
const requireStellarAuth = requireAuthType('stellar');

/**
 * Middleware to require Ethereum authentication specifically
 */
const requireEthereumAuth = requireAuthType('ethereum');

/**
 * Get user identifier (address or publicKey) regardless of auth type
 */
const getUserId = (user) => {
  if (!user) return null;
  return user.address || user.publicKey;
};

/**
 * Check if user has required tier (works for both auth types)
 */
const hasRequiredTier = (user, requiredTier) => {
  if (!user || !user.tier) return false;
  
  const tierHierarchy = { bronze: 1, silver: 2, gold: 3 };
  const userTierLevel = tierHierarchy[user.tier] || 0;
  const requiredTierLevel = tierHierarchy[requiredTier] || 0;
  
  return userTierLevel >= requiredTierLevel;
};

/**
 * Enhanced tier-based access middleware that works with both auth types
 */
const requireTierUnified = (requiredTier) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }

    if (!hasRequiredTier(req.user, requiredTier)) {
      return res.status(403).json({ 
        success: false, 
        error: `${requiredTier} tier required` 
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  requireAuthType,
  requireStellarAuth,
  requireEthereumAuth,
  getUserId,
  hasRequiredTier,
  requireTierUnified,
  // Export original middleware for specific use cases
  ethAuthenticateToken,
  authenticateStellarToken
};
