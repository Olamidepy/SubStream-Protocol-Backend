/**
 * Base Email Provider Interface
 * Abstract interface for email providers to ensure consistent API
 */
class BaseEmailProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = this.constructor.name;
  }

  /**
   * Send an email using the provider
   * @param {Object} emailData - Email data
   * @param {string} emailData.to - Recipient email
   * @param {string} emailData.from - Sender email
   * @param {string} emailData.subject - Email subject
   * @param {string} emailData.templateId - Template identifier
   * @param {Object} emailData.templateData - Template variables
   * @param {Object} emailData.options - Additional provider-specific options
   * @returns {Promise<Object>} Send result
   */
  async sendEmail(emailData) {
    throw new Error('sendEmail method must be implemented by subclass');
  }

  /**
   * Send a simple text/HTML email
   * @param {Object} emailData - Email data
   * @param {string} emailData.to - Recipient email
   * @param {string} emailData.from - Sender email
   * @param {string} emailData.subject - Email subject
   * @param {string} emailData.text - Plain text content
   * @param {string} emailData.html - HTML content
   * @param {Object} emailData.options - Additional provider-specific options
   * @returns {Promise<Object>} Send result
   */
  async sendSimpleEmail(emailData) {
    throw new Error('sendSimpleEmail method must be implemented by subclass');
  }

  /**
   * Get provider-specific template
   * @param {string} templateId - Template identifier
   * @returns {Promise<Object>} Template data
   */
  async getTemplate(templateId) {
    throw new Error('getTemplate method must be implemented by subclass');
  }

  /**
   * Validate email address format
   * @param {string} email - Email address to validate
   * @returns {boolean} Whether email is valid
   */
  validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - Error to check
   * @returns {boolean} Whether error is rate limit related
   */
  isRateLimitError(error) {
    // Override in subclasses for provider-specific rate limit detection
    return false;
  }

  /**
   * Extract retry-after time from rate limit error
   * @param {Error} error - Rate limit error
   * @returns {number} Retry after time in seconds
   */
  getRetryAfter(error) {
    // Override in subclasses for provider-specific retry-after extraction
    return 60; // Default 60 seconds
  }

  /**
   * Get provider statistics
   * @returns {Object} Provider statistics
   */
  getStats() {
    return {
      name: this.name,
      config: this.getSafeConfig(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get safe configuration (without sensitive data)
   * @returns {Object} Safe configuration
   */
  getSafeConfig() {
    const safeConfig = { ...this.config };
    
    // Remove sensitive fields
    const sensitiveFields = ['apiKey', 'secretKey', 'password', 'privateKey'];
    sensitiveFields.forEach(field => {
      if (safeConfig[field]) {
        safeConfig[field] = '***';
      }
    });
    
    return safeConfig;
  }

  /**
   * Test provider connection
   * @returns {Promise<Object>} Test result
   */
  async testConnection() {
    try {
      // Default implementation - override in subclasses
      return {
        success: true,
        message: 'Connection test successful',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Normalize email data to ensure consistent format
   * @param {Object} emailData - Raw email data
   * @returns {Object} Normalized email data
   */
  normalizeEmailData(emailData) {
    const normalized = {
      to: emailData.to,
      from: emailData.from || this.config.defaultFrom,
      subject: emailData.subject,
      templateId: emailData.templateId,
      templateData: emailData.templateData || {},
      options: emailData.options || {}
    };

    // Validate required fields
    if (!normalized.to) {
      throw new Error('Recipient email (to) is required');
    }

    if (!normalized.from) {
      throw new Error('Sender email (from) is required');
    }

    if (!normalized.subject) {
      throw new Error('Email subject is required');
    }

    // Validate email addresses
    if (!this.validateEmail(normalized.to)) {
      throw new Error(`Invalid recipient email: ${normalized.to}`);
    }

    if (!this.validateEmail(normalized.from)) {
      throw new Error(`Invalid sender email: ${normalized.from}`);
    }

    return normalized;
  }

  /**
   * Create standardized error response
   * @param {Error} error - Original error
   * @param {Object} context - Additional context
   * @returns {Object} Standardized error
   */
  createError(error, context = {}) {
    return {
      success: false,
      provider: this.name,
      error: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      isRateLimit: this.isRateLimitError(error),
      retryAfter: this.isRateLimitError(error) ? this.getRetryAfter(error) : null,
      timestamp: new Date().toISOString(),
      context
    };
  }

  /**
   * Create standardized success response
   * @param {Object} data - Success data
   * @returns {Object} Standardized success
   */
  createSuccess(data) {
    return {
      success: true,
      provider: this.name,
      messageId: data.messageId || data.id,
      timestamp: new Date().toISOString(),
      ...data
    };
  }
}

module.exports = BaseEmailProvider;
