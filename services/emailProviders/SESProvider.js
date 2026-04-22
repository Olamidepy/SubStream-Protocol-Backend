const AWS = require('aws-sdk');
const BaseEmailProvider = require('./BaseEmailProvider');

/**
 * AWS SES Email Provider
 * Implements email sending using AWS Simple Email Service
 */
class SESProvider extends BaseEmailProvider {
  constructor(config = {}) {
    super(config);
    
    this.region = config.region || process.env.AWS_REGION || 'us-east-1';
    this.accessKeyId = config.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    this.sessionToken = config.sessionToken || process.env.AWS_SESSION_TOKEN;
    
    this.initializeSES();
  }

  /**
   * Initialize AWS SES client
   */
  initializeSES() {
    try {
      AWS.config.update({
        region: this.region,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        sessionToken: this.sessionToken
      });

      this.ses = new AWS.SES({
        apiVersion: '2010-12-01',
        region: this.region
      });

      console.log(`AWS SES provider initialized for region: ${this.region}`);
    } catch (error) {
      console.error('Failed to initialize AWS SES:', error);
      throw error;
    }
  }

  /**
   * Send email using AWS SES template
   * @param {Object} emailData - Email data
   * @returns {Promise<Object>} Send result
   */
  async sendEmail(emailData) {
    try {
      const normalized = this.normalizeEmailData(emailData);
      
      const params = {
        Destination: {
          ToAddresses: [normalized.to]
        },
        Source: normalized.from,
        Template: normalized.templateId,
        TemplateData: JSON.stringify(normalized.templateData),
        ConfigurationSetName: normalized.options.configurationSetName,
        ReplyToAddresses: normalized.options.replyTo || [],
        ReturnPath: normalized.options.returnPath || normalized.from
      };

      // Remove undefined values
      Object.keys(params).forEach(key => {
        if (params[key] === undefined) {
          delete params[key];
        }
      });

      const result = await this.ses.sendTemplatedEmail(params).promise();
      
      return this.createSuccess({
        messageId: result.MessageId,
        templateId: normalized.templateId,
        recipient: normalized.to
      });

    } catch (error) {
      console.error('AWS SES sendEmail error:', error);
      throw this.createError(error, {
        templateId: emailData.templateId,
        recipient: emailData.to
      });
    }
  }

  /**
   * Send simple text/HTML email using AWS SES
   * @param {Object} emailData - Email data
   * @returns {Promise<Object>} Send result
   */
  async sendSimpleEmail(emailData) {
    try {
      const normalized = this.normalizeEmailData(emailData);
      
      const params = {
        Destination: {
          ToAddresses: [normalized.to]
        },
        Source: normalized.from,
        Message: {
          Subject: {
            Data: normalized.subject,
            Charset: 'UTF-8'
          },
          Body: {
            Text: normalized.text ? {
              Data: normalized.text,
              Charset: 'UTF-8'
            } : undefined,
            Html: normalized.html ? {
              Data: normalized.html,
              Charset: 'UTF-8'
            } : undefined
          }
        },
        ConfigurationSetName: normalized.options.configurationSetName,
        ReplyToAddresses: normalized.options.replyTo || [],
        ReturnPath: normalized.options.returnPath || normalized.from
      };

      // Remove undefined values from Message.Body
      Object.keys(params.Message.Body).forEach(key => {
        if (params.Message.Body[key] === undefined) {
          delete params.Message.Body[key];
        }
      });

      // Remove undefined values from params
      Object.keys(params).forEach(key => {
        if (params[key] === undefined) {
          delete params[key];
        }
      });

      const result = await this.ses.sendEmail(params).promise();
      
      return this.createSuccess({
        messageId: result.MessageId,
        recipient: normalized.to,
        subject: normalized.subject
      });

    } catch (error) {
      console.error('AWS SES sendSimpleEmail error:', error);
      throw this.createError(error, {
        recipient: emailData.to,
        subject: emailData.subject
      });
    }
  }

  /**
   * Get template information from AWS SES
   * @param {string} templateName - Template name
   * @returns {Promise<Object>} Template data
   */
  async getTemplate(templateName) {
    try {
      const params = {
        TemplateName: templateName
      };

      const result = await this.ses.getTemplate(params).promise();
      
      return {
        name: result.Template.TemplateName,
        subject: result.Template.SubjectPart,
        text: result.Template.TextPart,
        html: result.Template.HtmlPart,
        created_at: result.Template.CreatedAt,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('AWS SES getTemplate error:', error);
      throw this.createError(error, { templateName });
    }
  }

  /**
   * Create or update template in AWS SES
   * @param {Object} templateData - Template data
   * @returns {Promise<Object>} Template result
   */
  async createTemplate(templateData) {
    try {
      const params = {
        TemplateName: templateData.name,
        SubjectPart: templateData.subject,
        HtmlPart: templateData.html,
        TextPart: templateData.text || ''
      };

      const result = await this.ses.createTemplate(params).promise();
      
      return this.createSuccess({
        templateName: result.Template.TemplateName,
        created_at: result.Template.CreatedAt
      });

    } catch (error) {
      console.error('AWS SES createTemplate error:', error);
      throw this.createError(error, { templateName: templateData.name });
    }
  }

  /**
   * Update existing template in AWS SES
   * @param {Object} templateData - Template data
   * @returns {Promise<Object>} Template result
   */
  async updateTemplate(templateData) {
    try {
      const params = {
        TemplateName: templateData.name,
        SubjectPart: templateData.subject,
        HtmlPart: templateData.html,
        TextPart: templateData.text || ''
      };

      const result = await this.ses.updateTemplate(params).promise();
      
      return this.createSuccess({
        templateName: result.Template.TemplateName,
        updated_at: new Date().toISOString()
      });

    } catch (error) {
      console.error('AWS SES updateTemplate error:', error);
      throw this.createError(error, { templateName: templateData.name });
    }
  }

  /**
   * Delete template from AWS SES
   * @param {string} templateName - Template name
   * @returns {Promise<Object>} Delete result
   */
  async deleteTemplate(templateName) {
    try {
      const params = {
        TemplateName: templateName
      };

      await this.ses.deleteTemplate(params).promise();
      
      return this.createSuccess({
        templateName,
        deleted_at: new Date().toISOString()
      });

    } catch (error) {
      console.error('AWS SES deleteTemplate error:', error);
      throw this.createError(error, { templateName });
    }
  }

  /**
   * List all templates in AWS SES
   * @param {Object} options - List options
   * @returns {Promise<Object>} Templates list
   */
  async listTemplates(options = {}) {
    try {
      const params = {
        MaxItems: options.maxItems || 100,
        NextToken: options.nextToken
      };

      // Remove undefined values
      Object.keys(params).forEach(key => {
        if (params[key] === undefined) {
          delete params[key];
        }
      });

      const result = await this.ses.listTemplates(params).promise();
      
      const templates = result.TemplatesMetadata.map(template => ({
        name: template.Name,
        created_at: template.CreatedAt
      }));

      return this.createSuccess({
        templates,
        nextToken: result.NextToken,
        count: templates.length
      });

    } catch (error) {
      console.error('AWS SES listTemplates error:', error);
      throw this.createError(error);
    }
  }

  /**
   * Get sending statistics from AWS SES
   * @returns {Promise<Object>} Sending statistics
   */
  async getSendStatistics() {
    try {
      const result = await this.ses.getSendStatistics().promise();
      
      const stats = result.SendDataPoints.map(point => ({
        timestamp: point.Timestamp,
        deliveryAttempts: point.DeliveryAttempts,
        bounces: point.Bounces,
        complaints: point.Complaints,
        rejects: point.Rejects
      }));

      return this.createSuccess({
        statistics: stats,
        count: stats.length
      });

    } catch (error) {
      console.error('AWS SES getSendStatistics error:', error);
      throw this.createError(error);
    }
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - Error to check
   * @returns {boolean} Whether error is rate limit related
   */
  isRateLimitError(error) {
    return error.code === 'ThrottlingException' || 
           error.code === 'TooManyRequestsException' ||
           error.code === 'SendingPausedException';
  }

  /**
   * Extract retry-after time from rate limit error
   * @param {Error} error - Rate limit error
   * @returns {number} Retry after time in seconds
   */
  getRetryAfter(error) {
    // AWS SES rate limits typically reset within seconds to minutes
    if (error.message && error.message.includes('maximum send rate')) {
      return 60; // 1 minute for send rate limits
    }
    
    if (error.code === 'ThrottlingException') {
      return 30; // 30 seconds for general throttling
    }
    
    return 60; // Default 60 seconds
  }

  /**
   * Test AWS SES connection
   * @returns {Promise<Object>} Test result
   */
  async testConnection() {
    try {
      // Try to get send quota as a connection test
      const result = await this.ses.getSendQuota().promise();
      
      return {
        success: true,
        message: 'AWS SES connection successful',
        data: {
          max24HourSend: result.Max24HourSend,
          maxSendRate: result.MaxSendRate,
          sentLast24Hours: result.SentLast24Hours
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
      region: this.region,
      service: 'AWS SES'
    };
  }

  /**
   * Verify email address or domain
   * @param {string} email - Email address to verify
   * @returns {Promise<Object>} Verification result
   */
  async verifyEmail(email) {
    try {
      const params = {
        EmailAddress: email
      };

      const result = await this.ses.verifyEmailIdentity(params).promise();
      
      return this.createSuccess({
        email,
        verificationStatus: 'pending',
        requestId: result.ResponseMetadata.RequestId
      });

    } catch (error) {
      console.error('AWS SES verifyEmail error:', error);
      throw this.createError(error, { email });
    }
  }

  /**
   * Get verification status for email or domain
   * @param {string} identity - Email address or domain
   * @returns {Promise<Object>} Verification status
   */
  async getVerificationStatus(identity) {
    try {
      const params = {
        Identities: [identity]
      };

      const result = await this.ses.getIdentityVerificationAttributes(params).promise();
      
      const verificationAttributes = result.VerificationAttributes[identity];
      
      return this.createSuccess({
        identity,
        verificationStatus: verificationAttributes.VerificationStatus,
        verificationToken: verificationAttributes.VerificationToken,
        verificationAttributes: {
          dkimEnabled: verificationAttributes.DkimEnabled,
          dkimVerificationStatus: verificationAttributes.DkimVerificationStatus,
          dkimTokens: verificationAttributes.DkimTokens,
          mailFromDomain: verificationAttributes.MailFromDomain,
          mailFromDomainStatus: verificationAttributes.MailFromDomainStatus
        }
      });

    } catch (error) {
      console.error('AWS SES getVerificationStatus error:', error);
      throw this.createError(error, { identity });
    }
  }
}

module.exports = SESProvider;
