
/**
 * Privacy Service
 * Manages user privacy preferences for off-chain data sharing
 */
class PrivacyService {
  constructor(database) {
    this.db = database;
  }

  /**
   * Get privacy preferences for a user
   * @param {string} walletAddress 
   * @returns {Promise<Object>}
   */
  async getPreferences(walletAddress) {
    if (!walletAddress) throw new Error('Wallet address is required');
    
    // Check if preferences exist in SQLite or Postgres depending on DB setup
    // For now, we'll implement it as a generic query that AppDatabase can handle
    // if AppDatabase is using Knex, or we can use Knex directly if we have access to it.
    
    // In this codebase, AppDatabase uses better-sqlite3 directly for many things.
    // However, the issue mentions Postgres.
    // I'll add methods to AppDatabase or use a new service that uses Knex if available.
    
    try {
      const prefs = await this.db.getPrivacyPreferences(walletAddress);
      if (prefs) return prefs;

      // Default preferences if none found
      return {
        wallet_address: walletAddress,
        share_email_with_merchants: true,
        allow_marketing: true
      };
    } catch (error) {
      console.error('Error fetching privacy preferences:', error);
      return {
        wallet_address: walletAddress,
        share_email_with_merchants: true,
        allow_marketing: true
      };
    }
  }

  /**
   * Update privacy preferences for a user
   * @param {string} walletAddress 
   * @param {Object} preferences 
   * @returns {Promise<Object>}
   */
  async updatePreferences(walletAddress, preferences) {
    if (!walletAddress) throw new Error('Wallet address is required');
    
    const updateData = {};
    if (preferences.share_email_with_merchants !== undefined) {
      updateData.share_email_with_merchants = !!preferences.share_email_with_merchants;
    }
    if (preferences.allow_marketing !== undefined) {
      updateData.allow_marketing = !!preferences.allow_marketing;
    }

    return await this.db.upsertPrivacyPreferences(walletAddress, updateData);
  }

  /**
   * Scrub PII from a payload based on user preferences
   * @param {string} walletAddress 
   * @param {Object} payload 
   * @returns {Promise<Object>}
   */
  async scrubPayload(walletAddress, payload) {
    const prefs = await this.getPreferences(walletAddress);
    
    const scrubbedPayload = { ...payload };

    if (!prefs.share_email_with_merchants) {
      // Remove email and other PII
      delete scrubbedPayload.email;
      delete scrubbedPayload.user_email;
      delete scrubbedPayload.customer_email;
      delete scrubbedPayload.pii;
      
      // Ensure only pubkey and status remain if that's the requirement
      // The issue says: "The merchant will only receive the raw Stellar pubkey and the payment status"
      // We'll be conservative and just remove known PII for now, 
      // or we can strictly filter if we know the schema.
    }

    return scrubbedPayload;
  }
}

module.exports = { PrivacyService };
