const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class AuthService {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    this.jwtIssuer = process.env.JWT_ISSUER || 'stellar-privacy';
    this.jwtAudience = process.env.JWT_AUDIENCE || 'stellar-api';
    this.jwtExpiration = process.env.JWT_EXPIRATION || '24h';
  }

  generateMemberToken(member) {
    const payload = {
      sub: member.id,
      email: member.email,
      organizationId: member.organizationId,
      role: member.role,
      permissions: member.permissions,
      tenantId: member.organizationId, // Tenant isolation
      sessionId: this.generateSessionId(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
      jti: this.generateJwtId(),
      iss: this.jwtIssuer,
      aud: this.jwtAudience
    };

    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: this.jwtExpiration
    });
  }

  generateRefreshToken(memberId) {
    const payload = {
      sub: memberId,
      type: 'refresh',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
      jti: this.generateJwtId()
    };

    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
        algorithms: ['HS256']
      });
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  verifyRefreshToken(refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret, {
        algorithms: ['HS256']
      });
      
      if (payload.type !== 'refresh') {
        throw new Error('Invalid refresh token');
      }
      
      return payload;
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
  }

  generateApiKey(memberId, permissions = []) {
    const apiKeyId = this.generateApiKeyId();
    const payload = {
      sub: memberId,
      type: 'api_key',
      permissions,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year
      jti: apiKeyId
    };

    const apiKey = jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });

    return {
      apiKey,
      apiKeyId,
      expiresAt: new Date(payload.exp * 1000)
    };
  }

  verifyApiKey(apiKey) {
    try {
      const payload = jwt.verify(apiKey, this.jwtSecret, {
        algorithms: ['HS256']
      });
      
      if (payload.type !== 'api_key') {
        throw new Error('Invalid API key');
      }
      
      return payload;
    } catch (error) {
      throw new Error('Invalid API key');
    }
  }

  generateSessionToken(member) {
    const sessionId = this.generateSessionId();
    const payload = {
      sub: member.id,
      type: 'session',
      sessionId,
      organizationId: member.organizationId,
      tenantId: member.organizationId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (8 * 60 * 60), // 8 hours
      jti: sessionId
    };

    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });
  }

  revokeToken(tokenId) {
    // In a real implementation, you would add the token to a revocation list
    // For now, we'll just return success
    return true;
  }

  isTokenRevoked(tokenId) {
    // In a real implementation, you would check against a revocation list
    return false;
  }

  validateStellarSignature(publicKey, signature, message) {
    // In a real implementation, you would verify the Stellar signature
    // For now, we'll just validate the format
    if (!publicKey || !signature || !message) {
      return false;
    }

    // Validate Stellar public key format
    if (!/^G[A-Z0-9]{55}$/.test(publicKey)) {
      return false;
    }

    // Validate signature format
    if (!/^[a-fA-F0-9]{128}$/.test(signature)) {
      return false;
    }

    // TODO: Implement actual Stellar signature verification
    // This would use the Stellar SDK to verify the signature
    return true;
  }

  generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateJwtId() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateApiKeyId() {
    return `api_${crypto.randomBytes(16).toString('hex')}`;
  }

  generateInvitationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  hashPassword(password) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { salt, hash };
  }

  verifyPassword(password, salt, hash) {
    const crypto = require('crypto');
    const hashVerify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === hashVerify;
  }

  extractTokenFromHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.substring(7);
  }

  decodeTokenWithoutVerification(token) {
    try {
      return jwt.decode(token, { complete: true });
    } catch (error) {
      return null;
    }
  }

  getTokenExpiration(token) {
    try {
      const decoded = jwt.decode(token);
      return decoded.exp ? new Date(decoded.exp * 1000) : null;
    } catch (error) {
      return null;
    }
  }

  isTokenExpired(token) {
    const expiration = this.getTokenExpiration(token);
    return expiration ? expiration < new Date() : true;
  }

  refreshTokenIfNeeded(token) {
    if (this.isTokenExpired(token)) {
      throw new Error('Token has expired');
    }

    const decoded = this.decodeTokenWithoutVerification(token);
    if (!decoded) {
      throw new Error('Invalid token');
    }

    // Check if token is expiring within the next hour
    const expiration = new Date(decoded.payload.exp * 1000);
    const oneHourFromNow = new Date(Date.now() + (60 * 60 * 1000));

    if (expiration < oneHourFromNow) {
      // Token is expiring soon, refresh it
      return this.generateRefreshToken(decoded.payload.sub);
    }

    return null;
  }
}

module.exports = { AuthService };
