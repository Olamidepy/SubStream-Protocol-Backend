const axios = require('axios');

/**
 * Service for fetching and caching multi-currency price data.
 * Aggregates data from CoinGecko for crypto-to-fiat conversion.
 */
class PriceService {
  constructor(options = {}) {
    this.cache = new Map();
    this.cacheTtl = options.cacheTtl || 60000; // 1 minute default
    this.redis = options.redis || null;
    this.redisKey = 'substream:price_feed';
  }

  /**
   * Get current price for Stellar (XLM) and other tokens in fiat.
   * 
   * @param {string} base - Base currency (default: 'stellar')
   * @param {string[]} currencies - Target fiat/crypto currencies (default: ['usd', 'eur', 'usdc'])
   * @returns {Promise<object>}
   */
  async getLatestPrices(base = 'stellar', currencies = ['usd', 'eur', 'usdc']) {
    const cacheKey = `${base}:${currencies.join(',')}`;
    
    // 1. Try In-memory cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.data;
    }

    // 2. Try Redis cache if available
    if (this.redis) {
      try {
        const val = await this.redis.get(`${this.redisKey}:${cacheKey}`);
        if (val) {
          return JSON.parse(val);
        }
      } catch (error) {
        console.warn('Redis price cache error:', error.message);
      }
    }

    // 3. Fetch from CoinGecko
    try {
      const ids = {
        'stellar': 'stellar',
        'usdc': 'usd-coin',
      };
      
      const cgId = ids[base.toLowerCase()] || base.toLowerCase();
      const vsCurrencies = currencies.join(',');
      
      const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
        params: {
          ids: cgId,
          vs_currencies: vsCurrencies,
          include_last_updated_at: true
        }
      });

      const data = response.data[cgId];
      if (!data) {
        throw new Error(`Price data not found for ${base}`);
      }

      // Format response to be consistent
      const result = {
        base: base.toUpperCase(),
        rates: {},
        lastUpdated: new Date(data.last_updated_at * 1000).toISOString()
      };

      currencies.forEach(curr => {
        if (data[curr.toLowerCase()]) {
          result.rates[curr.toUpperCase()] = data[curr.toLowerCase()];
        }
      });

      // Update caches
      this.cache.set(cacheKey, { timestamp: Date.now(), data: result });
      if (this.redis) {
        await this.redis.set(`${this.redisKey}:${cacheKey}`, JSON.stringify(result), 'PX', this.cacheTtl);
      }

      return result;
    } catch (error) {
      console.error('Failed to fetch price feed:', error.message);
      
      // Return stale data if available as fallback
      if (cached) return cached.data;
      
      throw new Error(`Failed to fetch current conversion rates: ${error.message}`);
    }
  }

  /**
   * Convert an amount from one currency to another.
   * 
   * @param {number} amount
   * @param {string} from - Source currency (e.g., 'XLM')
   * @param {string} to - Target currency (e.g., 'USD')
   */
  async convert(amount, from = 'XLM', to = 'USD') {
    const prices = await this.getLatestPrices('stellar', ['usd']);
    
    if (from.toUpperCase() === 'XLM' && to.toUpperCase() === 'USD') {
      return amount * prices.rates.USD;
    }
    
    // Extendable for more pairs
    throw new Error(`Conversion from ${from} to ${to} not yet implemented`);
  }
}

module.exports = { PriceService };
