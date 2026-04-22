const axios = require('axios');
const winston = require('winston');

/**
 * Slack Webhook Alert Service
 * Sends immediate notifications when DLQ items are added
 */
class SlackAlertService {
  constructor(config, logger = winston.createLogger()) {
    this.webhookUrl = config.slackWebhookUrl;
    this.channel = config.slackChannel || '#alerts';
    this.username = config.slackUsername || 'Soroban DLQ Bot';
    this.iconEmoji = config.slackIconEmoji || ':warning:';
    this.logger = logger;
    
    // Alert configuration
    this.enabled = config.slackAlertsEnabled !== false;
    this.rateLimitMs = config.slackRateLimitMs || 5000; // 5 seconds between alerts
    this.lastAlertTime = 0;
    
    // Statistics
    this.stats = {
      alertsSent: 0,
      alertsFailed: 0,
      rateLimited: 0,
      startTime: new Date().toISOString()
    };
  }

  /**
   * Send alert to Slack
   */
  async sendAlert(alert) {
    if (!this.enabled || !this.webhookUrl) {
      this.logger.debug('Slack alerts disabled or webhook not configured');
      return { success: false, reason: 'disabled' };
    }

    // Rate limiting
    const now = Date.now();
    if (now - this.lastAlertTime < this.rateLimitMs) {
      this.stats.rateLimited++;
      this.logger.warn('Slack alert rate limited', {
        alertType: alert.type,
        timeSinceLastAlert: now - this.lastAlertTime
      });
      return { success: false, reason: 'rate_limited' };
    }

    try {
      const slackMessage = this.formatSlackMessage(alert);
      
      const response = await axios.post(this.webhookUrl, slackMessage, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.status === 200) {
        this.stats.alertsSent++;
        this.lastAlertTime = now;
        
        this.logger.info('Slack alert sent successfully', {
          alertType: alert.type,
          severity: alert.severity
        });
        
        return { success: true };
      } else {
        throw new Error(`Unexpected status code: ${response.status}`);
      }
      
    } catch (error) {
      this.stats.alertsFailed++;
      this.logger.error('Failed to send Slack alert', {
        alertType: alert.type,
        error: error.message,
        response: error.response?.data
      });
      
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Format alert message for Slack
   */
  formatSlackMessage(alert) {
    const baseMessage = {
      channel: this.channel,
      username: this.username,
      icon_emoji: this.iconEmoji,
      attachments: [this.createAttachment(alert)]
    };

    return baseMessage;
  }

  /**
   * Create Slack attachment for alert
   */
  createAttachment(alert) {
    const color = this.getColorBySeverity(alert.severity);
    const fields = this.createFields(alert);
    
    return {
      color,
      title: alert.title,
      text: alert.message,
      fields,
      footer: 'Soroban Event Indexer',
      ts: Math.floor(new Date(alert.timestamp).getTime() / 1000),
      actions: this.createActions(alert)
    };
  }

  /**
   * Create fields for Slack attachment
   */
  createFields(alert) {
    const fields = [
      {
        title: 'Severity',
        value: alert.severity.toUpperCase(),
        short: true
      },
      {
        title: 'Time',
        value: new Date(alert.timestamp).toLocaleString(),
        short: true
      }
    ];

    // Add DLQ specific fields
    if (alert.type === 'dlq_item_added' && alert.details) {
      fields.push(
        {
          title: 'DLQ ID',
          value: alert.details.dlqId || 'N/A',
          short: true
        },
        {
          title: 'Error Category',
          value: alert.details.errorCategory || 'Unknown',
          short: true
        },
        {
          title: 'Transaction Hash',
          value: `\`${alert.details.transactionHash || 'N/A'}\``,
          short: false
        },
        {
          title: 'Event Index',
          value: alert.details.eventIndex?.toString() || 'N/A',
          short: true
        },
        {
          title: 'Ledger Sequence',
          value: alert.details.ledgerSequence?.toString() || 'N/A',
          short: true
        },
        {
          title: 'Contract ID',
          value: `\`${alert.details.contractId || 'N/A'}\``,
          short: false
        },
        {
          title: 'Original Attempts',
          value: alert.details.originalAttemptCount?.toString() || 'N/A',
          short: true
        },
        {
          title: 'Error Message',
          value: alert.details.errorMessage || 'No error message',
          short: false
        }
      );
    }

    // Add generic fields
    if (alert.details) {
      Object.keys(alert.details).forEach(key => {
        if (!fields.find(f => f.title === key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))) {
          const value = alert.details[key];
          if (value && typeof value === 'string' && value.length > 100) {
            fields.push({
              title: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
              value: `\`${value.substring(0, 100)}...\``,
              short: false
            });
          } else if (value) {
            fields.push({
              title: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
              value: typeof value === 'object' ? JSON.stringify(value) : String(value),
              short: true
            });
          }
        }
      });
    }

    return fields.slice(0, 10); // Slack limits to 10 fields per attachment
  }

  /**
   * Create action buttons for Slack attachment
   */
  createActions(alert) {
    const actions = [];

    if (alert.type === 'dlq_item_added' && alert.details?.dlqId) {
      actions.push({
        type: 'button',
        text: 'View Details',
        url: `${process.env.BASE_URL || 'http://localhost:3000'}/admin/dlq/item/${alert.details.dlqId}`
      });

      actions.push({
        type: 'button',
        text: 'Retry Event',
        url: `${process.env.BASE_URL || 'http://localhost:3000'}/admin/dlq/retry`,
        style: 'primary'
      });
    }

    return actions;
  }

  /**
   * Get color by severity level
   */
  getColorBySeverity(severity) {
    const colors = {
      'info': '#36a64f',      // green
      'warning': '#ff9500',   // orange
      'error': '#ff0000',     // red
      'critical': '#8b0000'   // dark red
    };
    
    return colors[severity] || '#808080'; // gray default
  }

  /**
   * Send DLQ item added alert
   */
  async sendDlqAlert(dlqItem, error) {
    const alert = {
      type: 'dlq_item_added',
      severity: this.getAlertSeverity(dlqItem.error_category),
      title: `Soroban Event Processing Failed`,
      message: `Event ${dlqItem.transaction_hash}:${dlqItem.event_index} failed processing after ${dlqItem.original_attempt_count} attempts`,
      details: {
        dlqId: dlqItem.id,
        contractId: dlqItem.contract_id,
        transactionHash: dlqItem.transaction_hash,
        eventIndex: dlqItem.event_index,
        ledgerSequence: dlqItem.ledger_sequence,
        errorCategory: dlqItem.error_category,
        errorMessage: dlqItem.error_message,
        originalAttemptCount: dlqItem.original_attempt_count
      },
      timestamp: new Date().toISOString()
    };

    return await this.sendAlert(alert);
  }

  /**
   * Get alert severity based on error category
   */
  getAlertSeverity(errorCategory) {
    const severities = {
      'network': 'warning',
      'processing': 'warning',
      'validation': 'error',
      'xdr_parsing': 'critical',
      'database': 'critical'
    };
    
    return severities[errorCategory] || 'warning';
  }

  /**
   * Send custom alert
   */
  async sendCustomAlert(title, message, severity = 'info', details = {}) {
    const alert = {
      type: 'custom',
      severity,
      title,
      message,
      details,
      timestamp: new Date().toISOString()
    };

    return await this.sendAlert(alert);
  }

  /**
   * Test Slack webhook connectivity
   */
  async testConnection() {
    if (!this.enabled || !this.webhookUrl) {
      return { success: false, reason: 'disabled' };
    }

    try {
      const testMessage = {
        channel: this.channel,
        username: this.username,
        icon_emoji: this.iconEmoji,
        text: 'Test message from Soroban DLQ Bot',
        attachments: [{
          color: '#36a64f',
          text: 'This is a test message to verify Slack webhook connectivity.',
          footer: 'Soroban Event Indexer',
          ts: Math.floor(Date.now() / 1000)
        }]
      };

      const response = await axios.post(this.webhookUrl, testMessage, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return { 
        success: response.status === 200,
        status: response.status 
      };
      
    } catch (error) {
      this.logger.error('Slack webhook test failed', {
        error: error.message
      });
      
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Get alert statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - new Date(this.stats.startTime).getTime(),
      enabled: this.enabled,
      webhookConfigured: !!this.webhookUrl,
      lastAlertTime: this.lastAlertTime
    };
  }

  /**
   * Enable/disable alerts
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.logger.info(`Slack alerts ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Update rate limit
   */
  setRateLimit(rateLimitMs) {
    this.rateLimitMs = rateLimitMs;
    this.logger.info(`Slack alert rate limit updated to ${rateLimitMs}ms`);
  }
}

module.exports = { SlackAlertService };
