const { logger } = require('../utils/logger');
const { sendEmail } = require('../utils/email');

/**
 * IP Intelligence Monitoring and Alerting Service
 * Provides comprehensive monitoring, analytics, and alerting for IP intelligence
 */
class IPMonitoringService {
  constructor(database, config = {}) {
    this.database = database;
    this.config = {
      // Monitoring configuration
      monitoring: {
        enabled: config.monitoring?.enabled !== false,
        interval: config.monitoring?.interval || 5 * 60 * 1000, // 5 minutes
        retentionDays: config.monitoring?.retentionDays || 30,
        batchSize: config.monitoring?.batchSize || 100
      },
      // Alerting configuration
      alerting: {
        enabled: config.alerting?.enabled !== false,
        email: config.alerting?.email || process.env.SECURITY_ALERT_EMAIL,
        thresholds: {
          highRiskIPs: config.alerting?.thresholds?.highRiskIPs || 10,
          blockedIPs: config.alerting?.thresholds?.blockedIPs || 5,
          unusualActivity: config.alerting?.thresholds?.unusualActivity || 20,
          reputationDrop: config.alerting?.thresholds?.reputationDrop || 30
        },
        cooldown: config.alerting?.cooldown || 15 * 60 * 1000 // 15 minutes
      },
      // Analytics configuration
      analytics: {
        enabled: config.analytics?.enabled !== false,
        aggregationIntervals: config.analytics?.aggregationIntervals || ['hourly', 'daily'],
        topN: config.analytics?.topN || 10,
        includeDetails: config.analytics?.includeDetails || false
      },
      ...config
    };

    // Monitoring state
    this.isRunning = false;
    this.monitoringTimer = null;
    this.alertCooldowns = new Map();
    
    // Analytics cache
    this.analyticsCache = new Map();
    this.lastAnalyticsUpdate = null;

    // Initialize monitoring tables
    this.initializeMonitoringTables();
  }

  /**
   * Initialize monitoring database tables
   */
  initializeMonitoringTables() {
    try {
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS ip_monitoring_events (
          id TEXT PRIMARY KEY,
          ip_address TEXT NOT NULL,
          event_type TEXT NOT NULL, -- 'risk_assessment', 'block', 'unblock', 'violation'
          risk_score INTEGER,
          risk_level TEXT,
          metadata_json TEXT,
          timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ip_analytics_hourly (
          id TEXT PRIMARY KEY,
          ip_address TEXT NOT NULL,
          hour_timestamp TEXT NOT NULL,
          total_requests INTEGER DEFAULT 0,
          avg_risk_score REAL DEFAULT 0,
          max_risk_score INTEGER DEFAULT 0,
          violations INTEGER DEFAULT 0,
          blocks INTEGER DEFAULT 0,
          unique_actions TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ip_analytics_daily (
          id TEXT PRIMARY KEY,
          date_timestamp TEXT NOT NULL,
          total_unique_ips INTEGER DEFAULT 0,
          total_requests INTEGER DEFAULT 0,
          avg_risk_score REAL DEFAULT 0,
          high_risk_requests INTEGER DEFAULT 0,
          blocks_applied INTEGER DEFAULT 0,
          violations_detected INTEGER DEFAULT 0,
          top_risk_ips TEXT,
          top_countries TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ip_monitoring_events_ip ON ip_monitoring_events(ip_address);
        CREATE INDEX IF NOT EXISTS idx_ip_monitoring_events_timestamp ON ip_monitoring_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_ip_monitoring_events_type ON ip_monitoring_events(event_type);

        CREATE INDEX IF NOT EXISTS idx_ip_analytics_hourly_ip ON ip_analytics_hourly(ip_address);
        CREATE INDEX IF NOT EXISTS idx_ip_analytics_hourly_timestamp ON ip_analytics_hourly(hour_timestamp);

        CREATE INDEX IF NOT EXISTS idx_ip_analytics_daily_date ON ip_analytics_daily(date_timestamp);
      `);

      logger.info('IP monitoring database tables initialized');
    } catch (error) {
      logger.error('Failed to initialize monitoring tables', {
        error: error.message
      });
    }
  }

  /**
   * Start monitoring service
   */
  async start() {
    if (this.isRunning) {
      logger.warn('IP monitoring service is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting IP monitoring service', {
      interval: this.config.monitoring.interval
    });

    // Start periodic monitoring
    this.monitoringTimer = setInterval(async () => {
      await this.performMonitoringCycle();
    }, this.config.monitoring.interval);

    // Perform initial monitoring cycle
    await this.performMonitoringCycle();

    logger.info('IP monitoring service started successfully');
  }

  /**
   * Stop monitoring service
   */
  async stop() {
    this.isRunning = false;
    
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    logger.info('IP monitoring service stopped');
  }

  /**
   * Perform monitoring cycle
   */
  async performMonitoringCycle() {
    try {
      const cycleStart = Date.now();
      
      // Collect monitoring metrics
      const metrics = await this.collectMetrics();
      
      // Analyze for alerts
      await this.analyzeAndAlert(metrics);
      
      // Update analytics
      await this.updateAnalytics(metrics);
      
      // Clean up old data
      await this.cleanupOldData();

      const cycleDuration = Date.now() - cycleStart;
      
      logger.debug('IP monitoring cycle completed', {
        duration: cycleDuration,
        metrics: {
          totalEvents: metrics.totalEvents,
          highRiskIPs: metrics.highRiskIPs,
          blockedIPs: metrics.blockedIPs
        }
      });

    } catch (error) {
      logger.error('IP monitoring cycle failed', {
        error: error.message
      });
    }
  }

  /**
   * Collect monitoring metrics
   * @returns {object} Monitoring metrics
   */
  async collectMetrics() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Recent events
    const recentEvents = this.database.db.prepare(`
      SELECT * FROM ip_monitoring_events 
      WHERE timestamp > ?
      ORDER BY timestamp DESC
      LIMIT 1000
    `).all(oneHourAgo.toISOString());

    // High risk IPs
    const highRiskIPs = this.database.db.prepare(`
      SELECT DISTINCT ip_address, risk_score, risk_level
      FROM ip_monitoring_events 
      WHERE timestamp > ? AND risk_score >= 80
      ORDER BY risk_score DESC
      LIMIT 50
    `).all(oneHourAgo.toISOString());

    // Blocked IPs
    const blockedIPs = this.database.db.prepare(`
      SELECT DISTINCT ip_address, COUNT(*) as block_count
      FROM ip_monitoring_events 
      WHERE timestamp > ? AND event_type = 'block'
      GROUP BY ip_address
      ORDER BY block_count DESC
      LIMIT 50
    `).all(oneDayAgo.toISOString());

    // Risk distribution
    const riskDistribution = this.database.db.prepare(`
      SELECT risk_level, COUNT(*) as count
      FROM ip_monitoring_events 
      WHERE timestamp > ?
      GROUP BY risk_level
    `).all(oneHourAgo.toISOString());

    // Top countries
    const topCountries = this.database.db.prepare(`
      SELECT json_extract(metadata_json, '$.country') as country, COUNT(*) as count
      FROM ip_monitoring_events 
      WHERE timestamp > ? AND json_extract(metadata_json, '$.country') IS NOT NULL
      GROUP BY json_extract(metadata_json, '$.country')
      ORDER BY count DESC
      LIMIT 10
    `).all(oneHourAgo.toISOString());

    return {
      timestamp: now.toISOString(),
      totalEvents: recentEvents.length,
      highRiskIPs: highRiskIPs.length,
      blockedIPs: blockedIPs.length,
      riskDistribution: riskDistribution.reduce((acc, row) => {
        acc[row.risk_level] = row.count;
        return acc;
      }, {}),
      topCountries: topCountries,
      recentEvents: recentEvents.slice(0, 100),
      topRiskIPs: highRiskIPs.slice(0, 10),
      topBlockedIPs: blockedIPs.slice(0, 10)
    };
  }

  /**
   * Analyze metrics and send alerts
   * @param {object} metrics 
   */
  async analyzeAndAlert(metrics) {
    if (!this.config.alerting.enabled) return;

    const alerts = [];

    // Check high risk IP threshold
    if (metrics.highRiskIPs >= this.config.alerting.thresholds.highRiskIPs) {
      alerts.push({
        type: 'HIGH_RISK_IPS',
        severity: 'warning',
        message: `High number of high-risk IPs detected: ${metrics.highRiskIPs}`,
        data: {
          count: metrics.highRiskIPs,
          threshold: this.config.alerting.thresholds.highRiskIPs,
          topIPs: metrics.topRiskIPs
        }
      });
    }

    // Check blocked IP threshold
    if (metrics.blockedIPs >= this.config.alerting.thresholds.blockedIPs) {
      alerts.push({
        type: 'BLOCKED_IPS',
        severity: 'warning',
        message: `High number of blocked IPs: ${metrics.blockedIPs}`,
        data: {
          count: metrics.blockedIPs,
          threshold: this.config.alerting.thresholds.blockedIPs,
          topIPs: metrics.topBlockedIPs
        }
      });
    }

    // Check for unusual patterns
    const unusualPatterns = this.detectUnusualPatterns(metrics);
    if (unusualPatterns.length > 0) {
      alerts.push({
        type: 'UNUSUAL_ACTIVITY',
        severity: 'info',
        message: `Unusual activity patterns detected`,
        data: {
          patterns: unusualPatterns
        }
      });
    }

    // Send alerts
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }
  }

  /**
   * Detect unusual patterns in metrics
   * @param {object} metrics 
   * @returns {array} Unusual patterns
   */
  detectUnusualPatterns(metrics) {
    const patterns = [];

    // Check for spike in high-risk IPs
    const previousHour = this.getPreviousHourMetrics();
    if (previousHour && previousHour.highRiskIPs > 0) {
      const increase = (metrics.highRiskIPs - previousHour.highRiskIPs) / previousHour.highRiskIPs;
      if (increase > 2.0) { // 200% increase
        patterns.push({
          type: 'SPIKE_IN_HIGH_RISK',
          description: `High-risk IPs increased by ${(increase * 100).toFixed(1)}%`,
          current: metrics.highRiskIPs,
          previous: previousHour.highRiskIPs
        });
      }
    }

    // Check for concentration from specific countries
    const totalIPs = Object.values(metrics.riskDistribution).reduce((a, b) => a + b, 0);
    for (const country of metrics.topCountries) {
      const percentage = (country.count / totalIPs) * 100;
      if (percentage > 50) { // More than 50% from one country
        patterns.push({
          type: 'GEOGRAPHIC_CONCENTRATION',
          description: `${(percentage).toFixed(1)}% of traffic from ${country.country}`,
          country: country.country,
          percentage
        });
      }
    }

    return patterns;
  }

  /**
   * Get previous hour metrics for comparison
   * @returns {object|null} Previous metrics
   */
  getPreviousHourMetrics() {
    // This would be implemented to store historical metrics
    // For now, return null
    return null;
  }

  /**
   * Send alert
   * @param {object} alert 
   */
  async sendAlert(alert) {
    try {
      // Check cooldown
      const cooldownKey = `${alert.type}_${alert.data.count || 0}`;
      const lastAlert = this.alertCooldowns.get(cooldownKey);
      
      if (lastAlert && (Date.now() - lastAlert) < this.config.alerting.cooldown) {
        return; // Still in cooldown
      }

      // Update cooldown
      this.alertCooldowns.set(cooldownKey, Date.now());

      // Send email alert
      if (this.config.alerting.email) {
        await this.sendEmailAlert(alert);
      }

      // Log alert
      logger.warn('IP intelligence alert triggered', {
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        data: alert.data
      });

    } catch (error) {
      logger.error('Failed to send IP intelligence alert', {
        error: error.message,
        alertType: alert.type
      });
    }
  }

  /**
   * Send email alert
   * @param {object} alert 
   */
  async sendEmailAlert(alert) {
    const emailData = {
      to: this.config.alerting.email,
      subject: `🚨 IP Intelligence Alert - ${alert.type}`,
      template: 'ip_intelligence_alert',
      data: {
        alert,
        timestamp: new Date().toISOString(),
        severity: alert.severity.toUpperCase()
      }
    };

    await sendEmail(emailData);
  }

  /**
   * Update analytics
   * @param {object} metrics 
   */
  async updateAnalytics(metrics) {
    if (!this.config.analytics.enabled) return;

    try {
      // Update hourly analytics
      await this.updateHourlyAnalytics(metrics);
      
      // Update daily analytics
      await this.updateDailyAnalytics(metrics);
      
      // Cache analytics
      this.analyticsCache.set('current', metrics);
      this.lastAnalyticsUpdate = Date.now();

    } catch (error) {
      logger.error('Failed to update analytics', {
        error: error.message
      });
    }
  }

  /**
   * Update hourly analytics
   * @param {object} metrics 
   */
  async updateHourlyAnalytics(metrics) {
    const now = new Date();
    const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

    // Update existing or create new hourly record
    const existing = this.database.db.prepare(`
      SELECT * FROM ip_analytics_hourly WHERE hour_timestamp = ?
    `).get(hourKey);

    if (existing) {
      this.database.db.prepare(`
        UPDATE ip_analytics_hourly 
        SET total_requests = total_requests + ?,
            avg_risk_score = ?,
            max_risk_score = MAX(max_risk_score, ?),
            violations = violations + ?,
            blocks = blocks + ?
        WHERE id = ?
      `).run(
        metrics.totalEvents,
        (existing.avg_risk_score * existing.total_requests + this.calculateAverageRiskScore(metrics)) / (existing.total_requests + metrics.totalEvents),
        this.calculateMaxRiskScore(metrics),
        this.calculateViolations(metrics),
        this.calculateBlocks(metrics),
        existing.id
      );
    } else {
      const id = `hourly_${hourKey}_${Math.random().toString(36).substr(2, 9)}`;
      this.database.db.prepare(`
        INSERT INTO ip_analytics_hourly (
          id, hour_timestamp, total_requests, avg_risk_score, max_risk_score,
          violations, blocks, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        hourKey,
        metrics.totalEvents,
        this.calculateAverageRiskScore(metrics),
        this.calculateMaxRiskScore(metrics),
        this.calculateViolations(metrics),
        this.calculateBlocks(metrics),
        now.toISOString()
      );
    }
  }

  /**
   * Update daily analytics
   * @param {object} metrics 
   */
  async updateDailyAnalytics(metrics) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Update existing or create new daily record
    const existing = this.database.db.prepare(`
      SELECT * FROM ip_analytics_daily WHERE date_timestamp = ?
    `).get(dateKey);

    if (existing) {
      this.database.db.prepare(`
        UPDATE ip_analytics_daily 
        SET total_requests = total_requests + ?,
            avg_risk_score = ?,
            high_risk_requests = high_risk_requests + ?,
            blocks_applied = blocks_applied + ?,
            violations_detected = violations_detected + ?
        WHERE id = ?
      `).run(
        metrics.totalEvents,
        (existing.avg_risk_score * existing.total_requests + this.calculateAverageRiskScore(metrics)) / (existing.total_requests + metrics.totalEvents),
        metrics.highRiskIPs,
        this.calculateBlocks(metrics),
        this.calculateViolations(metrics),
        existing.id
      );
    } else {
      const id = `daily_${dateKey}_${Math.random().toString(36).substr(2, 9)}`;
      this.database.db.prepare(`
        INSERT INTO ip_analytics_daily (
          id, date_timestamp, total_unique_ips, total_requests, avg_risk_score,
          high_risk_requests, blocks_applied, violations_detected, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        dateKey,
        this.calculateUniqueIPs(metrics),
        metrics.totalEvents,
        this.calculateAverageRiskScore(metrics),
        metrics.highRiskIPs,
        this.calculateBlocks(metrics),
        this.calculateViolations(metrics),
        now.toISOString()
      );
    }
  }

  /**
   * Calculate average risk score from metrics
   * @param {object} metrics 
   * @returns {number} Average risk score
   */
  calculateAverageRiskScore(metrics) {
    if (!metrics.recentEvents || metrics.recentEvents.length === 0) return 0;
    
    const totalScore = metrics.recentEvents.reduce((sum, event) => sum + (event.risk_score || 0), 0);
    return totalScore / metrics.recentEvents.length;
  }

  /**
   * Calculate max risk score from metrics
   * @param {object} metrics 
   * @returns {number} Max risk score
   */
  calculateMaxRiskScore(metrics) {
    if (!metrics.recentEvents || metrics.recentEvents.length === 0) return 0;
    
    return Math.max(...metrics.recentEvents.map(event => event.risk_score || 0));
  }

  /**
   * Calculate violations from metrics
   * @param {object} metrics 
   * @returns {number} Violation count
   */
  calculateViolations(metrics) {
    if (!metrics.recentEvents) return 0;
    
    return metrics.recentEvents.filter(event => event.event_type === 'violation').length;
  }

  /**
   * Calculate blocks from metrics
   * @param {object} metrics 
   * @returns {number} Block count
   */
  calculateBlocks(metrics) {
    if (!metrics.recentEvents) return 0;
    
    return metrics.recentEvents.filter(event => event.event_type === 'block').length;
  }

  /**
   * Calculate unique IPs from metrics
   * @param {object} metrics 
   * @returns {number} Unique IP count
   */
  calculateUniqueIPs(metrics) {
    if (!metrics.recentEvents) return 0;
    
    const uniqueIPs = new Set(metrics.recentEvents.map(event => event.ip_address));
    return uniqueIPs.size;
  }

  /**
   * Clean up old monitoring data
   */
  async cleanupOldData() {
    try {
      const cutoffDate = new Date(Date.now() - (this.config.monitoring.retentionDays * 24 * 60 * 60 * 1000));
      
      // Clean up old events
      const deletedEvents = this.database.db.prepare(`
        DELETE FROM ip_monitoring_events WHERE timestamp < ?
      `).run(cutoffDate.toISOString());

      // Clean up old hourly analytics
      const deletedHourly = this.database.db.prepare(`
        DELETE FROM ip_analytics_hourly WHERE hour_timestamp < ?
      `).run(cutoffDate.toISOString());

      if (deletedEvents.changes > 0 || deletedHourly.changes > 0) {
        logger.info('Cleaned up old monitoring data', {
          deletedEvents: deletedEvents.changes,
          deletedHourly: deletedHourly.changes,
          cutoffDate: cutoffDate.toISOString()
        });
      }

    } catch (error) {
      logger.error('Failed to cleanup old monitoring data', {
        error: error.message
      });
    }
  }

  /**
   * Record IP monitoring event
   * @param {string} ipAddress 
   * @param {string} eventType 
   * @param {object} data 
   */
  async recordEvent(ipAddress, eventType, data = {}) {
    try {
      const eventId = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date().toISOString();

      this.database.db.prepare(`
        INSERT INTO ip_monitoring_events (
          id, ip_address, event_type, risk_score, risk_level, metadata_json, timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        ipAddress,
        eventType,
        data.riskScore || null,
        data.riskLevel || null,
        JSON.stringify(data),
        now,
        now
      );

    } catch (error) {
      logger.error('Failed to record IP monitoring event', {
        ipAddress,
        eventType,
        error: error.message
      });
    }
  }

  /**
   * Get analytics data
   * @param {object} options 
   * @returns {object} Analytics data
   */
  async getAnalytics(options = {}) {
    const {
      period = '24h',
      includeDetails = false,
      topN = 10
    } = options;

    try {
      // Check cache first
      const cacheKey = `analytics_${period}_${includeDetails}`;
      const cached = this.analyticsCache.get(cacheKey);
      
      if (cached && (Date.now() - this.lastAnalyticsUpdate) < 5 * 60 * 1000) { // 5 minutes cache
        return cached;
      }

      const analytics = await this.generateAnalytics(period, includeDetails, topN);
      
      // Cache result
      this.analyticsCache.set(cacheKey, analytics);
      
      return analytics;

    } catch (error) {
      logger.error('Failed to get IP analytics', {
        error: error.message,
        period
      });
      
      return {
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Generate analytics data
   * @param {string} period 
   * @param {boolean} includeDetails 
   * @param {number} topN 
   * @returns {object} Analytics data
   */
  async generateAnalytics(period, includeDetails, topN) {
    const now = new Date();
    let startDate;

    switch (period) {
      case '1h':
        startDate = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '24h':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    // Get summary data
    const summary = this.database.db.prepare(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT ip_address) as unique_ips,
        AVG(risk_score) as avg_risk_score,
        MAX(risk_score) as max_risk_score,
        COUNT(CASE WHEN risk_score >= 80 THEN 1 END) as high_risk_events,
        COUNT(CASE WHEN event_type = 'block' THEN 1 END) as blocks,
        COUNT(CASE WHEN event_type = 'violation' THEN 1 END) as violations
      FROM ip_monitoring_events 
      WHERE timestamp > ?
    `).get(startDate.toISOString());

    // Get risk distribution
    const riskDistribution = this.database.db.prepare(`
      SELECT risk_level, COUNT(*) as count
      FROM ip_monitoring_events 
      WHERE timestamp > ?
      GROUP BY risk_level
      ORDER BY count DESC
    `).all(startDate.toISOString());

    // Get top risk IPs
    const topRiskIPs = this.database.db.prepare(`
      SELECT 
        ip_address, 
        AVG(risk_score) as avg_risk_score,
        MAX(risk_score) as max_risk_score,
        COUNT(*) as event_count,
        GROUP_CONCAT(DISTINCT event_type) as event_types
      FROM ip_monitoring_events 
      WHERE timestamp > ?
      GROUP BY ip_address
      ORDER BY avg_risk_score DESC
      LIMIT ?
    `).all(startDate.toISOString(), topN);

    // Get event type distribution
    const eventTypeDistribution = this.database.db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM ip_monitoring_events 
      WHERE timestamp > ?
      GROUP BY event_type
      ORDER BY count DESC
    `).all(startDate.toISOString());

    // Get hourly trends
    const hourlyTrends = this.database.db.prepare(`
      SELECT 
        strftime('%H', timestamp) as hour,
        COUNT(*) as events,
        AVG(risk_score) as avg_risk_score
      FROM ip_monitoring_events 
      WHERE timestamp > ?
      GROUP BY strftime('%H', timestamp)
      ORDER BY hour
    `).all(startDate.toISOString());

    return {
      period,
      timestamp: now.toISOString(),
      summary: {
        totalEvents: summary.total_events || 0,
        uniqueIPs: summary.unique_ips || 0,
        averageRiskScore: Math.round(summary.avg_risk_score || 0),
        maxRiskScore: summary.max_risk_score || 0,
        highRiskEvents: summary.high_risk_events || 0,
        blocks: summary.blocks || 0,
        violations: summary.violations || 0
      },
      riskDistribution,
      topRiskIPs: topRiskIPs.map(ip => ({
        ...ip,
        eventTypes: ip.event_types.split(',')
      })),
      eventTypeDistribution,
      hourlyTrends,
      metadata: {
        includeDetails,
        topN,
        generatedAt: now.toISOString()
      }
    };
  }

  /**
   * Get monitoring status
   * @returns {object} Monitoring status
   */
  getMonitoringStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      lastAnalyticsUpdate: this.lastAnalyticsUpdate,
      alertCooldowns: this.alertCooldowns.size,
      cacheSize: this.analyticsCache.size
    };
  }
}

module.exports = { IPMonitoringService };
