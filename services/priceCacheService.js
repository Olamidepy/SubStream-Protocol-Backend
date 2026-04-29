const knex = require('../knexfile');
const logger = require('./loggerService');

class PriceCacheService {
  constructor() {
    this.db = knex;
  }

  async getPrice(baseAsset, quoteAsset) {
    try {
      const price = await this.db('price_cache')
        .where({ base_asset: baseAsset, quote_asset: quoteAsset })
        .orderBy('timestamp', 'desc')
        .first();

      if (!price) {
        logger.warn(`Price not found for ${baseAsset}/${quoteAsset}`);
        return null;
      }

      // Check if price is fresh (within 5 minutes as per requirements)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (new Date(price.timestamp) < fiveMinutesAgo) {
        logger.warn(`Stale price data for ${baseAsset}/${quoteAsset}: ${price.timestamp}`);
        return null;
      }

      return {
        id: price.id,
        baseAsset: price.base_asset,
        quoteAsset: price.quote_asset,
        price: price.price,
        timestamp: price.timestamp,
        source: price.source
      };
    } catch (error) {
      logger.error('Error fetching price from cache', { baseAsset, quoteAsset, error });
      return null;
    }
  }

  async cachePrice(priceData) {
    try {
      await this.db('price_cache').insert({
        base_asset: priceData.baseAsset,
        quote_asset: priceData.quoteAsset,
        price: priceData.price,
        source: priceData.source,
        timestamp: new Date()
      });

      logger.info(`Price cached: ${priceData.baseAsset}/${priceData.quoteAsset} = ${priceData.price}`);
    } catch (error) {
      logger.error('Error caching price', { priceData, error });
      throw error;
    }
  }

  async convertAmount(amount, fromAsset, toAsset) {
    // If same asset, return amount as number
    if (fromAsset === toAsset) {
      return parseFloat(amount);
    }

    // Try direct conversion (e.g., XLM -> USD)
    const directPrice = await this.getPrice(fromAsset, toAsset);
    if (directPrice) {
      return parseFloat(amount) * parseFloat(directPrice.price);
    }

    // Try USD as intermediate (e.g., XLM -> USD -> EUR)
    if (fromAsset !== 'USD' && toAsset !== 'USD') {
      const fromToUsd = await this.getPrice(fromAsset, 'USD');
      const usdToTo = await this.getPrice('USD', toAsset);
      
      if (fromToUsd && usdToTo) {
        return parseFloat(amount) * parseFloat(fromToUsd.price) * parseFloat(usdToTo.price);
      }
    }

    logger.error(`Cannot convert ${amount} ${fromAsset} to ${toAsset}: no price path found`);
    return null;
  }

  async getHistoricalPrices(baseAsset, quoteAsset, hoursAgo = 24) {
    try {
      const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      
      const prices = await this.db('price_cache')
        .where({ base_asset: baseAsset, quote_asset: quoteAsset })
        .where('timestamp', '>=', cutoffTime)
        .orderBy('timestamp', 'asc');

      return prices.map(p => ({
        id: p.id,
        baseAsset: p.base_asset,
        quoteAsset: p.quote_asset,
        price: p.price,
        timestamp: p.timestamp,
        source: p.source
      }));
    } catch (error) {
      logger.error('Error fetching historical prices', { baseAsset, quoteAsset, hoursAgo, error });
      return [];
    }
  }

  async get24HourPriceChange(baseAsset, quoteAsset) {
    try {
      const currentPrice = await this.getPrice(baseAsset, quoteAsset);
      if (!currentPrice) return null;

      const historicalPrices = await this.getHistoricalPrices(baseAsset, quoteAsset, 24);
      if (historicalPrices.length === 0) return null;

      const oldestPrice = historicalPrices[0];
      const currentPriceValue = parseFloat(currentPrice.price);
      const oldestPriceValue = parseFloat(oldestPrice.price);

      const percentageChange = ((currentPriceValue - oldestPriceValue) / oldestPriceValue) * 100;
      return parseFloat(percentageChange.toFixed(4));
    } catch (error) {
      logger.error('Error calculating 24h price change', { baseAsset, quoteAsset, error });
      return null;
    }
  }
}

module.exports = new PriceCacheService();
