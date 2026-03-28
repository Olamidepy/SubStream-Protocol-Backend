const express = require('express');
const { logger } = require('../src/utils/logger');

/**
 * Create IP Intelligence management routes
 * @param {object} dependencies - Service dependencies
 * @returns {express.Router}
 */
function createIPIntelligenceRoutes(dependencies = {}) {
  const router = express.Router();
  const ipIntelligenceService = dependencies.ipIntelligenceService;
  const ipBlockingService = dependencies.ipBlockingService;
  const ipMonitoringService = dependencies.ipMonitoringService;

  /**
   * Get IP intelligence service statistics
   * GET /api/ip-intelligence/stats
   */
  router.get('/stats', async (req, res) => {
    try {
      if (!ipIntelligenceService) {
        return res.status(503).json({
          success: false,
          error: 'IP intelligence service not available'
        });
      }

      const stats = ipIntelligenceService.getServiceStats();
      
      return res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error fetching IP intelligence stats', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP intelligence statistics'
      });
    }
  });

  /**
   * Assess IP risk
   * POST /api/ip-intelligence/assess
   */
  router.post('/assess', async (req, res) => {
    try {
      const { ipAddress, options = {} } = req.body;

      if (!ipAddress) {
        return res.status(400).json({
          success: false,
          error: 'IP address is required'
        });
      }

      if (!ipIntelligenceService) {
        return res.status(503).json({
          success: false,
          error: 'IP intelligence service not available'
        });
      }

      const assessment = await ipIntelligenceService.assessIPRisk(ipAddress, options);
      
      return res.status(200).json({
        success: true,
        data: assessment
      });

    } catch (error) {
      logger.error('Error assessing IP risk', {
        error: error.message,
        ipAddress: req.body?.ipAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to assess IP risk'
      });
    }
  });

  /**
   * Get IP reputation data
   * GET /api/ip-intelligence/reputation/:ipAddress
   */
  router.get('/reputation/:ipAddress', async (req, res) => {
    try {
      const { ipAddress } = req.params;

      if (!ipIntelligenceService) {
        return res.status(503).json({
          success: false,
          error: 'IP intelligence service not available'
        });
      }

      const reputation = ipIntelligenceService.getIPReputation(ipAddress);
      
      return res.status(200).json({
        success: true,
        data: reputation || null
      });

    } catch (error) {
      logger.error('Error fetching IP reputation', {
        error: error.message,
        ipAddress: req.params.ipAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP reputation'
      });
    }
  });

  /**
   * Get IP reputation statistics
   * GET /api/ip-intelligence/reputation-stats
   */
  router.get('/reputation-stats', async (req, res) => {
    try {
      if (!ipIntelligenceService) {
        return res.status(503).json({
          success: false,
          error: 'IP intelligence service not available'
        });
      }

      const stats = ipIntelligenceService.getReputationStats();
      
      return res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error fetching IP reputation stats', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP reputation statistics'
      });
    }
  });

  /**
   * Get blocking statistics
   * GET /api/ip-intelligence/blocking-stats
   */
  router.get('/blocking-stats', async (req, res) => {
    try {
      if (!ipBlockingService) {
        return res.status(503).json({
          success: false,
          error: 'IP blocking service not available'
        });
      }

      const stats = ipBlockingService.getBlockingStats();
      
      return res.status(200).json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error fetching blocking stats', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch blocking statistics'
      });
    }
  });

  /**
   * Check if IP is blocked
   * GET /api/ip-intelligence/is-blocked/:ipAddress
   */
  router.get('/is-blocked/:ipAddress', async (req, res) => {
    try {
      const { ipAddress } = req.params;

      if (!ipBlockingService) {
        return res.status(503).json({
          success: false,
          error: 'IP blocking service not available'
        });
      }

      const blockInfo = ipBlockingService.isIPBlocked(ipAddress);
      
      return res.status(200).json({
        success: true,
        data: {
          ipAddress,
          isBlocked: !!blockInfo,
          blockInfo
        }
      });

    } catch (error) {
      logger.error('Error checking IP block status', {
        error: error.message,
        ipAddress: req.params.ipAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to check IP block status'
      });
    }
  });

  /**
   * Manually block an IP
   * POST /api/ip-intelligence/block
   */
  router.post('/block', async (req, res) => {
    try {
      const { ipAddress, type = 'temporary', duration, reason } = req.body;

      if (!ipAddress) {
        return res.status(400).json({
          success: false,
          error: 'IP address is required'
        });
      }

      if (!ipBlockingService) {
        return res.status(503).json({
          success: false,
          error: 'IP blocking service not available'
        });
      }

      const result = await ipBlockingService.manualBlockIP(ipAddress, {
        type,
        duration,
        reason: reason || 'Manual block via API'
      });

      if (result.success) {
        // Record monitoring event
        await ipMonitoringService?.recordEvent(ipAddress, 'block', {
          manual: true,
          type,
          duration,
          reason
        });
      }

      return res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: result
      });

    } catch (error) {
      logger.error('Error manually blocking IP', {
        error: error.message,
        ipAddress: req.body?.ipAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to block IP'
      });
    }
  });

  /**
   * Manually unblock an IP
   * POST /api/ip-intelligence/unblock
   */
  router.post('/unblock', async (req, res) => {
    try {
      const { ipAddress, reason } = req.body;

      if (!ipAddress) {
        return res.status(400).json({
          success: false,
          error: 'IP address is required'
        });
      }

      if (!ipBlockingService) {
        return res.status(503).json({
          success: false,
          error: 'IP blocking service not available'
        });
      }

      const result = await ipBlockingService.manualUnblockIP(ipAddress, reason || 'Manual unblock via API');

      if (result.success) {
        // Record monitoring event
        await ipMonitoringService?.recordEvent(ipAddress, 'unblock', {
          manual: true,
          reason
        });
      }

      return res.status(result.success ? 200 : 400).json({
        success: result.success,
        data: result
      });

    } catch (error) {
      logger.error('Error manually unblocking IP', {
        error: error.message,
        ipAddress: req.body?.ipAddress,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to unblock IP'
      });
    }
  });

  /**
   * Get IP analytics
   * GET /api/ip-intelligence/analytics
   */
  router.get('/analytics', async (req, res) => {
    try {
      const { period = '24h', includeDetails = 'false', topN = 10 } = req.query;

      if (!ipMonitoringService) {
        return res.status(503).json({
          success: false,
          error: 'IP monitoring service not available'
        });
      }

      const analytics = await ipMonitoringService.getAnalytics({
        period,
        includeDetails: includeDetails === 'true',
        topN: parseInt(topN) || 10
      });

      return res.status(200).json({
        success: true,
        data: analytics
      });

    } catch (error) {
      logger.error('Error fetching IP analytics', {
        error: error.message,
        period: req.query.period,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP analytics'
      });
    }
  });

  /**
   * Get monitoring status
   * GET /api/ip-intelligence/monitoring-status
   */
  router.get('/monitoring-status', async (req, res) => {
    try {
      if (!ipMonitoringService) {
        return res.status(503).json({
          success: false,
          error: 'IP monitoring service not available'
        });
      }

      const status = ipMonitoringService.getMonitoringStatus();
      
      return res.status(200).json({
        success: true,
        data: status
      });

    } catch (error) {
      logger.error('Error fetching monitoring status', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch monitoring status'
      });
    }
  });

  /**
   * Get recent IP events
   * GET /api/ip-intelligence/events
   */
  router.get('/events', async (req, res) => {
    try {
      const { limit = 50, eventType } = req.query;

      if (!ipMonitoringService) {
        return res.status(503).json({
          success: false,
          error: 'IP monitoring service not available'
        });
      }

      // Query recent events from database
      let query = `
        SELECT * FROM ip_monitoring_events 
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      
      const params = [parseInt(limit) || 50];

      if (eventType) {
        query = `
          SELECT * FROM ip_monitoring_events 
          WHERE event_type = ?
          ORDER BY timestamp DESC 
          LIMIT ?
        `;
        params.unshift(eventType);
      }

      const events = ipMonitoringService.database.db.prepare(query).all(...params);

      return res.status(200).json({
        success: true,
        data: {
          events: events.map(event => ({
            ...event,
            metadata: JSON.parse(event.metadata_json || '{}')
          })),
          count: events.length
        }
      });

    } catch (error) {
      logger.error('Error fetching IP events', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP events'
      });
    }
  });

  /**
   * Get IP intelligence dashboard overview
   * GET /api/ip-intelligence/dashboard
   */
  router.get('/dashboard', async (req, res) => {
    try {
      if (!ipIntelligenceService || !ipBlockingService || !ipMonitoringService) {
        return res.status(503).json({
          success: false,
          error: 'IP intelligence services not available'
        });
      }

      // Get overview data
      const [
        serviceStats,
        blockingStats,
        analytics,
        monitoringStatus
      ] = await Promise.all([
        Promise.resolve(ipIntelligenceService.getServiceStats()),
        Promise.resolve(ipBlockingService.getBlockingStats()),
        ipMonitoringService.getAnalytics({ period: '24h', topN: 5 }),
        Promise.resolve(ipMonitoringService.getMonitoringStatus())
      ]);

      const dashboard = {
        timestamp: new Date().toISOString(),
        services: {
          intelligence: serviceStats,
          blocking: blockingStats,
          monitoring: monitoringStatus
        },
        overview: {
          activeBlocks: blockingStats.activeBlocks,
          recentEvents: analytics.summary?.totalEvents || 0,
          uniqueIPs: analytics.summary?.uniqueIPs || 0,
          averageRiskScore: analytics.summary?.averageRiskScore || 0,
          highRiskEvents: analytics.summary?.highRiskEvents || 0
        },
        topRiskIPs: analytics.topRiskIPs?.slice(0, 5) || [],
        riskDistribution: analytics.riskDistribution || [],
        recentActivity: analytics.eventTypeDistribution || [],
        alerts: {
          monitoring: monitoringStatus.isRunning,
          alertCooldowns: monitoringStatus.alertCooldowns
        }
      };

      return res.status(200).json({
        success: true,
        data: dashboard
      });

    } catch (error) {
      logger.error('Error fetching IP intelligence dashboard', {
        error: error.message,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to fetch IP intelligence dashboard'
      });
    }
  });

  /**
   * Export IP intelligence data
   * GET /api/ip-intelligence/export
   */
  router.get('/export', async (req, res) => {
    try {
      const { 
        period = '24h', 
        format = 'json', 
        includeDetails = 'false',
        type = 'all' 
      } = req.query;

      if (!ipMonitoringService) {
        return res.status(503).json({
          success: false,
          error: 'IP monitoring service not available'
        });
      }

      let data;
      let filename;
      let contentType;

      switch (type) {
        case 'events':
          data = await this.exportEvents(period);
          filename = `ip_events_${period}.${format}`;
          break;
        case 'analytics':
          data = await ipMonitoringService.getAnalytics({ 
            period, 
            includeDetails: includeDetails === 'true' 
          });
          filename = `ip_analytics_${period}.${format}`;
          break;
        case 'blocks':
          data = await this.exportBlocks(period);
          filename = `ip_blocks_${period}.${format}`;
          break;
        case 'all':
        default:
          data = await this.exportAllData(period);
          filename = `ip_intelligence_${period}.${format}`;
          break;
      }

      // Format response
      if (format === 'csv') {
        contentType = 'text/csv';
        data = this.convertToCSV(data);
      } else if (format === 'xml') {
        contentType = 'application/xml';
        data = this.convertToXML(data);
      } else {
        contentType = 'application/json';
        data = JSON.stringify(data, null, 2);
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(data);

    } catch (error) {
      logger.error('Error exporting IP intelligence data', {
        error: error.message,
        period: req.query.period,
        format: req.query.format,
        type: req.query.type,
        traceId: req.logger?.fields?.traceId
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to export IP intelligence data'
      });
    }
  });

  /**
   * Export events data
   * @param {string} period 
   * @returns {object} Events data
   */
  async exportEvents(period) {
    const startDate = this.getStartDate(period);
    
    const events = ipMonitoringService.database.db.prepare(`
      SELECT * FROM ip_monitoring_events 
      WHERE timestamp > ?
      ORDER BY timestamp DESC
    `).all(startDate.toISOString());

    return events.map(event => ({
      ...event,
      metadata: JSON.parse(event.metadata_json || '{}')
    }));
  }

  /**
   * Export blocks data
   * @param {string} period 
   * @returns {object} Blocks data
   */
  async exportBlocks(period) {
    const startDate = this.getStartDate(period);
    
    const blocks = ipMonitoringService.database.db.prepare(`
      SELECT * FROM ip_blocks 
      WHERE created_at > ? AND is_active = 1
      ORDER BY created_at DESC
    `).all(startDate.toISOString());

    return blocks.map(block => ({
      ...block,
      metadata: JSON.parse(block.metadata_json || '{}')
    }));
  }

  /**
   * Export all data
   * @param {string} period 
   * @returns {object} All data
   */
  async exportAllData(period) {
    const [events, blocks, analytics] = await Promise.all([
      this.exportEvents(period),
      this.exportBlocks(period),
      ipMonitoringService.getAnalytics({ period, includeDetails: true })
    ]);

    return {
      events,
      blocks,
      analytics,
      exportedAt: new Date().toISOString(),
      period
    };
  }

  /**
   * Convert data to CSV
   * @param {object} data 
   * @returns {string} CSV string
   */
  convertToCSV(data) {
    if (Array.isArray(data)) {
      if (data.length === 0) return '';
      
      const headers = Object.keys(data[0]);
      const csvRows = [headers.join(',')];
      
      for (const row of data) {
        const values = headers.map(header => {
          let value = row[header];
          if (value === null || value === undefined) return '';
          if (typeof value === 'object') value = JSON.stringify(value);
          return `"${String(value).replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
      }
      
      return csvRows.join('\n');
    } else {
      // Convert object to CSV
      const flattenObject = (obj, prefix = '') => {
        const flattened = {};
        for (const key in obj) {
          if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            const newKey = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              Object.assign(flattened, flattenObject(value, newKey));
            } else {
              flattened[newKey] = value;
            }
          }
        }
        return flattened;
      };
      
      const flattened = flattenObject(data);
      const headers = Object.keys(flattened);
      const values = headers.map(header => {
        const value = flattened[header];
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') value = JSON.stringify(value);
        return `"${String(value).replace(/"/g, '""')}"`;
      });
      
      return [headers.join(','), values.join(',')].join('\n');
    }
  }

  /**
   * Convert data to XML
   * @param {object} data 
   * @returns {string} XML string
   */
  convertToXML(data) {
    const objectToXML = (obj, indent = 0) => {
      const spaces = '  '.repeat(indent);
      let xml = '';
      
      for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) continue;
        
        if (Array.isArray(value)) {
          xml += `${spaces}<${key}>\n`;
          value.forEach(item => {
            if (typeof item === 'object') {
              xml += objectToXML(item, indent + 1);
            } else {
              xml += `${spaces}  <item>${item}</item>\n`;
            }
          });
          xml += `${spaces}</${key}>\n`;
        } else if (typeof value === 'object') {
          xml += `${spaces}<${key}>\n`;
          xml += objectToXML(value, indent + 1);
          xml += `${spaces}</${key}>\n`;
        } else {
          xml += `${spaces}<${key}>${value}</${key}>\n`;
        }
      }
      
      return xml;
    };
    
    return `<?xml version="1.0" encoding="UTF-8"?>\n<data>\n${objectToXML(data, 1)}</data>`;
  }

  /**
   * Get start date for period
   * @param {string} period 
   * @returns {Date} Start date
   */
  getStartDate(period) {
    const now = new Date();
    switch (period) {
      case '1h':
        return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  return router;
}

module.exports = { createIPIntelligenceRoutes };
