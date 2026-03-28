/**
 * Sentry Error Tracking Integration
 * 
 * Provides comprehensive error monitoring with:
 * - Automatic error capture and grouping
 * - Wallet address and contract ID tracking
 * - Performance monitoring
 * - Discord webhook alerts for critical errors
 */

const Sentry = require('@sentry/node');
const { logger } = require('./logger');
const axios = require('axios');

class ErrorTrackingService {
  constructor() {
    this.initialized = false;
    this.discordWebhookUrl = process.env.DISCORD_ERROR_WEBHOOK_URL;
  }

  /**
   * Initialize Sentry SDK
   */
  initialize() {
    if (this.initialized) {
      return;
    }

    const dsn = process.env.SENTRY_DSN;
    
    if (!dsn) {
      console.warn('[ErrorTracking] Sentry DSN not configured. Error tracking disabled.');
      return;
    }

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1, // 10% sampling
      profilesSampleRate: process.env.SENTRY_PROFILES_SAMPLE_RATE || 0.1,
      
      // Add contextual data to all events
      beforeSend: (event, hint) => {
        // Add wallet address if available
        if (hint.originalException?.walletAddress) {
          event.tags = {
            ...event.tags,
            walletAddress: hint.originalException.walletAddress.toLowerCase(),
          };
        }
        
        // Add contract ID if available
        if (hint.originalException?.contractId) {
          event.tags = {
            ...event.tags,
            contractId: hint.originalException.contractId,
          };
        }
        
        // Don't send in development unless explicitly enabled
        if (process.env.NODE_ENV === 'development' && !process.env.SENTRY_ENABLE_DEV) {
          return null;
        }
        
        return event;
      },
      
      // Integrations
      integrations: [
        // HTTP request tracing
        new Sentry.Integrations.Http({ tracing: true }),
        
        // Database query tracking
        new Sentry.Integrations.Postgres(),
        
        // Console error capture
        new Sentry.Integrations.Console(),
        
        // On-uncaught exceptions
        new Sentry.Integrations.OnUncaughtException(),
        
        // On-unhandled rejections
        new Sentry.Integrations.OnUnhandledRejection(),
      ],
    });

    this.initialized = true;
    console.log('[ErrorTracking] Sentry initialized successfully');
  }

  /**
   * Capture an exception with context
   * @param {Error} error - Error object
   * @param {object} context - Additional context
   */
  captureException(error, context = {}) {
    if (!this.initialized) {
      logger.error('Error occurred (Sentry not initialized)', { error: error.message, ...context });
      return;
    }

    Sentry.withScope((scope) => {
      // Set context tags
      if (context.walletAddress) {
        scope.setTag('walletAddress', context.walletAddress.toLowerCase());
      }
      
      if (context.contractId) {
        scope.setTag('contractId', context.contractId);
      }
      
      if (context.deviceId) {
        scope.setTag('deviceId', context.deviceId);
      }
      
      if (context.traceId) {
        scope.setTag('traceId', context.traceId);
      }
      
      // Set additional context
      scope.setContext('custom', {
        operation: context.operation,
        endpoint: context.endpoint,
        method: context.method,
        timestamp: new Date().toISOString(),
        ...context,
      });
      
      // Capture the exception
      Sentry.captureException(error);
    });

    // Also log with Winston
    logger.error(`Exception captured: ${error.message}`, {
      error: error.message,
      stack: error.stack,
      ...context,
    });

    // Check if we should send Discord alert
    this._checkDiscordAlert(error, context);
  }

  /**
   * Capture a message (for debugging/monitoring)
   * @param {string} message - Message to capture
   * @param {object} context - Additional context
   * @param {string} level - Severity level
   */
  captureMessage(message, context = {}, level = 'info') {
    if (!this.initialized) {
      logger[level](message, context);
      return;
    }

    Sentry.withScope((scope) => {
      if (context.walletAddress) {
        scope.setTag('walletAddress', context.walletAddress.toLowerCase());
      }
      
      if (context.contractId) {
        scope.setTag('contractId', context.contractId);
      }
      
      scope.setContext('custom', context);
      Sentry.captureMessage(message, level);
    });

    logger[level](message, context);
  }

  /**
   * Start a performance trace
   * @param {string} name - Trace name
   * @param {object} context - Trace context
   */
  startTrace(name, context = {}) {
    if (!this.initialized) {
      return null;
    }

    const transaction = Sentry.startTransaction({
      name,
      op: context.op || 'function',
      tags: {
        walletAddress: context.walletAddress?.toLowerCase(),
        contractId: context.contractId,
      },
    });

    return transaction;
  }

  /**
   * Set user context for error tracking
   * @param {string} walletAddress - Wallet address
   * @param {object} metadata - Additional user metadata
   */
  setUser(walletAddress, metadata = {}) {
    if (!this.initialized) {
      return;
    }

    Sentry.setUser({
      id: walletAddress.toLowerCase(),
      username: walletAddress,
      ...metadata,
    });
  }

  /**
   * Clear user context
   */
  clearUser() {
    if (!this.initialized) {
      return;
    }

    Sentry.setUser(null);
  }

  /**
   * Check if Discord alert should be sent
   * @param {Error} error - Error object
   * @param {object} context - Context
   */
  async _checkDiscordAlert(error, context) {
    // Only alert for critical errors
    const isCritical = 
      context.riskLevel === 'critical' ||
      error.name === 'CriticalError' ||
      context.forceAlert === true;

    if (!isCritical || !this.discordWebhookUrl) {
      return;
    }

    try {
      await this.sendDiscordAlert(error, context);
    } catch (discordError) {
      logger.error('Failed to send Discord alert', {
        error: discordError.message,
        originalError: error.message,
      });
    }
  }

  /**
   * Send alert to Discord webhook
   * @param {Error} error - Error object
   * @param {object} context - Context
   */
  async sendDiscordAlert(error, context) {
    if (!this.discordWebhookUrl) {
      console.warn('[ErrorTracking] Discord webhook not configured');
      return;
    }

    const embed = {
      title: `🚨 Critical Error Alert`,
      color: 15158332, // Red
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: 'Error',
          value: `\`${error.message}\``,
          inline: false,
        },
        {
          name: 'Type',
          value: `\`${error.name}\``,
          inline: true,
        },
        {
          name: 'Environment',
          value: process.env.NODE_ENV || 'development',
          inline: true,
        },
      ],
    };

    // Add context fields
    if (context.walletAddress) {
      embed.fields.push({
        name: 'Wallet',
        value: `\`${context.walletAddress.toLowerCase()}\``,
        inline: true,
      });
    }

    if (context.contractId) {
      embed.fields.push({
        name: 'Contract',
        value: `\`${context.contractId}\``,
        inline: true,
      });
    }

    if (context.traceId) {
      embed.fields.push({
        name: 'Trace ID',
        value: `\`${context.traceId}\``,
        inline: true,
      });
    }

    // Add stack trace (truncated)
    if (error.stack) {
      const stackLines = error.stack.split('\n').slice(0, 5).join('\n');
      embed.fields.push({
        name: 'Stack Trace',
        value: `\`\`\`${stackLines}\`\`\``,
        inline: false,
      });
    }

    const payload = {
      username: 'SubStream Error Monitor',
      avatar_url: 'https://avatars.githubusercontent.com/u/123456789',
      embeds: [embed],
    };

    await axios.post(this.discordWebhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    logger.info('Discord alert sent successfully', {
      error: error.message,
    });
  }

  /**
   * Flush pending events to Sentry
   */
  async flush() {
    if (!this.initialized) {
      return;
    }

    await Sentry.flush(5000); // Wait up to 5 seconds
  }

  /**
   * Close Sentry connection
   */
  async close() {
    if (!this.initialized) {
      return;
    }

    await Sentry.close();
    this.initialized = false;
  }
}

// Export singleton instance
const errorTracking = new ErrorTrackingService();
module.exports = { ErrorTrackingService, errorTracking };
