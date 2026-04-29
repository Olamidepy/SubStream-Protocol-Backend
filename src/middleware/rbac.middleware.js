const { AuthService } = require('../services/auth.service');
const { OrganizationService } = require('../services/organization.service');

class RbacMiddleware {
  constructor() {
    this.authService = new AuthService();
    this.organizationService = new OrganizationService();
  }

  async authenticateMember(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required',
          timestamp: new Date().toISOString()
        });
      }

      const token = authHeader.substring(7);

      // Verify JWT token
      const payload = this.authService.verifyToken(token);

      // Validate required claims
      if (!payload.sub || !payload.email || !payload.organizationId || !payload.role || !payload.permissions) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token format',
          timestamp: new Date().toISOString()
        });
      }

      // Get member from database
      const member = await this.organizationService.getMemberById(payload.sub);
      
      if (!member) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Member not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if member is active
      if (member.status !== 'ACTIVE') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Account is not active',
          timestamp: new Date().toISOString()
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(payload.email)) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        });
      }

      // Validate role
      const validRoles = ['ADMIN', 'VIEWER', 'BILLING_MANAGER'];
      if (!validRoles.includes(payload.role)) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid role',
          timestamp: new Date().toISOString()
        });
      }

      // Set request context
      req.member = member;
      req.organizationId = member.organizationId;
      req.tenantId = member.organizationId; // Tenant isolation
      req.token = token;

      next();
    } catch (error) {
      console.error('Authentication error:', error);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
        timestamp: new Date().toISOString()
      });
    }
  }

  requirePermission(permission) {
    return async (req, res, next) => {
      try {
        if (!req.member) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required',
            timestamp: new Date().toISOString()
          });
        }

        if (!req.member.permissions || !req.member.permissions.includes(permission)) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Insufficient permissions',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('Permission check error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Permission check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  requireAnyPermission(permissions) {
    return async (req, res, next) => {
      try {
        if (!req.member) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required',
            timestamp: new Date().toISOString()
          });
        }

        const hasPermission = permissions.some(permission => 
          req.member.permissions && req.member.permissions.includes(permission)
        );

        if (!hasPermission) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Insufficient permissions',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('Permission check error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Permission check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  requireMinimumRole(minimumRole) {
    const roleHierarchy = {
      'VIEWER': 1,
      'BILLING_MANAGER': 2,
      'ADMIN': 3
    };

    return async (req, res, next) => {
      try {
        if (!req.member) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required',
            timestamp: new Date().toISOString()
          });
        }

        const memberRoleLevel = roleHierarchy[req.member.role] || 0;
        const requiredRoleLevel = roleHierarchy[minimumRole] || 0;

        if (memberRoleLevel < requiredRoleLevel) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Insufficient role level',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('Role check error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Role check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  requireTenantAccess(tenantId) {
    return async (req, res, next) => {
      try {
        if (!req.member) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required',
            timestamp: new Date().toISOString()
          });
        }

        if (req.tenantId !== tenantId) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Tenant access denied',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('Tenant access error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Tenant access check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  requireOrganizationAccess(organizationId) {
    return async (req, res, next) => {
      try {
        if (!req.member) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Authentication required',
            timestamp: new Date().toISOString()
          });
        }

        if (req.organizationId !== organizationId) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Organization access denied',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('Organization access error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Organization access check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  async validateApiKey(req, res, next) {
    try {
      const apiKey = req.headers['x-api-key'];
      
      if (!apiKey) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'API key required',
          timestamp: new Date().toISOString()
        });
      }

      const payload = this.authService.verifyApiKey(apiKey);
      
      const member = await this.organizationService.getMemberById(payload.sub);
      
      if (!member || member.status !== 'ACTIVE') {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid API key',
          timestamp: new Date().toISOString()
        });
      }

      req.member = member;
      req.organizationId = member.organizationId;
      req.tenantId = member.organizationId;
      req.apiKey = apiKey;
      req.apiPermissions = payload.permissions || [];

      next();
    } catch (error) {
      console.error('API key validation error:', error);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API key',
        timestamp: new Date().toISOString()
      });
    }
  }

  async requireApiKeyPermission(permission) {
    return async (req, res, next) => {
      try {
        if (!req.apiPermissions || !req.apiPermissions.includes(permission)) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Insufficient API key permissions',
            timestamp: new Date().toISOString()
          });
        }

        next();
      } catch (error) {
        console.error('API key permission check error:', error);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'API key permission check failed',
          timestamp: new Date().toISOString()
        });
      }
    };
  }

  async auditLog(req, res, next) {
    try {
      const auditData = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        memberId: req.member?.id,
        organizationId: req.organizationId,
        tenantId: req.tenantId,
        action: this.getActionFromUrl(req.originalUrl),
        success: true
      };

      // Log audit data (in production, this would go to a secure audit log)
      console.log('AUDIT:', JSON.stringify(auditData));

      next();
    } catch (error) {
      console.error('Audit log error:', error);
      next(); // Continue even if audit fails
    }
  }

  getActionFromUrl(url) {
    const actionMap = {
      '/organizations': 'org:read',
      '/organizations/': 'org:write',
      '/members': 'members:read',
      '/members/': 'members:write',
      '/invitations': 'invitations:read',
      '/invitations/': 'invitations:write',
      '/merchants': 'merchants:read',
      '/merchants/': 'merchants:write',
      '/billing': 'billing:read',
      '/billing/': 'billing:write',
      '/analytics': 'analytics:read',
      '/treasury': 'treasury:read',
      '/treasury/': 'treasury:write'
    };

    for (const [pattern, action] of Object.entries(actionMap)) {
      if (url.includes(pattern)) {
        return action;
      }
    }

    return 'unknown';
  }

  async rateLimitCheck(req, res, next) {
    try {
      // Basic rate limiting - in production, use Redis or similar
      const memberId = req.member?.id;
      const key = `rate_limit:${memberId}:${Math.floor(Date.now() / 60000)}`; // Per minute

      // This is a simplified version - in production, use proper rate limiting
      const maxRequestsPerMinute = 1000; // Adjust based on role and plan
      
      // For now, just pass through
      next();
    } catch (error) {
      console.error('Rate limit check error:', error);
      next(); // Continue even if rate limiting fails
    }
  }
}

// Create singleton instance
const rbacMiddleware = new RbacMiddleware();

module.exports = { rbacMiddleware, RbacMiddleware };
