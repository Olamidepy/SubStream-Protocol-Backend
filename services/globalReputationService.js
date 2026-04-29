const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../src/db/knex');
const { logger } = require('../src/utils/logger');

class GlobalReputationService {
  constructor() {
    this.defaultFlagWeights = {
      malicious_dispute: -15,
      allowance_exploitation: -20,
      fraud_detection: -25,
      spam_activity: -5,
      manual_flag: -10,
      manual_unflag: 5,
      score_adjustment: 0
    };
    
    this.riskThresholds = {
      low: { min: 80, max: 100 },
      medium: { min: 60, max: 79 },
      high: { min: 30, max: 59 },
      critical: { min: 0, max: 29 }
    };
  }

  /**
   * Flag a user for malicious behavior across the protocol
   */
  async flagUser(params) {
    const {
      tenant_id,
      wallet_address,
      flag_type,
      reason,
      flagged_by_user_id,
      pii_data = null, // Optional PII for hashing
      metadata = {}
    } = params;

    try {
      // Validate inputs
      this.validateFlagInput({ wallet_address, flag_type, reason });

      // Get or create global reputation record
      let reputationRecord = await this.getOrCreateReputationRecord(wallet_address, pii_data);

      // Get tenant settings
      const tenantSettings = await this.getTenantSettings(tenant_id);
      
      // Calculate flag weight
      const flagWeight = this.calculateFlagWeight(flag_type, tenantSettings);

      // Update reputation score
      const previousScore = reputationRecord.reputation_score;
      const newScore = Math.max(0, Math.min(100, previousScore + flagWeight));
      const scoreImpact = flagWeight;

      // Update reputation record
      await db('global_reputation_scores')
        .where({ id: reputationRecord.id })
        .update({
          reputation_score: newScore,
          risk_level: this.calculateRiskLevel(newScore),
          total_flags: db.raw('total_flags + 1'),
          [`${flag_type}_flags`]: db.raw(`${flag_type}_flags + 1`),
          last_flagged_at: new Date(),
          updated_at: new Date()
        });

      // Add reputation event
      await this.addReputationEvent({
        global_reputation_id: reputationRecord.id,
        tenant_id,
        wallet_address,
        event_type: flag_type,
        score_impact: scoreImpact,
        previous_score: previousScore,
        new_score: newScore,
        reason,
        event_metadata: metadata,
        flagged_by_user_id
      });

      // Check if review is needed
      await this.checkReviewNeeded(reputationRecord.id, tenant_id);

      // Update flag details
      await this.updateFlagDetails(reputationRecord.id, {
        flag_type,
        tenant_id,
        reason,
        timestamp: new Date(),
        score_impact: scoreImpact
      });

      logger.info('User flagged in global reputation system', {
        wallet_address,
        flag_type,
        score_impact: scoreImpact,
        new_score: newScore,
        tenant_id
      });

      return {
        success: true,
        reputation_score: newScore,
        risk_level: this.calculateRiskLevel(newScore),
        score_impact: scoreImpact,
        previous_score: previousScore
      };

    } catch (error) {
      logger.error('Error flagging user in global reputation:', error);
      throw error;
    }
  }

  /**
   * Check user reputation before allowing subscription
   */
  async checkUserReputation(wallet_address, tenant_id) {
    try {
      // Get reputation record
      const reputation = await db('global_reputation_scores')
        .where({ wallet_address: wallet_address.toLowerCase() })
        .first();

      if (!reputation) {
        return {
          allowed: true,
          reason: 'No reputation record found',
          reputation_score: 100,
          risk_level: 'low'
        };
      }

      // Get tenant settings
      const tenantSettings = await this.getTenantSettings(tenant_id);

      // Check if tenant participates in global reputation
      if (!tenantSettings.global_reputation_enabled) {
        return {
          allowed: true,
          reason: 'Tenant does not participate in global reputation',
          reputation_score: reputation.reputation_score,
          risk_level: reputation.risk_level
        };
      }

      // Check warning threshold
      if (reputation.reputation_score < tenantSettings.warning_threshold) {
        const result = {
          allowed: true,
          warning: true,
          reason: `User has low reputation score (${reputation.reputation_score})`,
          reputation_score: reputation.reputation_score,
          risk_level: reputation.risk_level,
          total_flags: reputation.total_flags
        };

        // Check auto-rejection
        if (tenantSettings.auto_rejection_enabled && 
            reputation.reputation_score < tenantSettings.blocking_threshold) {
          result.allowed = false;
          result.auto_rejected = true;
          result.reason = `User automatically rejected due to low reputation score (${reputation.reputation_score})`;
        }

        return result;
      }

      return {
        allowed: true,
        reputation_score: reputation.reputation_score,
        risk_level: reputation.risk_level
      };

    } catch (error) {
      logger.error('Error checking user reputation:', error);
      // Fail open - allow subscription if reputation check fails
      return {
        allowed: true,
        reason: 'Reputation check failed',
        reputation_score: 100,
        risk_level: 'low'
      };
    }
  }

  /**
   * Get reputation history for a user
   */
  async getReputationHistory(wallet_address, limit = 50) {
    try {
      const reputation = await db('global_reputation_scores')
        .where({ wallet_address: wallet_address.toLowerCase() })
        .first();

      if (!reputation) {
        return {
          reputation_score: 100,
          risk_level: 'low',
          total_flags: 0,
          events: []
        };
      }

      const events = await db('reputation_events')
        .where({ wallet_address: wallet_address.toLowerCase() })
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select([
          'event_type',
          'score_impact',
          'previous_score',
          'new_score',
          'reason',
          'created_at',
          'flagged_by_tenant_name'
        ]);

      return {
        reputation_score: reputation.reputation_score,
        risk_level: reputation.risk_level,
        total_flags: reputation.total_flags,
        flag_breakdown: {
          malicious_dispute: reputation.malicious_dispute_flags,
          allowance_exploitation: reputation.allowance_exploitation_flags,
          fraud_flags: reputation.fraud_flags,
          spam_flags: reputation.spam_flags
        },
        events,
        last_flagged_at: reputation.last_flagged_at,
        created_at: reputation.created_at
      };

    } catch (error) {
      logger.error('Error getting reputation history:', error);
      throw error;
    }
  }

  /**
   * Get reputation analytics for a tenant
   */
  async getTenantReputationAnalytics(tenant_id) {
    try {
      const analytics = {
        total_flagged_users: 0,
        risk_level_distribution: { low: 0, medium: 0, high: 0, critical: 0 },
        flag_type_distribution: {},
        recent_flags: [],
        global_comparison: null
      };

      // Get users flagged by this tenant
      const flaggedUsers = await db('reputation_events')
        .where({ tenant_id })
        .where('event_type', 'in', ['malicious_dispute', 'allowance_exploitation', 'fraud_detection', 'spam_activity'])
        .distinct('wallet_address')
        .select('wallet_address');

      analytics.total_flagged_users = flaggedUsers.length;

      // Get risk level distribution
      const riskDistribution = await db('global_reputation_scores')
        .whereIn('wallet_address', flaggedUsers.map(u => u.wallet_address))
        .select('risk_level')
        .groupBy('risk_level')
        .count('* as count');

      riskDistribution.forEach(row => {
        analytics.risk_level_distribution[row.risk_level] = parseInt(row.count);
      });

      // Get flag type distribution
      const flagDistribution = await db('reputation_events')
        .where({ tenant_id })
        .where('event_type', 'in', ['malicious_dispute', 'allowance_exploitation', 'fraud_detection', 'spam_activity'])
        .select('event_type')
        .groupBy('event_type')
        .count('* as count');

      flagDistribution.forEach(row => {
        analytics.flag_type_distribution[row.event_type] = parseInt(row.count);
      });

      // Get recent flags
      analytics.recent_flags = await db('reputation_events')
        .where({ tenant_id })
        .where('event_type', 'in', ['malicious_dispute', 'allowance_exploitation', 'fraud_detection', 'spam_activity'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .select([
          'wallet_address',
          'event_type',
          'reason',
          'created_at'
        ]);

      // Get global comparison
      const globalStats = await this.getGlobalReputationStats();
      analytics.global_comparison = globalStats;

      return analytics;

    } catch (error) {
      logger.error('Error getting tenant reputation analytics:', error);
      throw error;
    }
  }

  /**
   * Get global reputation statistics
   */
  async getGlobalReputationStats() {
    try {
      const stats = {
        total_tracked_users: 0,
        average_reputation_score: 0,
        risk_level_distribution: { low: 0, medium: 0, high: 0, critical: 0 },
        total_flags: 0,
        recent_activity: []
      };

      // Get total tracked users
      const totalUsers = await db('global_reputation_scores')
        .count('* as count')
        .first();
      stats.total_tracked_users = parseInt(totalUsers.count);

      // Get average reputation score
      const avgScore = await db('global_reputation_scores')
        .avg('reputation_score as avg_score')
        .first();
      stats.average_reputation_score = parseFloat(avgScore.avg_score || 100);

      // Get risk level distribution
      const riskDistribution = await db('global_reputation_scores')
        .select('risk_level')
        .groupBy('risk_level')
        .count('* as count');

      riskDistribution.forEach(row => {
        stats.risk_level_distribution[row.risk_level] = parseInt(row.count);
      });

      // Get total flags
      const totalFlags = await db('global_reputation_scores')
        .sum('total_flags as total')
        .first();
      stats.total_flags = parseInt(totalFlags.total || 0);

      // Get recent activity
      stats.recent_activity = await db('reputation_events')
        .orderBy('created_at', 'desc')
        .limit(20)
        .select([
          'wallet_address',
          'event_type',
          'score_impact',
          'reason',
          'created_at',
          'flagged_by_tenant_name'
        ]);

      return stats;

    } catch (error) {
      logger.error('Error getting global reputation stats:', error);
      throw error;
    }
  }

  /**
   * Manual review and adjustment of reputation score
   */
  async reviewAndAdjust(params) {
    const {
      tenant_id,
      wallet_address,
      review_decision,
      adjustment_score,
      review_notes,
      reviewed_by_user_id
    } = params;

    try {
      const reputation = await db('global_reputation_scores')
        .where({ wallet_address: wallet_address.toLowerCase() })
        .first();

      if (!reputation) {
        throw new Error('Reputation record not found');
      }

      const previousScore = reputation.reputation_score;
      const newScore = adjustment_score !== undefined 
        ? Math.max(0, Math.min(100, adjustment_score))
        : previousScore;

      // Update reputation record
      await db('global_reputation_scores')
        .where({ id: reputation.id })
        .update({
          reputation_score: newScore,
          risk_level: this.calculateRiskLevel(newScore),
          last_reviewed_at: new Date(),
          last_reviewed_by_tenant: tenant_id,
          review_notes,
          updated_at: new Date()
        });

      // Add review event
      await this.addReputationEvent({
        global_reputation_id: reputation.id,
        tenant_id,
        wallet_address,
        event_type: 'review_completed',
        score_impact: newScore - previousScore,
        previous_score: previousScore,
        new_score: newScore,
        reason: review_notes,
        event_metadata: { review_decision },
        flagged_by_user_id: reviewed_by_user_id
      });

      // Remove from review queue if present
      await db('reputation_review_queue')
        .where({ global_reputation_id: reputation.id })
        .update({
          status: 'resolved',
          review_decision,
          review_notes,
          review_completed_at: new Date(),
          reviewed_by_user_id
        });

      logger.info('Reputation review completed', {
        wallet_address,
        previous_score: previousScore,
        new_score: newScore,
        review_decision,
        tenant_id
      });

      return {
        success: true,
        previous_score: previousScore,
        new_score: newScore,
        risk_level: this.calculateRiskLevel(newScore)
      };

    } catch (error) {
      logger.error('Error in reputation review:', error);
      throw error;
    }
  }

  /**
   * Get or create reputation record
   */
  async getOrCreateReputationRecord(wallet_address, pii_data = null) {
    let record = await db('global_reputation_scores')
      .where({ wallet_address: wallet_address.toLowerCase() })
      .first();

    if (!record) {
      // Create new record
      const [newRecord] = await db('global_reputation_scores')
        .insert({
          wallet_address: wallet_address.toLowerCase(),
          hashed_identifier: pii_data ? this.hashPII(pii_data) : null,
          reputation_score: 100.00,
          risk_level: 'low',
          total_flags: 0,
          malicious_dispute_flags: 0,
          allowance_exploitation_flags: 0,
          fraud_flags: 0,
          spam_flags: 0,
          flag_details: []
        })
        .returning('*');
      
      record = newRecord;
    }

    return record;
  }

  /**
   * Add reputation event
   */
  async addReputationEvent(params) {
    const {
      global_reputation_id,
      tenant_id,
      wallet_address,
      event_type,
      score_impact,
      previous_score,
      new_score,
      reason,
      event_metadata,
      flagged_by_user_id
    } = params;

    // Get tenant name for audit trail
    const tenant = await db('tenants')
      .where({ id: tenant_id })
      .first();

    await db('reputation_events').insert({
      global_reputation_id,
      tenant_id,
      wallet_address: wallet_address.toLowerCase(),
      event_type,
      score_impact,
      previous_score,
      new_score,
      reason,
      event_metadata,
      flagged_by_tenant_name: tenant?.name || 'Unknown',
      flagged_by_user_id
    });
  }

  /**
   * Update flag details
   */
  async updateFlagDetails(reputationId, flagDetail) {
    const record = await db('global_reputation_scores')
      .where({ id: reputationId })
      .first();

    const flagDetails = record.flag_details || [];
    flagDetails.push(flagDetail);

    await db('global_reputation_scores')
      .where({ id: reputationId })
      .update({
        flag_details: JSON.stringify(flagDetails)
      });
  }

  /**
   * Check if review is needed
   */
  async checkReviewNeeded(reputationId, tenantId) {
    const reputation = await db('global_reputation_scores')
      .where({ id: reputationId })
      .first();

    const tenantSettings = await this.getTenantSettings(tenantId);

    // Check if flags exceed threshold
    if (reputation.total_flags >= tenantSettings.flags_required_for_review) {
      // Check if already in review queue
      const existingReview = await db('reputation_review_queue')
        .where({ 
          global_reputation_id: reputationId,
          status: 'pending'
        })
        .first();

      if (!existingReview) {
        // Add to review queue
        await db('reputation_review_queue').insert({
          global_reputation_id: reputationId,
          assigned_to_tenant_id: tenantId,
          priority: this.calculateReviewPriority(reputation),
          status: 'pending',
          review_reason: `User has ${reputation.total_flags} flags, exceeding threshold of ${tenantSettings.flags_required_for_review}`,
          assigned_at: new Date()
        });
      }
    }
  }

  /**
   * Calculate review priority
   */
  calculateReviewPriority(reputation) {
    if (reputation.risk_level === 'critical') return 'urgent';
    if (reputation.risk_level === 'high') return 'high';
    if (reputation.risk_level === 'medium') return 'medium';
    return 'low';
  }

  /**
   * Calculate flag weight based on tenant settings
   */
  calculateFlagWeight(flagType, tenantSettings) {
    if (tenantSettings.custom_flag_weights) {
      const weights = typeof tenantSettings.custom_flag_weights === 'string'
        ? JSON.parse(tenantSettings.custom_flag_weights)
        : tenantSettings.custom_flag_weights;
      
      return weights[flagType] || this.defaultFlagWeights[flagType] || -10;
    }
    
    return this.defaultFlagWeights[flagType] || -10;
  }

  /**
   * Calculate risk level based on score
   */
  calculateRiskLevel(score) {
    if (score >= this.riskThresholds.low.min) return 'low';
    if (score >= this.riskThresholds.medium.min) return 'medium';
    if (score >= this.riskThresholds.high.min) return 'high';
    return 'critical';
  }

  /**
   * Get tenant settings
   */
  async getTenantSettings(tenantId) {
    let settings = await db('tenant_reputation_settings')
      .where({ tenant_id: tenantId })
      .first();

    if (!settings) {
      // Create default settings
      const [newSettings] = await db('tenant_reputation_settings')
        .insert({
          tenant_id: tenantId,
          global_reputation_enabled: true,
          warning_threshold: 70.00,
          blocking_threshold: 30.00,
          auto_rejection_enabled: false,
          flags_required_for_review: 3
        })
        .returning('*');
      
      settings = newSettings;
    }

    return settings;
  }

  /**
   * Hash PII for privacy compliance
   */
  hashPII(piiData) {
    const hashInput = JSON.stringify(piiData) + process.env.REPUTATION_HASH_SALT || 'default-salt';
    return crypto.createHash('sha256').update(hashInput).digest('hex');
  }

  /**
   * Validate flag input
   */
  validateFlagInput(params) {
    const { wallet_address, flag_type, reason } = params;
    
    if (!wallet_address) throw new Error('Wallet address is required');
    if (!flag_type) throw new Error('Flag type is required');
    if (!reason) throw new Error('Reason is required');

    const validFlagTypes = ['malicious_dispute', 'allowance_exploitation', 'fraud_detection', 'spam_activity', 'manual_flag'];
    if (!validFlagTypes.includes(flag_type)) {
      throw new Error('Invalid flag type');
    }

    // Validate Stellar address format
    try {
      const StellarSdk = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(wallet_address);
    } catch (error) {
      throw new Error('Invalid Stellar wallet address format');
    }
  }
}

module.exports = GlobalReputationService;
