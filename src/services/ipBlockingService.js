const { logger } = require('../utils/logger');
const { IPIntelligenceService } = require('./ipIntelligenceService');
const { IPIntelligenceMiddleware } = require('../middleware/ipIntelligenceMiddleware');

/**
 * IP Blocking and Restriction Service
 * Provides active defense mechanisms for high-risk IP addresses
 */
class IPBlockingService {
  constructor(database, config = {}) {
    this.database = database;
    this.config = {
      // Blocking configuration
      blocking: {
        enabled: config.blocking?.enabled !== false,
        autoBlock: config.blocking?.autoBlock !== false,
        blockDuration: config.blocking?.blockDuration || 24 * 60 * 60 * 1000, // 24 hours
        maxBlockDuration: config.blocking?.maxBlockDuration || 7 * 24 * 60 * 60 * 1000, // 7 days
        blockThreshold: config.blocking?.blockThreshold || 90, // Risk score threshold
        escalationThreshold: config.blocking?.escalationThreshold || 95, // Escalation threshold
        maxViolations: config.blocking?.maxViolations || 5 // Max violations before permanent block
      },
      // Restriction configuration
      restrictions: {
        enabled: config.restrictions?.enabled !== false,
        rateLimitReduction: config.restrictions?.rateLimitReduction || 0.5, // 50% reduction
        requireVerification: config.restrictions?.requireVerification !== false,
        limitActions: config.restrictions?.limitActions || [
          'create_creator',
          'high_value_withdrawal',
          'bulk_operations'
        ]
      },
      // Monitoring configuration
      monitoring: {
        enabled: config.monitoring?.enabled !== false,
        alertThreshold: config.monitoring?.alertThreshold || 80,
        trackPatterns: config.monitoring?.trackPatterns !== false,
        analyzeBehavior: config.monitoring?.analyzeBehavior !== false
      },
      ...config
    };

    // Initialize blocking database table
    this.initializeBlockingTable();
    
    // IP violation tracking
    this.ipViolations = new Map();
    
    // Active blocks
    this.activeBlocks = new Map();
    
    // Load existing blocks
    this.loadActiveBlocks();
  }

  /**
   * Initialize database table for IP blocking
   */
  initializeBlockingTable() {
    try {
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS ip_blocks (
          id TEXT PRIMARY KEY,
          ip_address TEXT NOT NULL,
          block_type TEXT NOT NULL, -- 'temporary', 'permanent', 'restriction'
          risk_score INTEGER NOT NULL,
          risk_level TEXT NOT NULL,
          reason TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          violation_count INTEGER DEFAULT 1,
          last_violation_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_ip_blocks_ip_address ON ip_blocks(ip_address);
        CREATE INDEX IF NOT EXISTS idx_ip_blocks_expires_at ON ip_blocks(expires_at);
        CREATE INDEX IF NOT EXISTS idx_ip_blocks_is_active ON ip_blocks(is_active);
      `);

      logger.info('IP blocking database table initialized');
    } catch (error) {
      logger.error('Failed to initialize IP blocking table', {
        error: error.message
      });
    }
  }

  /**
   * Load active blocks from database
   */
  async loadActiveBlocks() {
    try {
      const now = new Date().toISOString();
      const blocks = this.database.db.prepare(`
        SELECT * FROM ip_blocks 
        WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?)
      `).all(now);

      for (const block of blocks) {
        this.activeBlocks.set(block.ip_address, {
          ...block,
          metadata: JSON.parse(block.metadata_json || '{}')
        });
      }

      logger.info('Loaded active IP blocks', {
        count: blocks.length
      });

    } catch (error) {
      logger.error('Failed to load active blocks', {
        error: error.message
      });
    }
  }

  /**
   * Evaluate IP for blocking or restriction
   * @param {string} ipAddress 
   * @param {object} riskAssessment 
   * @param {object} context 
   * @returns {Promise<object>} Blocking decision
   */
  async evaluateIP(ipAddress, riskAssessment, context = {}) {
    try {
      const decision = {
        ipAddress,
        action: 'allow', // 'allow', 'restrict', 'block'
        reason: '',
        duration: null,
        metadata: {
          riskScore: riskAssessment.riskScore,
          riskLevel: riskAssessment.riskLevel,
          riskFactors: riskAssessment.riskFactors,
          context,
          evaluatedAt: new Date().toISOString()
        }
      };

      // Check if IP is already blocked
      const existingBlock = this.activeBlocks.get(ipAddress);
      if (existingBlock) {
        return this.handleExistingBlock(existingBlock, decision);
      }

      // Check violation history
      const violations = this.getIPViolations(ipAddress);
      decision.metadata.violationCount = violations.length;

      // Evaluate for blocking
      if (this.shouldBlockIP(riskAssessment, violations, context)) {
        return this.applyBlocking(ipAddress, riskAssessment, violations, decision);
      }

      // Evaluate for restriction
      if (this.shouldRestrictIP(riskAssessment, violations, context)) {
        return this.applyRestriction(ipAddress, riskAssessment, violations, decision);
      }

      // Log high-risk IPs that are allowed
      if (riskAssessment.riskScore >= this.config.monitoring.alertThreshold) {
        logger.warn('High risk IP allowed but monitored', {
          ipAddress,
          riskScore: riskAssessment.riskScore,
          riskLevel: riskAssessment.riskLevel,
          violationCount: violations.length,
          context
        });
      }

      return decision;

    } catch (error) {
      logger.error('IP evaluation failed', {
        ipAddress,
        error: error.message
      });

      // Fail safe - allow but monitor
      return {
        ipAddress,
        action: 'allow',
        reason: 'Evaluation failed - fail safe allow',
        error: error.message
      };
    }
  }

  /**
   * Handle existing block
   * @param {object} existingBlock 
   * @param {object} decision 
   * @returns {object} Updated decision
   */
  handleExistingBlock(existingBlock, decision) {
    decision.action = existingBlock.block_type;
    decision.reason = existingBlock.reason;
    decision.duration = existingBlock.expires_at ? 
      new Date(existingBlock.expires_at) - new Date() : null;
    decision.metadata.existingBlock = true;

    // Check if block should be updated
    if (this.shouldEscalateBlock(existingBlock, decision.metadata.riskScore)) {
      return this.escalateBlock(existingBlock, decision);
    }

    return decision;
  }

  /**
   * Check if IP should be blocked
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @param {object} context 
   * @returns {boolean}
   */
  shouldBlockIP(riskAssessment, violations, context) {
    if (!this.config.blocking.enabled) return false;
    if (!this.config.blocking.autoBlock) return false;

    const riskScore = riskAssessment.riskScore;
    const riskLevel = riskAssessment.riskLevel;

    // Block based on risk score
    if (riskScore >= this.config.blocking.blockThreshold) {
      return true;
    }

    // Block based on risk level
    if (riskLevel === 'critical') {
      return true;
    }

    // Block based on violation count
    if (violations.length >= this.config.blocking.maxViolations) {
      return true;
    }

    // Block based on specific risk factors
    const criticalFactors = ['Tor exit node', 'High abuse confidence', 'Bot activity detected'];
    const hasCriticalFactors = riskAssessment.riskFactors.some(factor =>
      criticalFactors.some(critical => factor.toLowerCase().includes(critical.toLowerCase()))
    );

    if (hasCriticalFactors) {
      return true;
    }

    // Block based on context
    if (context.actionType === 'create_creator' && riskLevel === 'high') {
      return true;
    }

    return false;
  }

  /**
   * Check if IP should be restricted
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @param {object} context 
   * @returns {boolean}
   */
  shouldRestrictIP(riskAssessment, violations, context) {
    if (!this.config.restrictions.enabled) return false;

    const riskScore = riskAssessment.riskScore;
    const riskLevel = riskAssessment.riskLevel;

    // Restrict based on risk score
    if (riskScore >= this.config.monitoring.alertThreshold) {
      return true;
    }

    // Restrict based on risk level
    if (riskLevel === 'high') {
      return true;
    }

    // Restrict based on violation history
    if (violations.length >= 2) {
      return true;
    }

    // Restrict based on context
    if (this.config.restrictions.limitActions.includes(context.actionType)) {
      return riskLevel === 'medium';
    }

    return false;
  }

  /**
   * Apply blocking to IP
   * @param {string} ipAddress 
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @param {object} decision 
   * @returns {object} Updated decision
   */
  async applyBlocking(ipAddress, riskAssessment, violations, decision) {
    try {
      const blockType = this.determineBlockType(riskAssessment, violations);
      const duration = this.calculateBlockDuration(riskAssessment, violations);
      const reason = this.generateBlockReason(riskAssessment, violations);

      // Create block record
      const blockId = this.createBlockRecord(ipAddress, {
        type: blockType,
        riskScore: riskAssessment.riskScore,
        riskLevel: riskAssessment.riskLevel,
        reason,
        duration,
        violations: violations.length
      });

      // Add to active blocks
      this.activeBlocks.set(ipAddress, {
        id: blockId,
        ip_address: ipAddress,
        block_type: blockType,
        risk_score: riskAssessment.riskScore,
        risk_level: riskAssessment.riskLevel,
        reason,
        created_at: new Date().toISOString(),
        expires_at: duration ? new Date(Date.now() + duration).toISOString() : null,
        is_active: 1,
        violation_count: violations.length + 1,
        last_violation_at: new Date().toISOString()
      });

      // Record violation
      this.recordViolation(ipAddress, riskAssessment, 'block');

      decision.action = blockType;
      decision.reason = reason;
      decision.duration = duration;
      decision.metadata.blockId = blockId;

      logger.warn('IP blocked', {
        ipAddress,
        blockType,
        duration,
        reason,
        riskScore: riskAssessment.riskScore,
        riskLevel: riskAssessment.riskLevel,
        violationCount: violations.length + 1
      });

      return decision;

    } catch (error) {
      logger.error('Failed to apply IP block', {
        ipAddress,
        error: error.message
      });

      decision.action = 'allow';
      decision.reason = 'Block application failed - fail safe allow';
      decision.error = error.message;

      return decision;
    }
  }

  /**
   * Apply restriction to IP
   * @param {string} ipAddress 
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @param {object} decision 
   * @returns {object} Updated decision
   */
  async applyRestriction(ipAddress, riskAssessment, violations, decision) {
    try {
      const reason = this.generateRestrictionReason(riskAssessment, violations);

      // Create restriction record
      const blockId = this.createBlockRecord(ipAddress, {
        type: 'restriction',
        riskScore: riskAssessment.riskScore,
        riskLevel: riskAssessment.riskLevel,
        reason,
        duration: this.config.blocking.blockDuration,
        violations: violations.length
      });

      // Add to active blocks
      this.activeBlocks.set(ipAddress, {
        id: blockId,
        ip_address: ipAddress,
        block_type: 'restriction',
        risk_score: riskAssessment.riskScore,
        risk_level: riskAssessment.riskLevel,
        reason,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + this.config.blocking.blockDuration).toISOString(),
        is_active: 1,
        violation_count: violations.length + 1,
        last_violation_at: new Date().toISOString()
      });

      // Record violation
      this.recordViolation(ipAddress, riskAssessment, 'restriction');

      decision.action = 'restrict';
      decision.reason = reason;
      decision.duration = this.config.blocking.blockDuration;
      decision.metadata.blockId = blockId;

      logger.info('IP restricted', {
        ipAddress,
        reason,
        riskScore: riskAssessment.riskScore,
        riskLevel: riskAssessment.riskLevel,
        violationCount: violations.length + 1
      });

      return decision;

    } catch (error) {
      logger.error('Failed to apply IP restriction', {
        ipAddress,
        error: error.message
      });

      decision.action = 'allow';
      decision.reason = 'Restriction application failed - fail safe allow';
      decision.error = error.message;

      return decision;
    }
  }

  /**
   * Determine block type based on risk assessment
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @returns {string} Block type
   */
  determineBlockType(riskAssessment, violations) {
    const riskScore = riskAssessment.riskScore;
    const riskLevel = riskAssessment.riskLevel;

    // Permanent block for critical risk
    if (riskLevel === 'critical' || riskScore >= this.config.blocking.escalationThreshold) {
      return 'permanent';
    }

    // Temporary block for high risk
    if (riskLevel === 'high' || violations.length >= this.config.blocking.maxViolations) {
      return 'temporary';
    }

    // Default to temporary
    return 'temporary';
  }

  /**
   * Calculate block duration
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @returns {number|null} Duration in milliseconds
   */
  calculateBlockDuration(riskAssessment, violations) {
    const blockType = this.determineBlockType(riskAssessment, violations);
    
    if (blockType === 'permanent') {
      return null;
    }

    // Scale duration based on risk and violations
    let baseDuration = this.config.blocking.blockDuration;
    
    // Increase duration for high risk
    if (riskAssessment.riskLevel === 'high') {
      baseDuration *= 2;
    }
    
    // Increase duration for repeat violations
    if (violations.length > 0) {
      baseDuration *= (1 + violations.length * 0.5);
    }
    
    // Cap at maximum duration
    return Math.min(baseDuration, this.config.blocking.maxBlockDuration);
  }

  /**
   * Generate block reason
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @returns {string} Reason
   */
  generateBlockReason(riskAssessment, violations) {
    const reasons = [];
    
    if (riskAssessment.riskLevel === 'critical') {
      reasons.push('Critical risk level detected');
    }
    
    if (riskAssessment.riskScore >= this.config.blocking.blockThreshold) {
      reasons.push(`High risk score (${riskAssessment.riskScore})`);
    }
    
    if (violations.length >= this.config.blocking.maxViolations) {
      reasons.push(`Too many violations (${violations.length})`);
    }
    
    // Add specific risk factors
    const criticalFactors = riskAssessment.riskFactors.filter(factor =>
      factor.toLowerCase().includes('tor') ||
      factor.toLowerCase().includes('abuse') ||
      factor.toLowerCase().includes('bot')
    );
    
    if (criticalFactors.length > 0) {
      reasons.push(`Critical factors: ${criticalFactors.join(', ')}`);
    }
    
    return reasons.join('; ') || 'Security policy violation';
  }

  /**
   * Generate restriction reason
   * @param {object} riskAssessment 
   * @param {array} violations 
   * @returns {string} Reason
   */
  generateRestrictionReason(riskAssessment, violations) {
    const reasons = [];
    
    if (riskAssessment.riskScore >= this.config.monitoring.alertThreshold) {
      reasons.push(`Elevated risk score (${riskAssessment.riskScore})`);
    }
    
    if (riskAssessment.riskLevel === 'high') {
      reasons.push('High risk level detected');
    }
    
    if (violations.length > 0) {
      reasons.push(`Previous violations (${violations.length})`);
    }
    
    return reasons.join('; ') || 'Security precaution';
  }

  /**
   * Create block record in database
   * @param {string} ipAddress 
   * @param {object} blockData 
   * @returns {string} Block ID
   */
  createBlockRecord(ipAddress, blockData) {
    const blockId = `block_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    
    this.database.db.prepare(`
      INSERT INTO ip_blocks (
        id, ip_address, block_type, risk_score, risk_level, reason, 
        metadata_json, created_at, expires_at, violation_count, last_violation_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      blockId,
      ipAddress,
      blockData.type,
      blockData.riskScore,
      blockData.riskLevel,
      blockData.reason,
      JSON.stringify({
        violations: blockData.violations,
        duration: blockData.duration,
        assessedAt: now
      }),
      now,
      blockData.duration ? new Date(Date.now() + blockData.duration).toISOString() : null,
      blockData.violations,
      now
    );

    return blockId;
  }

  /**
   * Record IP violation
   * @param {string} ipAddress 
   * @param {object} riskAssessment 
   * @param {string} action 
   */
  recordViolation(ipAddress, riskAssessment, action) {
    const now = Date.now();
    let violations = this.ipViolations.get(ipAddress);

    if (!violations) {
      violations = [];
    }

    violations.push({
      timestamp: now,
      action,
      riskScore: riskAssessment.riskScore,
      riskLevel: riskAssessment.riskLevel,
      riskFactors: riskAssessment.riskFactors
    });

    // Keep only last 10 violations
    if (violations.length > 10) {
      violations.shift();
    }

    this.ipViolations.set(ipAddress, violations);
  }

  /**
   * Get IP violations
   * @param {string} ipAddress 
   * @returns {array} Violations
   */
  getIPViolations(ipAddress) {
    return this.ipViolations.get(ipAddress) || [];
  }

  /**
   * Check if IP should escalate block
   * @param {object} existingBlock 
   * @param {number} newRiskScore 
   * @returns {boolean}
   */
  shouldEscalateBlock(existingBlock, newRiskScore) {
    // Escalate if new risk score is significantly higher
    if (newRiskScore > existingBlock.risk_score + 20) {
      return true;
    }

    // Escalate if block type is temporary but risk is critical
    if (existingBlock.block_type === 'temporary' && newRiskScore >= this.config.blocking.escalationThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Escalate existing block
   * @param {object} existingBlock 
   * @param {object} decision 
   * @returns {object} Updated decision
   */
  async escalateBlock(existingBlock, decision) {
    try {
      // Update block to permanent
      this.database.db.prepare(`
        UPDATE ip_blocks 
        SET block_type = 'permanent', expires_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), existingBlock.id);

      // Update active blocks
      existingBlock.block_type = 'permanent';
      existingBlock.expires_at = null;
      existingBlock.updated_at = new Date().toISOString();

      logger.warn('IP block escalated', {
        ipAddress: existingBlock.ip_address,
        previousType: 'temporary',
        newType: 'permanent',
        riskScore: decision.metadata.riskScore
      });

      decision.action = 'permanent';
      decision.reason = 'Block escalated due to increased risk';
      decision.duration = null;

      return decision;

    } catch (error) {
      logger.error('Failed to escalate IP block', {
        ipAddress: existingBlock.ip_address,
        error: error.message
      });

      return decision;
    }
  }

  /**
   * Check if IP is blocked
   * @param {string} ipAddress 
   * @returns {object|null} Block information
   */
  isIPBlocked(ipAddress) {
    const block = this.activeBlocks.get(ipAddress);
    
    if (!block) {
      return null;
    }

    // Check if block has expired
    if (block.expires_at && new Date(block.expires_at) < new Date()) {
      this.removeExpiredBlock(ipAddress);
      return null;
    }

    return {
      blockType: block.block_type,
      reason: block.reason,
      expiresAt: block.expires_at,
      riskScore: block.risk_score,
      riskLevel: block.risk_level
    };
  }

  /**
   * Remove expired block
   * @param {string} ipAddress 
   */
  removeExpiredBlock(ipAddress) {
    try {
      // Update database
      this.database.db.prepare(`
        UPDATE ip_blocks SET is_active = 0 WHERE ip_address = ?
      `).run(ipAddress);

      // Remove from active blocks
      this.activeBlocks.delete(ipAddress);

      logger.info('Expired IP block removed', {
        ipAddress
      });

    } catch (error) {
      logger.error('Failed to remove expired block', {
        ipAddress,
        error: error.message
      });
    }
  }

  /**
   * Manually block IP
   * @param {string} ipAddress 
   * @param {object} options 
   * @returns {Promise<object>} Block result
   */
  async manualBlockIP(ipAddress, options = {}) {
    const {
      type = 'temporary',
      duration = this.config.blocking.blockDuration,
      reason = 'Manual block by administrator',
      riskScore = 100,
      riskLevel = 'critical'
    } = options;

    try {
      // Create block record
      const blockId = this.createBlockRecord(ipAddress, {
        type,
        riskScore,
        riskLevel,
        reason,
        duration,
        violations: 0
      });

      // Add to active blocks
      this.activeBlocks.set(ipAddress, {
        id: blockId,
        ip_address: ipAddress,
        block_type: type,
        risk_score: riskScore,
        risk_level: riskLevel,
        reason,
        created_at: new Date().toISOString(),
        expires_at: type === 'permanent' ? null : new Date(Date.now() + duration).toISOString(),
        is_active: 1,
        violation_count: 0,
        last_violation_at: new Date().toISOString()
      });

      logger.warn('Manual IP block created', {
        ipAddress,
        type,
        duration,
        reason,
        blockId
      });

      return {
        success: true,
        blockId,
        ipAddress,
        type,
        duration,
        reason
      };

    } catch (error) {
      logger.error('Failed to create manual block', {
        ipAddress,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Manually unblock IP
   * @param {string} ipAddress 
   * @param {string} reason 
   * @returns {Promise<object>} Unblock result
   */
  async manualUnblockIP(ipAddress, reason = 'Manual unblock by administrator') {
    try {
      // Update database
      this.database.db.prepare(`
        UPDATE ip_blocks 
        SET is_active = 0, updated_at = ?
        WHERE ip_address = ? AND is_active = 1
      `).run(new Date().toISOString(), ipAddress);

      // Remove from active blocks
      const block = this.activeBlocks.get(ipAddress);
      this.activeBlocks.delete(ipAddress);

      logger.info('Manual IP unblock', {
        ipAddress,
        reason,
        previousBlock: block ? block.block_type : null
      });

      return {
        success: true,
        ipAddress,
        reason,
        previousBlock: block ? block.block_type : null
      };

    } catch (error) {
      logger.error('Failed to create manual unblock', {
        ipAddress,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get blocking statistics
   * @returns {object} Blocking stats
   */
  getBlockingStats() {
    const stats = {
      activeBlocks: this.activeBlocks.size,
      blockTypes: {
        temporary: 0,
        permanent: 0,
        restriction: 0
      },
      riskLevels: {
        minimal: 0,
        low: 0,
        medium: 0,
        high: 0,
        critical: 0
      },
      totalViolations: 0,
      recentBlocks: []
    };

    // Count block types and risk levels
    for (const block of this.activeBlocks.values()) {
      stats.blockTypes[block.block_type]++;
      stats.riskLevels[block.risk_level]++;
      stats.totalViolations += block.violation_count;
    }

    // Get recent blocks
    const recentBlocks = Array.from(this.activeBlocks.values())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10);

    stats.recentBlocks = recentBlocks.map(block => ({
      ipAddress: block.ip_address,
      blockType: block.block_type,
      riskLevel: block.risk_level,
      reason: block.reason,
      createdAt: block.created_at,
      expiresAt: block.expires_at
    }));

    return stats;
  }

  /**
   * Clean up expired blocks
   */
  cleanupExpiredBlocks() {
    const now = new Date();
    const expiredIPs = [];

    for (const [ip, block] of this.activeBlocks.entries()) {
      if (block.expires_at && new Date(block.expires_at) < now) {
        expiredIPs.push(ip);
      }
    }

    expiredIPs.forEach(ip => this.removeExpiredBlock(ip));

    if (expiredIPs.length > 0) {
      logger.info('Cleaned up expired blocks', {
        count: expiredIPs.length
      });
    }
  }
}

module.exports = { IPBlockingService };
