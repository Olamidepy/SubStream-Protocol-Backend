const axios = require('axios');

class TaxService {
  constructor() {
    this.stellarApiUrl = 'https://horizon.stellar.org';
    this.priceApiUrl = 'https://api.coingecko.com/api/v3';
  }

  async generateTaxReport(creatorAddress, year) {
    try {
      const withdrawals = await this.getWithdrawalsForYear(creatorAddress, year);
      const reportData = await this.processWithdrawals(withdrawals, year);
      
      return {
        creatorAddress,
        year,
        reportData,
        summary: this.calculateSummary(reportData),
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error generating tax report:', error);
      throw new Error('Failed to generate tax report');
    }
  }

  async getWithdrawalsForYear(creatorAddress, year) {
    try {
      const startDate = new Date(year, 0, 1).toISOString();
      const endDate = new Date(year, 11, 31, 23, 59, 59).toISOString();
      
      // Get all transactions for the creator's address
      const transactions = await this.getStellarTransactions(creatorAddress, startDate, endDate);
      
      // Filter for withdrawal events (payments TO the creator)
      const withdrawals = transactions.filter(tx => 
        tx.type === 'payment' && 
        tx.to === creatorAddress &&
        tx.amount > 0
      );

      return withdrawals.map(tx => ({
        transactionId: tx.id,
        timestamp: tx.created_at,
        amount: tx.amount,
        asset: tx.asset_code || 'XLM',
        assetIssuer: tx.asset_issuer,
        fromAddress: tx.from,
        toAddress: tx.to,
        memo: tx.memo,
        stellarUrl: `https://stellar.expert/explorer/testnet/tx/${tx.id}`
      }));
    } catch (error) {
      console.error('Error fetching withdrawals:', error);
      throw new Error('Failed to fetch withdrawal data');
    }
  }

  async getStellarTransactions(address, startDate, endDate) {
    try {
      const response = await axios.get(`${this.stellarApiUrl}/accounts/${address}/payments`, {
        params: {
          limit: 200,
          order: 'desc'
        }
      });

      let allTransactions = response.data._embedded.records;
      
      // Filter by date range
      allTransactions = allTransactions.filter(tx => {
        const txDate = new Date(tx.created_at);
        return txDate >= new Date(startDate) && txDate <= new Date(endDate);
      });

      // Handle pagination if needed
      while (response.data._links.next && allTransactions.length < response.data._embedded.records.length) {
        const nextUrl = response.data._links.next.href;
        const nextPageResponse = await axios.get(nextUrl);
        const nextPageTransactions = nextPageResponse.data._embedded.records.filter(tx => {
          const txDate = new Date(tx.created_at);
          return txDate >= new Date(startDate) && txDate <= new Date(endDate);
        });
        allTransactions = allTransactions.concat(nextPageTransactions);
      }

      return allTransactions;
    } catch (error) {
      console.error('Error fetching Stellar transactions:', error);
      throw new Error('Failed to fetch Stellar transactions');
    }
  }

  async processWithdrawals(withdrawals, year) {
    const processedData = [];

    for (const withdrawal of withdrawals) {
      try {
        const fmvData = await this.getFairMarketValue(withdrawal.timestamp, withdrawal.asset);
        const platformFee = this.calculatePlatformFee(withdrawal.amount);
        const netAmount = withdrawal.amount - platformFee;

        processedData.push({
          ...withdrawal,
          fairMarketValueUSD: fmvData.price,
          totalValueUSD: withdrawal.amount * fmvData.price,
          platformFee: platformFee,
          platformFeeUSD: platformFee * fmvData.price,
          netAmount: netAmount,
          netValueUSD: netAmount * fmvData.price,
          priceSource: fmvData.source,
          priceTimestamp: fmvData.timestamp
        });
      } catch (error) {
        console.error(`Error processing withdrawal ${withdrawal.transactionId}:`, error);
        // Add with error flag
        processedData.push({
          ...withdrawal,
          error: 'Failed to fetch FMV data'
        });
      }
    }

    return processedData;
  }

  async getFairMarketValue(timestamp, asset) {
    try {
      const date = new Date(timestamp);
      const dateString = date.toISOString().split('T')[0];

      if (asset === 'XLM') {
        return await this.getXLMPrice(dateString);
      } else if (asset === 'USDC') {
        return await this.getUSDCPrice(dateString);
      } else {
        // For other assets, try to get price from CoinGecko
        return await this.getGenericAssetPrice(asset, dateString);
      }
    } catch (error) {
      console.error(`Error fetching FMV for ${asset} at ${timestamp}:`, error);
      throw error;
    }
  }

  async getXLMPrice(dateString) {
    try {
      const response = await axios.get(`${this.priceApiUrl}/coins/stellar/history`, {
        params: {
          date: dateString,
          localization: false
        }
      });

      return {
        price: response.data.market_data.current_price.usd,
        source: 'CoinGecko',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // Fallback to current price if historical data not available
      console.warn('Historical XLM price not available, using current price');
      return await this.getCurrentXLMPrice();
    }
  }

  async getUSDCPrice(dateString) {
    // USDC is a stablecoin, so price should be ~$1
    return {
      price: 1.00,
      source: 'USDC Stablecoin',
      timestamp: new Date().toISOString()
    };
  }

  async getGenericAssetPrice(asset, dateString) {
    try {
      // Try to find the asset on CoinGecko
      const searchResponse = await axios.get(`${this.priceApiUrl}/search`, {
        params: {
          query: asset.toLowerCase()
        }
      });

      if (searchResponse.data.coins.length > 0) {
        const coinId = searchResponse.data.coins[0].id;
        const response = await axios.get(`${this.priceApiUrl}/coins/${coinId}/history`, {
          params: {
            date: dateString,
            localization: false
          }
        });

        return {
          price: response.data.market_data.current_price.usd,
          source: 'CoinGecko',
          timestamp: new Date().toISOString()
        };
      } else {
        throw new Error(`Asset ${asset} not found on CoinGecko`);
      }
    } catch (error) {
      console.error(`Error fetching price for ${asset}:`, error);
      throw error;
    }
  }

  async getCurrentXLMPrice() {
    try {
      const response = await axios.get(`${this.priceApiUrl}/simple/price`, {
        params: {
          ids: 'stellar',
          vs_currencies: 'usd'
        }
      });

      return {
        price: response.data.stellar.usd,
        source: 'CoinGecko (Current)',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching current XLM price:', error);
      throw error;
    }
  }

  calculatePlatformFee(amount) {
    // Platform fee structure (example: 5%)
    const platformFeeRate = 0.05;
    return amount * platformFeeRate;
  }

  calculateSummary(reportData) {
    const validData = reportData.filter(item => !item.error);
    
    const totalIncome = validData.reduce((sum, item) => sum + item.totalValueUSD, 0);
    const totalPlatformFees = validData.reduce((sum, item) => sum + item.platformFeeUSD, 0);
    const totalNetIncome = validData.reduce((sum, item) => sum + item.netValueUSD, 0);
    
    const assetBreakdown = {};
    validData.forEach(item => {
      if (!assetBreakdown[item.asset]) {
        assetBreakdown[item.asset] = {
          amount: 0,
          valueUSD: 0,
          transactions: 0
        };
      }
      assetBreakdown[item.asset].amount += item.amount;
      assetBreakdown[item.asset].valueUSD += item.totalValueUSD;
      assetBreakdown[item.asset].transactions += 1;
    });

    return {
      totalIncome,
      totalPlatformFees,
      totalNetIncome,
      totalTransactions: validData.length,
      assetBreakdown,
      averageTransactionValue: totalIncome / validData.length || 0
    };
  }

  generateCSV(reportData) {
    const headers = [
      'Transaction ID',
      'Date',
      'Asset',
      'Amount',
      'From Address',
      'To Address',
      'Fair Market Value (USD)',
      'Total Value (USD)',
      'Platform Fee',
      'Platform Fee (USD)',
      'Net Amount',
      'Net Value (USD)',
      'Price Source',
      'Stellar URL',
      'Memo'
    ];

    const csvRows = [headers.join(',')];

    reportData.forEach(item => {
      if (item.error) {
        csvRows.push([
          item.transactionId,
          item.timestamp,
          item.asset,
          item.amount,
          item.fromAddress,
          item.toAddress,
          'ERROR',
          'ERROR',
          'ERROR',
          'ERROR',
          'ERROR',
          'ERROR',
          item.error,
          item.stellarUrl,
          item.memo || ''
        ].map(field => `"${field}"`).join(','));
      } else {
        csvRows.push([
          item.transactionId,
          item.timestamp,
          item.asset,
          item.amount,
          item.fromAddress,
          item.toAddress,
          item.fairMarketValueUSD.toFixed(6),
          item.totalValueUSD.toFixed(2),
          item.platformFee.toFixed(6),
          item.platformFeeUSD.toFixed(2),
          item.netAmount.toFixed(6),
          item.netValueUSD.toFixed(2),
          item.priceSource,
          item.stellarUrl,
          item.memo || ''
        ].map(field => `"${field}"`).join(','));
      }
    });

    return csvRows.join('\n');
  }

  async generateTaxCSV(creatorAddress, year) {
    try {
      const report = await this.generateTaxReport(creatorAddress, year);
      const csvData = this.generateCSV(report.reportData);
      
      return {
        csvData,
        filename: `substream-tax-report-${year}-${creatorAddress.slice(0, 8)}.csv`,
        summary: report.summary,
        generatedAt: report.generatedAt
      };
    } catch (error) {
      console.error('Error generating tax CSV:', error);
      throw new Error('Failed to generate tax CSV');
    }
  }
}

module.exports = new TaxService();
