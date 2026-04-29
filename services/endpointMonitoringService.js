const EventEmitter = require('events');
const { logger } = require('../src/utils/logger');
const promClient = require('prom-client');
const db = require('../src/db/knex');

class EndpointMonitoringService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Monitoring configuration
    this.errorThreshold = options.errorThreshold || parseInt(process.env.ERROR_THRESHOLD_5XX) || 10; // errors per minute
    this.criticalThreshold = options.criticalThreshold || parseInt(process.env.CRITICAL_THRESHOLD_5XX) || 25; // errors per minute
    this.monitoringWindow = options.monitoringWindow || parseInt(process.env.MONITORING_WINDOW_MS) || 60000; // 1 minute
    this.alertCooldown = options.alertCooldown || parseInt(process.env.ALERT_COOLDOWN_MS) || 300000; // 5 minutes
    this.enabledEndpoints = options.enabledEndpoints || (process.env.MONITORED_ENDPOINTS || '').split(',').filter(Boolean);
    
    // State tracking
    this.errorCounts = new Map(); // endpoint -> array of timestamps
    this.alertStates = new Map(); // endpoint -> last alert time
    this.endpointStats = new Map(); // endpoint -> stats object
    this.globalStats = {
      totalRequests: 0,
      totalErrors: 0,
      total5xxErrors: 0,
      lastErrorTime: null,
      monitoringStartTime: Date.now()
    };
    
    // Prometheus metrics
    this.setupMetrics();
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Endpoint Monitoring Service initialized', {
      errorThreshold: this.errorThreshold,
      criticalThreshold: this.criticalThreshold,
      monitoringWindow: this.monitoringWindow,
      alertCooldown: this.alertCooldown
    });
  }
  
  setupMetrics() {
    // Create custom metrics for endpoint monitoring
    this.endpointErrorsTotal = new promClient.Counter({
      name: 'endpoint_errors_total',
      help: 'Total number of errors by endpoint and status code',
      labelNames: ['endpoint', 'method', 'status_code', 'error_type'],
      registers: [global.register]
    });
    
    this.endpointRequestsTotal = new promClient.Counter({
      name: 'endpoint_requests_total',
      help: 'Total number of requests by endpoint and method',
      labelNames: ['endpoint', 'method', 'status_code'],
      registers: [global.register]
    });
    
    this.endpointErrorRate = new promClient.Gauge({
      name: 'endpoint_error_rate',
      help: 'Error rate for endpoints in the monitoring window',
      labelNames: ['endpoint', 'error_type'],
      registers: [global.register]
    });
    
    this.endpointResponseTime = new promClient.Histogram({
      name: 'endpoint_response_time_seconds',
      help: 'Response time for endpoints',
      labelNames: ['endpoint', 'method', 'status_code'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
      registers: [global.register]
    });
    
    this.monitoringAlertsTotal = new promClient.Counter({
      name: 'monitoring_alerts_total',
      help: 'Total number of monitoring alerts triggered',
      labelNames: ['endpoint', 'severity', 'alert_type'],
      registers: [global.register]
    });
    
    this.globalErrorRate = new promClient.Gauge({
      name: 'global_error_rate',
      help: 'Global error rate across all endpoints',
      labelNames: ['error_type'],
      registers: [global.register]
    });
  }
  
  startMonitoring() {
    // Clean up old error data periodically
    setInterval(() => {
      this.cleanupOldData();
      this.updateMetrics();
    }, 30000); // Every 30 seconds
    
    logger.info('Endpoint monitoring started');
  }
  
  cleanupOldData() {
    const now = Date.now();
    const windowStart = now - this.monitoringWindow;
    
    // Clean up error counts
    for (const [endpoint, timestamps] of this.errorCounts.entries()) {
      const filteredTimestamps = timestamps.filter(timestamp => timestamp > windowStart);
      if (filteredTimestamps.length === 0) {
        this.errorCounts.delete(endpoint);
      } else {
        this.errorCounts.set(endpoint, filteredTimestamps);
      }
    }
    
    // Clean up alert states
    for (const [endpoint, lastAlertTime] of this.alertStates.entries()) {
      if (now - lastAlertTime > this.alertCooldown * 2) {
        this.alertStates.delete(endpoint);
      }
    }
  }
  
  recordRequest(req, res, responseTime) {
    const endpoint = this.normalizeEndpoint(req.path);
    const method = req.method;
    const statusCode = res.statusCode;
    const now = Date.now();
    
    // Update global stats
    this.globalStats.totalRequests++;
    
    // Record request
    this.endpointRequestsTotal.labels(endpoint, method, statusCode.toString()).inc();
    this.endpointResponseTime.labels(endpoint, method, statusCode.toString()).observe(responseTime / 1000);
    
    // Check for errors
    if (statusCode >= 500) {
      this.recordError(endpoint, method, statusCode, '5xx', now);
      this.globalStats.totalErrors++;
      this.globalStats.total5xxErrors++;
      this.globalStats.lastErrorTime = now;
    } else if (statusCode >= 400) {
      this.recordError(endpoint, method, statusCode, '4xx', now);
      this.globalStats.totalErrors++;
    }
    
    // Update endpoint stats
    this.updateEndpointStats(endpoint, method, statusCode, responseTime);
    
    // Check for alert conditions
    this.checkAlertConditions(endpoint, now);
  }
  
  recordError(endpoint, method, statusCode, errorType, timestamp) {
    // Add to error counts
    if (!this.errorCounts.has(endpoint)) {
      this.errorCounts.set(endpoint, []);
    }
    this.errorCounts.get(endpoint).push(timestamp);
    
    // Record in metrics
    this.endpointErrorsTotal.labels(endpoint, method, statusCode.toString(), errorType).inc();
    
    logger.warn('Endpoint error recorded', {
      endpoint,
      method,
      statusCode,
      errorType,
      timestamp: new Date(timestamp).toISOString()
    });
  }
  
  updateEndpointStats(endpoint, method, statusCode, responseTime) {
    if (!this.endpointStats.has(endpoint)) {
      this.endpointStats.set(endpoint, {
        totalRequests: 0,
        totalErrors: 0,
        total5xxErrors: 0,
        responseTimes: [],
        lastRequestTime: null,
        lastErrorTime: null
      });
    }
    
    const stats = this.endpointStats.get(endpoint);
    stats.totalRequests++;
    stats.lastRequestTime = Date.now();
    
    if (statusCode >= 500) {
      stats.total5xxErrors++;
      stats.totalErrors++;
      stats.lastErrorTime = Date.now();
    } else if (statusCode >= 400) {
      stats.totalErrors++;
    }
    
    // Keep only last 100 response times for percentile calculation
    stats.responseTimes.push(responseTime);
    if (stats.responseTimes.length > 100) {
      stats.responseTimes.shift();
    }
  }
  
  checkAlertConditions(endpoint, now) {
    const errorTimestamps = this.errorCounts.get(endpoint) || [];
    const windowStart = now - this.monitoringWindow;
    const recentErrors = errorTimestamps.filter(timestamp => timestamp > windowStart);
    
    const errorCount = recentErrors.length;
    const lastAlertTime = this.alertStates.get(endpoint) || 0;
    
    // Check if we should alert (respect cooldown)
    if (now - lastAlertTime > this.alertCooldown) {
      let alertSeverity = null;
      let alertType = null;
      
      if (errorCount >= this.criticalThreshold) {
        alertSeverity = 'critical';
        alertType = 'critical_error_spike';
      } else if (errorCount >= this.errorThreshold) {
        alertSeverity = 'warning';
        alertType = 'error_spike';
      }
      
      if (alertSeverity && alertType) {
        this.triggerAlert(endpoint, alertSeverity, alertType, errorCount, now);
        this.alertStates.set(endpoint, now);
      }
    }
  }
  
  async triggerAlert(endpoint, severity, alertType, errorCount, timestamp) {
    const alertData = {
      endpoint,
      severity,
      alertType,
      errorCount,
      threshold: severity === 'critical' ? this.criticalThreshold : this.errorThreshold,
      timestamp: new Date(timestamp).toISOString(),
      monitoringWindow: this.monitoringWindow / 1000, // in seconds
      endpointStats: this.endpointStats.get(endpoint) || {}
    };
    
    // Record alert in metrics
    this.monitoringAlertsTotal.labels(endpoint, severity, alertType).inc();
    
    // Store alert in database
    await this.storeAlert(alertData);
    
    // Emit alert event
    this.emit('alert', alertData);
    
    logger.error('Endpoint monitoring alert triggered', alertData);
    
    // Send notifications (could be extended with email, Slack, etc.)
    await this.sendNotifications(alertData);
  }
  
  async storeAlert(alertData) {
    try {
      await db('monitoring_alerts').insert({
        endpoint: alertData.endpoint,
        severity: alertData.severity,
        alert_type: alertData.alertType,
        error_count: alertData.errorCount,
        threshold: alertData.threshold,
        monitoring_window: alertData.monitoringWindow,
        alert_data: JSON.stringify(alertData.endpointStats),
        created_at: new Date(alertData.timestamp)
      });
    } catch (error) {
      logger.error('Failed to store monitoring alert:', error);
    }
  }
  
  async sendNotifications(alertData) {
    try {
      // Get notification preferences from database
      const notifications = await db('monitoring_notifications')
        .where({ active: true })
        .where('endpoint_patterns', 'LIKE', `%${alertData.endpoint}%`)
        .orWhere('endpoint_patterns', '=', '*');
      
      for (const notification of notifications) {
        if (notification.notification_type === 'email' && alertData.severity === 'critical') {
          await this.sendEmailAlert(alertData, notification);
        } else if (notification.notification_type === 'webhook') {
          await this.sendWebhookAlert(alertData, notification);
        }
      }
    } catch (error) {
      logger.error('Failed to send notifications:', error);
    }
  }
  
  async sendEmailAlert(alertData, notification) {
    try {
      const emailService = require('./emailService');
      await emailService.sendEmail({
        to: notification.recipient,
        subject: `🚨 Critical Alert: ${alertData.endpoint} Error Spike`,
        template: 'endpoint-alert',
        data: {
          ...alertData,
          notification_name: notification.name,
          timestamp: new Date().toISOString()
        }
      });
      
      logger.info('Email alert sent', {
        endpoint: alertData.endpoint,
        recipient: notification.recipient
      });
    } catch (error) {
      logger.error('Failed to send email alert:', error);
    }
  }
  
  async sendWebhookAlert(alertData, notification) {
    try {
      const axios = require('axios');
      
      const payload = {
        alert: alertData,
        timestamp: new Date().toISOString(),
        service: 'substream-backend'
      };
      
      await axios.post(notification.webhook_url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Alert-Signature': this.generateWebhookSignature(payload, notification.secret)
        },
        timeout: 5000
      });
      
      logger.info('Webhook alert sent', {
        endpoint: alertData.endpoint,
        webhook_url: notification.webhook_url
      });
    } catch (error) {
      logger.error('Failed to send webhook alert:', error);
    }
  }
  
  generateWebhookSignature(payload, secret) {
    const crypto = require('crypto');
    return crypto
      .createHmac('sha256', secret || 'default-secret')
      .update(JSON.stringify(payload))
      .digest('hex');
  }
  
  updateMetrics() {
    const now = Date.now();
    const windowStart = now - this.monitoringWindow;
    
    // Update endpoint error rates
    for (const [endpoint, timestamps] of this.errorCounts.entries()) {
      const recentErrors = timestamps.filter(timestamp => timestamp > windowStart);
      const errorRate = recentErrors.length / (this.monitoringWindow / 1000); // errors per second
      
      // Categorize by error type (5xx vs 4xx)
      this.endpointErrorRate.labels(endpoint, '5xx').set(errorRate);
      
      // Also update total error rate
      const stats = this.endpointStats.get(endpoint) || {};
      const totalRequests = stats.totalRequests || 0;
      const totalErrors = stats.totalErrors || 0;
      const overallErrorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
      this.endpointErrorRate.labels(endpoint, 'overall').set(overallErrorRate);
    }
    
    // Update global error rates
    const globalTimeWindow = (now - this.globalStats.monitoringStartTime) / 1000;
    if (globalTimeWindow > 0) {
      const global5xxRate = this.globalStats.total5xxErrors / globalTimeWindow;
      const globalOverallRate = this.globalStats.totalRequests > 0 
        ? (this.globalStats.totalErrors / this.globalStats.totalRequests) * 100 
        : 0;
      
      this.globalErrorRate.labels('5xx').set(global5xxRate);
      this.globalErrorRate.labels('overall').set(globalOverallRate);
    }
  }
  
  normalizeEndpoint(path) {
    // Remove dynamic segments for better grouping
    return path
      .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '/:uuid')
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-zA-Z0-9_-]{20,}/g, '/:token');
  }
  
  // Public API methods
  
  getEndpointStats(endpoint = null) {
    if (endpoint) {
      return {
        endpoint,
        stats: this.endpointStats.get(endpoint) || {},
        recentErrors: this.errorCounts.get(endpoint) || [],
        lastAlertTime: this.alertStates.get(endpoint) || null
      };
    }
    
    const allStats = {};
    for (const [ep, stats] of this.endpointStats.entries()) {
      allStats[ep] = {
        stats,
        recentErrors: this.errorCounts.get(ep) || [],
        lastAlertTime: this.alertStates.get(ep) || null
      };
    }
    
    return allStats;
  }
  
  getGlobalStats() {
    return {
      ...this.globalStats,
      monitoringDuration: Date.now() - this.globalStats.monitoringStartTime,
      activeEndpoints: this.endpointStats.size,
      endpointsWithErrors: this.errorCounts.size,
      currentErrorRate: this.calculateCurrentErrorRate()
    };
  }
  
  calculateCurrentErrorRate() {
    const now = Date.now();
    const windowStart = now - this.monitoringWindow;
    let totalRecentErrors = 0;
    
    for (const timestamps of this.errorCounts.values()) {
      totalRecentErrors += timestamps.filter(timestamp => timestamp > windowStart).length;
    }
    
    return totalRecentErrors / (this.monitoringWindow / 1000); // errors per second
  }
  
  async getRecentAlerts(limit = 50, severity = null) {
    let query = db('monitoring_alerts')
      .orderBy('created_at', 'desc')
      .limit(limit);
    
    if (severity) {
      query = query.where({ severity });
    }
    
    return await query.select([
      'endpoint',
      'severity',
      'alert_type',
      'error_count',
      'threshold',
      'created_at',
      'alert_data'
    ]);
  }
  
  // Manual control methods
  forceAlert(endpoint, severity, message) {
    const alertData = {
      endpoint,
      severity,
      alertType: 'manual',
      errorCount: 0,
      threshold: 0,
      timestamp: new Date().toISOString(),
      monitoringWindow: this.monitoringWindow / 1000,
      endpointStats: this.endpointStats.get(endpoint) || {},
      message
    };
    
    this.triggerAlert(alertData.endpoint, alertData.severity, alertData.alertType, alertData.errorCount, Date.now());
  }
  
  resetEndpointStats(endpoint) {
    if (endpoint) {
      this.errorCounts.delete(endpoint);
      this.alertStates.delete(endpoint);
      this.endpointStats.delete(endpoint);
    } else {
      // Reset all
      this.errorCounts.clear();
      this.alertStates.clear();
      this.endpointStats.clear();
      this.globalStats = {
        totalRequests: 0,
        totalErrors: 0,
        total5xxErrors: 0,
        lastErrorTime: null,
        monitoringStartTime: Date.now()
      };
    }
    
    logger.info('Endpoint monitoring stats reset', { endpoint });
  }
}

module.exports = EndpointMonitoringService;
