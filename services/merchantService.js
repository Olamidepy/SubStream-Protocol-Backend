const knex = require('../knexfile');
const logger = require('./loggerService');

class MerchantService {
  constructor() {
    this.db = knex;
  }

  async getMerchantById(id) {
    try {
      const merchant = await this.db('merchants').where({ id }).first();
      
      if (!merchant) {
        logger.warn(`Merchant not found: ${id}`);
        return null;
      }

      return {
        id: merchant.id,
        name: merchant.name,
        baseCurrency: merchant.base_currency,
        createdAt: merchant.created_at,
        updatedAt: merchant.updated_at
      };
    } catch (error) {
      logger.error('Error fetching merchant', { id, error });
      return null;
    }
  }

  async getMerchantBalances(merchantId) {
    try {
      const balances = await this.db('merchant_balances')
        .where({ merchant_id: merchantId })
        .orderBy('asset_code');

      return balances.map(balance => ({
        id: balance.id,
        merchantId: balance.merchant_id,
        assetCode: balance.asset_code,
        assetIssuer: balance.asset_issuer,
        balance: balance.balance,
        lastUpdated: balance.last_updated
      }));
    } catch (error) {
      logger.error('Error fetching merchant balances', { merchantId, error });
      return [];
    }
  }

  async createMerchant(merchantData) {
    try {
      const [id] = await this.db('merchants').insert({
        name: merchantData.name,
        base_currency: merchantData.baseCurrency,
        created_at: new Date(),
        updated_at: new Date()
      }).returning('id');

      logger.info(`Merchant created: ${id}`);
      return id;
    } catch (error) {
      logger.error('Error creating merchant', { merchantData, error });
      throw error;
    }
  }

  async updateMerchantBalance(merchantId, assetCode, newBalance, assetIssuer) {
    try {
      await this.db('merchant_balances')
        .insert({
          merchant_id: merchantId,
          asset_code: assetCode,
          asset_issuer: assetIssuer,
          balance: newBalance,
          last_updated: new Date()
        })
        .onConflict(['merchant_id', 'asset_code'])
        .merge({
          balance: newBalance,
          last_updated: new Date()
        });

      logger.info(`Balance updated for merchant ${merchantId}: ${assetCode} = ${newBalance}`);
    } catch (error) {
      logger.error('Error updating merchant balance', { merchantId, assetCode, newBalance, error });
      throw error;
    }
  }

  async getHistoricalTreasuryValue(merchantId, hoursAgo = 24) {
    try {
      const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      
      const historicalValues = await this.db('treasury_snapshots')
        .where({ merchant_id: merchantId })
        .where('timestamp', '>=', cutoffTime)
        .orderBy('timestamp', 'asc');

      return historicalValues.map(snapshot => ({
        timestamp: snapshot.timestamp,
        totalValue: parseFloat(snapshot.total_value_usd)
      }));
    } catch (error) {
      logger.error('Error fetching historical treasury values', { merchantId, hoursAgo, error });
      return [];
    }
  }

  async saveTreasurySnapshot(merchantId, totalValueUsd, assetBreakdown) {
    try {
      await this.db('treasury_snapshots').insert({
        merchant_id: merchantId,
        total_value_usd: totalValueUsd,
        asset_breakdown: JSON.stringify(assetBreakdown),
        timestamp: new Date()
      });

      logger.debug(`Treasury snapshot saved for merchant ${merchantId}: $${totalValueUsd}`);
    } catch (error) {
      logger.error('Error saving treasury snapshot', { merchantId, totalValueUsd, error });
      // Don't throw error here as this is non-critical
    }
  }
}

module.exports = new MerchantService();
