const crypto = require('crypto');

/**
 * Service for managing creator subdomains.
 */
class SubdomainService {
  /**
   * @param {object} database Database instance
   * @param {object} config Application configuration
   */
  constructor(database, config) {
    this.database = database;
    this.config = config;
    this.baseDomain = config.substream?.baseDomain || 'substream.app';
    this.reservedSubdomains = new Set([
      'www', 'api', 'admin', 'mail', 'ftp', 'ssh', 'test', 'staging', 'dev',
      'blog', 'news', 'support', 'help', 'docs', 'status', 'health', 'metrics',
      'cdn', 'assets', 'static', 'media', 'files', 'download', 'upload',
      'account', 'billing', 'payment', 'checkout', 'cart', 'shop',
      'email', 'newsletter', 'marketing', 'analytics', 'tracking',
      'ssl', 'cert', 'certificate', 'security', 'auth', 'login', 'register',
      'beta', 'alpha', 'demo', 'preview', 'sandbox', 'temp', 'tmp'
    ]);
  }

  /**
   * Create a new subdomain for a creator.
   * @param {{creatorId: string, subdomain: string}} data Subdomain data
   * @returns {object} Created subdomain record
   */
  async createSubdomain(data) {
    const { creatorId, subdomain } = data;

    // Validate subdomain
    this.validateSubdomain(subdomain);

    // Check if subdomain is already taken
    const existing = this.database.getCreatorSubdomainByName(subdomain);
    if (existing) {
      throw new Error(`Subdomain "${subdomain}" is already taken`);
    }

    // Create the subdomain
    const subdomainRecord = this.database.createCreatorSubdomain({
      creatorId,
      subdomain: subdomain.toLowerCase()
    });

    return subdomainRecord;
  }

  /**
   * Get all subdomains for a creator.
   * @param {string} creatorId Creator ID
   * @returns {object[]} Array of subdomain records
   */
  getCreatorSubdomains(creatorId) {
    return this.database.getCreatorSubdomains(creatorId);
  }

  /**
   * Get a specific subdomain by ID.
   * @param {string} subdomainId Subdomain ID
   * @returns {object|null} Subdomain record or null
   */
  getSubdomain(subdomainId) {
    return this.database.getCreatorSubdomain(subdomainId);
  }

  /**
   * Update subdomain status.
   * @param {{subdomainId: string, status: string}} data Update data
   * @returns {object} Updated subdomain record
   */
  updateSubdomainStatus(data) {
    const validStatuses = ['active', 'inactive', 'suspended'];
    if (!validStatuses.includes(data.status)) {
      throw new Error(`Invalid status: ${data.status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    return this.database.updateSubdomainStatus(data);
  }

  /**
   * Delete a subdomain.
   * @param {string} subdomainId Subdomain ID
   * @returns {boolean} True if deleted successfully
   */
  deleteSubdomain(subdomainId) {
    return this.database.deleteCreatorSubdomain(subdomainId);
  }

  /**
   * Check if a subdomain is available.
   * @param {string} subdomain Subdomain name
   * @returns {boolean} True if available
   */
  isSubdomainAvailable(subdomain) {
    try {
      this.validateSubdomain(subdomain);
      const existing = this.database.getCreatorSubdomainByName(subdomain);
      return !existing;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get suggested available subdomains based on a preferred name.
   * @param {string} preferredName Preferred subdomain name
   * @param {number} maxSuggestions Maximum number of suggestions to return
   * @returns {string[]} Array of available subdomain suggestions
   */
  getAvailableSubdomainSuggestions(preferredName, maxSuggestions = 5) {
    const suggestions = [];
    const baseName = preferredName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    if (!baseName || baseName.length < 3) {
      return suggestions;
    }

    // Try the base name first
    if (this.isSubdomainAvailable(baseName)) {
      suggestions.push(baseName);
    }

    // Try variations
    const variations = [
      baseName + '-app',
      baseName + '-stream',
      baseName + '-tv',
      baseName + '-media',
      baseName + '-content',
      baseName + '-channel',
      baseName + '-show',
      baseName + '-live',
      baseName + Math.floor(Math.random() * 1000),
      'get-' + baseName,
      baseName + '-official'
    ];

    for (const variation of variations) {
      if (suggestions.length >= maxSuggestions) break;
      if (variation.length > 63) continue; // RFC 1035 limit
      if (this.isSubdomainAvailable(variation)) {
        suggestions.push(variation);
      }
    }

    return suggestions;
  }

  /**
   * Validate subdomain format and restrictions.
   * @param {string} subdomain Subdomain name to validate
   * @throws {Error} If subdomain is invalid
   */
  validateSubdomain(subdomain) {
    if (!subdomain || typeof subdomain !== 'string') {
      throw new Error('Subdomain is required and must be a string');
    }

    const cleanSubdomain = subdomain.toLowerCase().trim();
    
    if (cleanSubdomain.length < 3) {
      throw new Error('Subdomain must be at least 3 characters long');
    }

    if (cleanSubdomain.length > 63) {
      throw new Error('Subdomain must be less than 63 characters long');
    }

    // RFC 1035 validation: only letters, numbers, and hyphens
    if (!/^[a-z0-9-]+$/.test(cleanSubdomain)) {
      throw new Error('Subdomain can only contain letters, numbers, and hyphens');
    }

    // Cannot start or end with hyphen
    if (cleanSubdomain.startsWith('-') || cleanSubdomain.endsWith('-')) {
      throw new Error('Subdomain cannot start or end with a hyphen');
    }

    // Cannot have consecutive hyphens
    if (cleanSubdomain.includes('--')) {
      throw new Error('Subdomain cannot contain consecutive hyphens');
    }

    // Check against reserved subdomains
    if (this.reservedSubdomains.has(cleanSubdomain)) {
      throw new Error(`"${cleanSubdomain}" is a reserved subdomain`);
    }

    // Check if it's too similar to base domain
    if (cleanSubdomain === this.baseDomain.split('.')[0]) {
      throw new Error('Subdomain cannot be the same as the base domain');
    }
  }

  /**
   * Get the full URL for a subdomain.
   * @param {string} subdomain Subdomain name
   * @param {string} path Optional path
   * @returns {string} Full URL
   */
  getSubdomainUrl(subdomain, path = '') {
    const protocol = this.config.substream?.ssl?.enabled ? 'https' : 'http';
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return `${protocol}://${subdomain}.${this.baseDomain}${cleanPath}`;
  }

  /**
   * Generate a random available subdomain.
   * @param {string} prefix Optional prefix for the subdomain
   * @returns {string|null} Available subdomain or null if none found
   */
  generateRandomSubdomain(prefix = 'creator') {
    const maxAttempts = 10;
    
    for (let i = 0; i < maxAttempts; i++) {
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const subdomain = `${prefix}-${randomSuffix}`;
      
      if (this.isSubdomainAvailable(subdomain)) {
        return subdomain;
      }
    }
    
    return null;
  }
}

module.exports = {
  SubdomainService
};
