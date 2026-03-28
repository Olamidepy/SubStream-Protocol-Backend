const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

/**
 * SSL certificate automation service using Caddy and Let's Encrypt.
 */
class SslCertificateService {
  /**
   * @param {object} config Application configuration
   */
  constructor(config) {
    this.config = config;
    this.caddyConfigPath = config.ssl?.caddyConfigPath || '/etc/caddy/Caddyfile';
    this.caddyApiUrl = config.ssl?.caddyApiUrl || 'http://localhost:2019';
    this.letsEncryptEmail = config.ssl?.letsEncryptEmail || 'admin@substream.app';
    this.certsDir = config.ssl?.certsDir || '/etc/caddy/certs';
    this.isTestMode = config.ssl?.testMode || false;
  }

  /**
   * Add SSL certificate configuration for a new subdomain.
   * @param {{subdomain: string, creatorId: string}} data Subdomain data
   * @returns {Promise<object>} Configuration result
   */
  async addSubdomainSsl(data) {
    try {
      const { subdomain, creatorId } = data;
      const domain = `${subdomain}.${this.config.substream?.baseDomain || 'substream.app'}`;

      // Update Caddy configuration
      await this.updateCaddyConfig(domain, creatorId);

      // Reload Caddy configuration
      await this.reloadCaddy();

      return {
        domain,
        status: 'configured',
        message: `SSL certificate configuration added for ${domain}`
      };
    } catch (error) {
      console.error('Error adding SSL for subdomain:', error);
      throw new Error(`Failed to configure SSL: ${error.message}`);
    }
  }

  /**
   * Remove SSL certificate configuration for a subdomain.
   * @param {{subdomain: string}} data Subdomain data
   * @returns {Promise<object>} Removal result
   */
  async removeSubdomainSsl(data) {
    try {
      const { subdomain } = data;
      const domain = `${subdomain}.${this.config.substream?.baseDomain || 'substream.app'}`;

      // Remove from Caddy configuration
      await this.removeFromCaddyConfig(domain);

      // Reload Caddy configuration
      await this.reloadCaddy();

      return {
        domain,
        status: 'removed',
        message: `SSL certificate configuration removed for ${domain}`
      };
    } catch (error) {
      console.error('Error removing SSL for subdomain:', error);
      throw new Error(`Failed to remove SSL: ${error.message}`);
    }
  }

  /**
   * Update Caddy configuration with new subdomain.
   * @param {string} domain Full domain name
   * @param {string} creatorId Creator ID for routing
   */
  async updateCaddyConfig(domain, creatorId) {
    const configBlock = this.generateCaddyConfigBlock(domain, creatorId);
    
    if (this.config.ssl?.useApi) {
      await this.updateCaddyViaApi(domain, configBlock);
    } else {
      await this.updateCaddyFile(domain, configBlock);
    }
  }

  /**
   * Generate Caddy configuration block for a subdomain.
   * @param {string} domain Full domain name
   * @param {string} creatorId Creator ID
   * @returns {string} Caddy configuration block
   */
  generateCaddyConfigBlock(domain, creatorId) {
    const backendUrl = this.config.substream?.backendUrl || 'http://localhost:3000';
    
    return `
${domain} {
    # SSL/TLS configuration
    tls {
        email ${this.letsEncryptEmail}
        ${this.isTestMode ? 'ca https://acme-staging-v02.api.letsencrypt.org/directory' : ''}
    }

    # Security headers
    header {
        # HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        # Other security headers
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # CORS headers
    header {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    }

    # Route to backend with creator context
    reverse_proxy ${backendUrl} {
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-For {remote}
        header_up X-Creator-Id "${creatorId}"
    }

    # Handle preflight requests
    @options method OPTIONS
    respond @options 200

    # Rate limiting
    rate_limit {
        zone static
        events 100
        window 1m
    }
}`;
  }

  /**
   * Update Caddy configuration via API.
   * @param {string} domain Domain name
   * @param {string} configBlock Configuration block
   */
  async updateCaddyViaApi(domain, configBlock) {
    const config = {
      apps: {
        http: {
          servers: {
            main: {
              listen: [":443"],
              routes: [
                {
                  match: [{ host: [domain] }],
                  handle: [
                    {
                      handler: "subroute",
                      routes: this.parseCaddyConfigToRoutes(configBlock)
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    };

    const response = await fetch(`${this.caddyApiUrl}/config/apps/http`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      throw new Error(`Caddy API error: ${response.statusText}`);
    }
  }

  /**
   * Update Caddy configuration file.
   * @param {string} domain Domain name
   * @param {string} configBlock Configuration block
   */
  async updateCaddyFile(domain, configBlock) {
    let currentConfig = '';
    
    // Read existing config
    if (fs.existsSync(this.caddyConfigPath)) {
      currentConfig = fs.readFileSync(this.caddyConfigPath, 'utf8');
    }

    // Remove existing config for this domain if it exists
    const domainRegex = new RegExp(`^${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'gm');
    currentConfig = currentConfig.replace(domainRegex, '');

    // Add new config
    currentConfig += '\n' + configBlock + '\n';

    // Write updated config
    fs.writeFileSync(this.caddyConfigPath, currentConfig);
  }

  /**
   * Remove domain from Caddy configuration.
   * @param {string} domain Domain name
   */
  async removeFromCaddyConfig(domain) {
    if (this.config.ssl?.useApi) {
      await this.removeFromCaddyViaApi(domain);
    } else {
      await this.removeFromCaddyFile(domain);
    }
  }

  /**
   * Remove domain from Caddy configuration via API.
   * @param {string} domain Domain name
   */
  async removeFromCaddyViaApi(domain) {
    // This would require implementing the Caddy API DELETE endpoint
    // For now, we'll use a simpler approach by reloading the config
    console.log(`Removing ${domain} from Caddy API configuration`);
  }

  /**
   * Remove domain from Caddy configuration file.
   * @param {string} domain Domain name
   */
  async removeFromCaddyFile(domain) {
    if (!fs.existsSync(this.caddyConfigPath)) {
      return;
    }

    let currentConfig = fs.readFileSync(this.caddyConfigPath, 'utf8');
    
    // Remove config block for this domain
    const domainRegex = new RegExp(`^${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'gm');
    currentConfig = currentConfig.replace(domainRegex, '');

    // Clean up extra whitespace
    currentConfig = currentConfig.replace(/\n\s*\n\s*\n/g, '\n\n');

    fs.writeFileSync(this.caddyConfigPath, currentConfig);
  }

  /**
   * Reload Caddy configuration.
   */
  async reloadCaddy() {
    if (this.config.ssl?.useApi) {
      await this.reloadCaddyViaApi();
    } else {
      await this.reloadCaddyViaCommand();
    }
  }

  /**
   * Reload Caddy via API.
   */
  async reloadCaddyViaApi() {
    const response = await fetch(`${this.caddyApiUrl}/reload`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Failed to reload Caddy: ${response.statusText}`);
    }
  }

  /**
   * Reload Caddy via command line.
   */
  async reloadCaddyViaCommand() {
    return new Promise((resolve, reject) => {
      exec('caddy reload --config /etc/caddy/Caddyfile', (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Caddy reload failed: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Check SSL certificate status for a domain.
   * @param {string} domain Domain name
   * @returns {Promise<object>} Certificate status
   */
  async checkCertificateStatus(domain) {
    try {
      const response = await fetch(`${this.caddyApiUrl}/certificates/${domain}`);
      
      if (!response.ok) {
        return {
          domain,
          status: 'error',
          message: 'Certificate not found or API error'
        };
      }

      const cert = await response.json();
      
      return {
        domain,
        status: 'active',
        expiresAt: cert.expires,
        issuer: cert.issuer,
        subject: cert.subject
      };
    } catch (error) {
      return {
        domain,
        status: 'error',
        message: error.message
      };
    }
  }

  /**
   * Get all active certificates.
   * @returns {Promise<object[]>} Array of certificate information
   */
  async getAllCertificates() {
    try {
      const response = await fetch(`${this.caddyApiUrl}/certificates/`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch certificates: ${response.statusText}`);
      }

      const certificates = await response.json();
      
      return certificates.map(cert => ({
        domain: cert.sans[0],
        status: 'active',
        expiresAt: cert.expires,
        issuer: cert.issuer,
        subject: cert.subject,
        sans: cert.sans
      }));
    } catch (error) {
      console.error('Error fetching certificates:', error);
      return [];
    }
  }

  /**
   * Generate a self-signed certificate for development/testing.
   * @param {string} domain Domain name
   * @returns {Promise<string>} Path to generated certificate
   */
  async generateSelfSignedCert(domain) {
    const certPath = path.join(this.certsDir, `${domain}.crt`);
    const keyPath = path.join(this.certsDir, `${domain}.key`);

    // Ensure certs directory exists
    if (!fs.existsSync(this.certsDir)) {
      fs.mkdirSync(this.certsDir, { recursive: true });
    }

    // Generate self-signed certificate using OpenSSL
    const command = `openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\
      -keyout "${keyPath}" \\
      -out "${certPath}" \\
      -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=${domain}"`;

    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to generate certificate: ${stderr}`));
        } else {
          resolve({ certPath, keyPath });
        }
      });
    });
  }

  /**
   * Parse Caddy configuration block to API routes (simplified).
   * @param {string} configBlock Caddy configuration block
   * @returns {object} Routes configuration
   */
  parseCaddyConfigToRoutes(configBlock) {
    // This is a simplified parser - in production, you'd want a more robust solution
    return [
      {
        handler: "reverse_proxy",
        upstreams: [
          {
            dial: this.config.substream?.backendUrl || "localhost:3000"
          }
        ]
      }
    ];
  }

  /**
   * Test Caddy connectivity.
   * @returns {Promise<boolean>} True if Caddy is accessible
   */
  async testCaddyConnectivity() {
    try {
      const response = await fetch(`${this.caddyApiUrl}/version`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

module.exports = {
  SslCertificateService
};
