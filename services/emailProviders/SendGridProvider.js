const axios = require('axios');
const BaseEmailProvider = require('./BaseEmailProvider');

/**
 * SendGrid Email Provider
 * Implements email sending using SendGrid API
 */
class SendGridProvider extends BaseEmailProvider {
  constructor(config = {}) {
    super(config);
    
    this.apiKey = config.apiKey || process.env.SENDGRID_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.sendgrid.com/v3';
    this.version = config.version || 'v3';
    
    if (!this.apiKey) {
      throw new Error('SendGrid API key is required');
    }
    
    this.initializeAxios();
  }

  /**
   * Initialize Axios client with SendGrid configuration
   */
  initializeAxios() {
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 seconds timeout
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          error.code = error.response.status;
          error.message = error.response.data?.message || error.message;
        } else if (error.request) {
          // The request was made but no response was received
          error.code = 'NETWORK_ERROR';
          error.message = 'Network error occurred';
        }
        
        throw error;
      }
    );

    console.log('SendGrid provider initialized');
  }

  /**
   * Send email using SendGrid dynamic template
   * @param {Object} emailData - Email data
   * @returns {Promise<Object>} Send result
   */
  async sendEmail(emailData) {
    try {
      const normalized = this.normalizeEmailData(emailData);
      
      const payload = {
        personalizations: [{
          to: [{ email: normalized.to }],
          dynamic_template_data: normalized.templateData
        }],
        from: { email: normalized.from },
        template_id: normalized.templateId
      };

      // Add optional fields
      if (normalized.options.replyTo) {
        payload.reply_to = { email: normalized.options.replyTo };
      }

      if (normalized.options.cc) {
        payload.personalizations[0].cc = normalized.options.cc.map(email => ({ email }));
      }

      if (normalized.options.bcc) {
        payload.personalizations[0].bcc = normalized.options.bcc.map(email => ({ email }));
      }

      if (normalized.options.categories) {
        payload.categories = normalized.options.categories;
      }

      if (normalized.options.customArgs) {
        payload.custom_args = normalized.options.customArgs;
      }

      if (normalized.options.sendAt) {
        payload.send_at = normalized.options.sendAt;
      }

      const response = await this.client.post('/mail/send', payload);
      
      return this.createSuccess({
        messageId: response.headers['x-message-id'],
        templateId: normalized.templateId,
        recipient: normalized.to,
        requestId: response.headers['x-request-id']
      });

    } catch (error) {
      console.error('SendGrid sendEmail error:', error);
      throw this.createError(error, {
        templateId: emailData.templateId,
        recipient: emailData.to
      });
    }
  }

  /**
   * Send simple text/HTML email using SendGrid
   * @param {Object} emailData - Email data
   * @returns {Promise<Object>} Send result
   */
  async sendSimpleEmail(emailData) {
    try {
      const normalized = this.normalizeEmailData(emailData);
      
      const content = [];
      
      if (normalized.text) {
        content.push({
          type: 'text/plain',
          value: normalized.text
        });
      }
      
      if (normalized.html) {
        content.push({
          type: 'text/html',
          value: normalized.html
        });
      }

      if (content.length === 0) {
        throw new Error('Either text or HTML content is required');
      }

      const payload = {
        personalizations: [{
          to: [{ email: normalized.to }]
        }],
        from: { email: normalized.from },
        subject: normalized.subject,
        content
      };

      // Add optional fields
      if (normalized.options.replyTo) {
        payload.reply_to = { email: normalized.options.replyTo };
      }

      if (normalized.options.cc) {
        payload.personalizations[0].cc = normalized.options.cc.map(email => ({ email }));
      }

      if (normalized.options.bcc) {
        payload.personalizations[0].bcc = normalized.options.bcc.map(email => ({ email }));
      }

      if (normalized.options.categories) {
        payload.categories = normalized.options.categories;
      }

      if (normalized.options.customArgs) {
        payload.custom_args = normalized.options.customArgs;
      }

      if (normalized.options.sendAt) {
        payload.send_at = normalized.options.sendAt;
      }

      const response = await this.client.post('/mail/send', payload);
      
      return this.createSuccess({
        messageId: response.headers['x-message-id'],
        recipient: normalized.to,
        subject: normalized.subject,
        requestId: response.headers['x-request-id']
      });

    } catch (error) {
      console.error('SendGrid sendSimpleEmail error:', error);
      throw this.createError(error, {
        recipient: emailData.to,
        subject: emailData.subject
      });
    }
  }

  /**
   * Get template information from SendGrid
   * @param {string} templateId - Template ID
   * @returns {Promise<Object>} Template data
   */
  async getTemplate(templateId) {
    try {
      const response = await this.client.get(`/templates/${templateId}`);
      const template = response.data;
      
      return {
        id: template.id,
        name: template.name,
        generated_at: template.generated_at,
        versions: template.versions.map(version => ({
          id: version.id,
          template_id: version.template_id,
          active: version.active,
          name: version.name,
          subject: version.subject,
          html_content: version.html_content,
          plain_content: version.plain_content,
          created_at: version.created_at,
          updated_at: version.updated_at
        })),
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('SendGrid getTemplate error:', error);
      throw this.createError(error, { templateId });
    }
  }

  /**
   * Create template in SendGrid
   * @param {Object} templateData - Template data
   * @returns {Promise<Object>} Template result
   */
  async createTemplate(templateData) {
    try {
      const payload = {
        name: templateData.name,
        generation: 'dynamic'
      };

      const response = await this.client.post('/templates', payload);
      const template = response.data;
      
      // Create the first version
      if (templateData.subject || templateData.html || templateData.text) {
        await this.createTemplateVersion(template.id, {
          name: 'Version 1',
          subject: templateData.subject,
          html: templateData.html,
          text: templateData.text,
          active: true
        });
      }
      
      return this.createSuccess({
        templateId: template.id,
        name: template.name,
        generated_at: template.generated_at
      });

    } catch (error) {
      console.error('SendGrid createTemplate error:', error);
      throw this.createError(error, { templateName: templateData.name });
    }
  }

  /**
   * Create template version in SendGrid
   * @param {string} templateId - Template ID
   * @param {Object} versionData - Version data
   * @returns {Promise<Object>} Version result
   */
  async createTemplateVersion(templateId, versionData) {
    try {
      const payload = {
        template_id: templateId,
        name: versionData.name,
        subject: versionData.subject,
        html_content: versionData.html,
        plain_content: versionData.text,
        active: versionData.active || false
      };

      const response = await this.client.post(`/templates/${templateId}/versions`, payload);
      const version = response.data;
      
      return this.createSuccess({
        versionId: version.id,
        templateId: templateId,
        name: version.name,
        active: version.active,
        created_at: version.created_at
      });

    } catch (error) {
      console.error('SendGrid createTemplateVersion error:', error);
      throw this.createError(error, { templateId });
    }
  }

  /**
   * Update template version in SendGrid
   * @param {string} templateId - Template ID
   * @param {string} versionId - Version ID
   * @param {Object} versionData - Version data
   * @returns {Promise<Object>} Update result
   */
  async updateTemplateVersion(templateId, versionId, versionData) {
    try {
      const payload = {
        name: versionData.name,
        subject: versionData.subject,
        html_content: versionData.html,
        plain_content: versionData.text,
        active: versionData.active || false
      };

      const response = await this.client.patch(`/templates/${templateId}/versions/${versionId}`, payload);
      const version = response.data;
      
      return this.createSuccess({
        versionId: version.id,
        templateId: templateId,
        name: version.name,
        active: version.active,
        updated_at: version.updated_at
      });

    } catch (error) {
      console.error('SendGrid updateTemplateVersion error:', error);
      throw this.createError(error, { templateId, versionId });
    }
  }

  /**
   * Delete template from SendGrid
   * @param {string} templateId - Template ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteTemplate(templateId) {
    try {
      await this.client.delete(`/templates/${templateId}`);
      
      return this.createSuccess({
        templateId,
        deleted_at: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid deleteTemplate error:', error);
      throw this.createError(error, { templateId });
    }
  }

  /**
   * List all templates in SendGrid
   * @param {Object} options - List options
   * @returns {Promise<Object>} Templates list
   */
  async listTemplates(options = {}) {
    try {
      const params = {
        limit: options.limit || 100,
        offset: options.offset || 0
      };

      // Remove undefined values
      Object.keys(params).forEach(key => {
        if (params[key] === undefined) {
          delete params[key];
        }
      });

      const response = await this.client.get('/templates', { params });
      const templates = response.data;
      
      return this.createSuccess({
        templates: templates.result.map(template => ({
          id: template.id,
          name: template.name,
          generated_at: template.generated_at,
          versions: template.versions
        })),
        count: templates.result.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid listTemplates error:', error);
      throw this.createError(error);
    }
  }

  /**
   * Get sending statistics from SendGrid
   * @param {Object} options - Statistics options
   * @returns {Promise<Object>} Sending statistics
   */
  async getSendStatistics(options = {}) {
    try {
      const params = {
        start_date: options.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: options.endDate || new Date().toISOString(),
        aggregated_by: options.aggregatedBy || 'day'
      };

      const response = await this.client.get('/stats', { params });
      const stats = response.data;
      
      return this.createSuccess({
        statistics: stats,
        count: stats.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid getSendStatistics error:', error);
      throw this.createError(error);
    }
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - Error to check
   * @returns {boolean} Whether error is rate limit related
   */
  isRateLimitError(error) {
    return error.code === 429 || 
           error.code === 'Too Many Requests' ||
           (error.response && error.response.status === 429);
  }

  /**
   * Extract retry-after time from rate limit error
   * @param {Error} error - Rate limit error
   * @returns {number} Retry after time in seconds
   */
  getRetryAfter(error) {
    // Check for Retry-After header
    if (error.response && error.response.headers['retry-after']) {
      return parseInt(error.response.headers['retry-after'], 10);
    }
    
    // Check SendGrid rate limit response
    if (error.response && error.response.data) {
      const data = error.response.data;
      if (data.errors && data.errors.length > 0) {
        const rateLimitError = data.errors.find(err => 
          err.message && err.message.includes('rate limit')
        );
        if (rateLimitError) {
          return 60; // Default 60 seconds for SendGrid rate limits
        }
      }
    }
    
    return 60; // Default 60 seconds
  }

  /**
   * Test SendGrid connection
   * @returns {Promise<Object>} Test result
   */
  async testConnection() {
    try {
      // Try to get API key info as a connection test
      const response = await this.client.get('/user/account');
      const account = response.data;
      
      return {
        success: true,
        message: 'SendGrid connection successful',
        data: {
          username: account.username,
          email: account.email,
          reputation: account.reputation,
          plan: account.plan
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get provider-specific statistics
   * @returns {Object} Provider statistics
   */
  getStats() {
    return {
      ...super.getStats(),
      service: 'SendGrid',
      baseUrl: this.baseUrl,
      version: this.version
    };
  }

  /**
   * Validate email address using SendGrid API
   * @param {string} email - Email address to validate
   * @returns {Promise<Object>} Validation result
   */
  async validateEmail(email) {
    try {
      const response = await this.client.post('/validations/email', {
        email: email,
        source: 'signup'
      });
      
      const validation = response.data;
      
      return this.createSuccess({
        email,
        verdict: validation.verdict,
        score: validation.score,
        checks: validation.checks,
        ip_address: validation.ip_address,
        suggested_correction: validation.suggested_correction
      });

    } catch (error) {
      console.error('SendGrid validateEmail error:', error);
      throw this.createError(error, { email });
    }
  }

  /**
   * Get email activity from SendGrid
   * @param {Object} options - Activity options
   * @returns {Promise<Object>} Email activity
   */
  async getEmailActivity(options = {}) {
    try {
      const params = {
        limit: options.limit || 100,
        offset: options.offset || 0,
        query: options.query
      };

      // Remove undefined values
      Object.keys(params).forEach(key => {
        if (params[key] === undefined) {
          delete params[key];
        }
      });

      const response = await this.client.get('/messages', { params });
      const messages = response.data;
      
      return this.createSuccess({
        messages: messages.messages,
        count: messages.messages.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid getEmailActivity error:', error);
      throw this.createError(error);
    }
  }

  /**
   * Suppress email address
   * @param {string} email - Email address to suppress
   * @param {Object} options - Suppression options
   * @returns {Promise<Object>} Suppression result
   */
  async suppressEmail(email, options = {}) {
    try {
      const payload = {
        recipient_emails: [email]
      };

      if (options.groupIds) {
        payload.group_ids = options.groupIds;
      }

      const response = await this.client.post('/asm/suppressions', payload);
      
      return this.createSuccess({
        email,
        suppressed: true,
        requestId: response.headers['x-request-id'],
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid suppressEmail error:', error);
      throw this.createError(error, { email });
    }
  }

  /**
   * Unsuppress email address
   * @param {string} email - Email address to unsuppress
   * @param {number} groupId - Group ID
   * @returns {Promise<Object>} Unsuppression result
   */
  async unsuppressEmail(email, groupId) {
    try {
      const response = await this.client.delete(`/asm/groups/${groupId}/suppressions/${email}`);
      
      return this.createSuccess({
        email,
        groupId,
        unsuppressed: true,
        requestId: response.headers['x-request-id'],
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('SendGrid unsuppressEmail error:', error);
      throw this.createError(error, { email, groupId });
    }
  }
}

module.exports = SendGridProvider;
