const { DatabaseService } = require('../db/database.service');

class OrganizationService {
  constructor() {
    this.db = new DatabaseService();
  }

  async createOrganization(data) {
    const result = await this.db.query(
      `INSERT INTO organizations (name, slug, domain, description, created_by) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [data.name, data.slug, data.domain, data.description, data.createdBy]
    );
    return result[0].id;
  }

  async getOrganizationById(id) {
    const result = await this.db.query(
      'SELECT * FROM organizations WHERE id = $1',
      [id]
    );
    return result[0] || null;
  }

  async getOrganizationBySlug(slug) {
    const result = await this.db.query(
      'SELECT * FROM organizations WHERE slug = $1 AND active = true',
      [slug]
    );
    return result[0] || null;
  }

  async updateOrganization(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }
    if (data.domain !== undefined) {
      fields.push(`domain = $${paramIndex++}`);
      values.push(data.domain);
    }
    if (data.description !== undefined) {
      fields.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }
    if (data.active !== undefined) {
      fields.push(`active = $${paramIndex++}`);
      values.push(data.active);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.db.query(
        `UPDATE organizations SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }
  }

  async createMember(data) {
    const result = await this.db.query(
      `INSERT INTO members (organization_id, email, stellar_public_key, role, invited_by, invited_at) 
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id`,
      [data.organizationId, data.email, data.stellarPublicKey, data.role, data.invitedBy]
    );
    return result[0].id;
  }

  async getMemberById(id) {
    const result = await this.db.query(
      'SELECT * FROM members WHERE id = $1',
      [id]
    );
    
    if (!result[0]) return null;
    
    return {
      ...result[0],
      permissions: this.getPermissionsForRole(result[0].role)
    };
  }

  async getMemberByEmail(organizationId, email) {
    const result = await this.db.query(
      'SELECT * FROM members WHERE organization_id = $1 AND email = $2',
      [organizationId, email]
    );
    
    if (!result[0]) return null;
    
    return {
      ...result[0],
      permissions: this.getPermissionsForRole(result[0].role)
    };
  }

  async getMemberByStellarPublicKey(organizationId, stellarPublicKey) {
    const result = await this.db.query(
      'SELECT * FROM members WHERE organization_id = $1 AND stellar_public_key = $2',
      [organizationId, stellarPublicKey]
    );
    
    if (!result[0]) return null;
    
    return {
      ...result[0],
      permissions: this.getPermissionsForRole(result[0].role)
    };
  }

  async getOrganizationMembers(organizationId) {
    const result = await this.db.query(
      'SELECT * FROM members WHERE organization_id = $1 ORDER BY created_at DESC',
      [organizationId]
    );
    
    return result.map(member => ({
      ...member,
      permissions: this.getPermissionsForRole(member.role)
    }));
  }

  async updateMember(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.email !== undefined) {
      fields.push(`email = $${paramIndex++}`);
      values.push(data.email);
    }
    if (data.stellarPublicKey !== undefined) {
      fields.push(`stellar_public_key = $${paramIndex++}`);
      values.push(data.stellarPublicKey);
    }
    if (data.role !== undefined) {
      fields.push(`role = $${paramIndex++}`);
      values.push(data.role);
    }
    if (data.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.lastLoginAt !== undefined) {
      fields.push(`last_login_at = $${paramIndex++}`);
      values.push(data.lastLoginAt);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.db.query(
        `UPDATE members SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }
  }

  async activateMember(id, stellarPublicKey) {
    await this.db.query(
      `UPDATE members 
       SET stellar_public_key = $1, status = 'ACTIVE', email_verified = true, joined_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [stellarPublicKey, id]
    );
  }

  async removeMember(id) {
    await this.db.query('DELETE FROM members WHERE id = $1', [id]);
  }

  async createInvitation(data) {
    const token = this.generateInvitationToken();
    const expiresInDays = data.expiresInDays || 7;
    
    const result = await this.db.query(
      `INSERT INTO invitations (organization_id, invited_by, email, role, token, expires_at, message) 
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + INTERVAL '${expiresInDays} days', $6) RETURNING id`,
      [data.organizationId, data.invitedBy, data.email, data.role, token, data.message]
    );
    return result[0].id;
  }

  async getInvitationByToken(token) {
    const result = await this.db.query(
      'SELECT * FROM invitations WHERE token = $1',
      [token]
    );
    return result[0] || null;
  }

  async getPendingInvitations(organizationId) {
    const result = await this.db.query(
      `SELECT * FROM invitations 
       WHERE organization_id = $1 AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP
       ORDER BY created_at DESC`,
      [organizationId]
    );
    return result;
  }

  async updateInvitationStatus(id, status) {
    await this.db.query(
      'UPDATE invitations SET status = $1 WHERE id = $2',
      [status, id]
    );
  }

  async memberHasPermission(memberId, permission) {
    const member = await this.getMemberById(memberId);
    if (!member || member.status !== 'ACTIVE') return false;
    
    return member.permissions.includes(permission);
  }

  getPermissionsForRole(role) {
    const rolePermissions = {
      'ADMIN': [
        'org:read', 'org:write', 'org:delete',
        'members:read', 'members:write', 'members:delete', 'members:invite',
        'merchants:read', 'merchants:write', 'merchants:delete',
        'billing:read', 'billing:write', 'billing:delete',
        'analytics:read', 'treasury:read', 'treasury:write'
      ],
      'VIEWER': [
        'org:read', 'members:read',
        'merchants:read', 'billing:read',
        'analytics:read', 'treasury:read'
      ],
      'BILLING_MANAGER': [
        'org:read', 'members:read',
        'merchants:read', 'billing:read', 'billing:write',
        'analytics:read', 'treasury:read'
      ]
    };
    
    return rolePermissions[role] || [];
  }

  generateInvitationToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }
}

module.exports = { OrganizationService };
