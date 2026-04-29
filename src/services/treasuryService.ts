import { logger } from '../utils/logger';
import { merchantService } from './merchantService';
import { priceCacheService } from './priceCacheService';
import { ConsolidatedTreasury, AssetBreakdown } from '../models/merchant';

export class TreasuryService {
  async getConsolidatedTreasury(merchantId: string): Promise<ConsolidatedTreasury | null> {
    try {
      // Get merchant details
      const merchant = await merchantService.getMerchantById(merchantId);
      if (!merchant) {
        logger.error(`Merchant not found: ${merchantId}`);
        return null;
      }

      // Get merchant balances
      const balances = await merchantService.getMerchantBalances(merchantId);
      if (balances.length === 0) {
        logger.warn(`No balances found for merchant: ${merchantId}`);
        return this.createEmptyTreasury(merchantId, merchant.baseCurrency);
      }

      // Convert each balance to base currency and USD
      const assetBreakdown: AssetBreakdown[] = [];
      let totalValueInBaseCurrency = 0;
      let totalValueInUsd = 0;

      for (const balance of balances) {
        const valueInBaseCurrency = await priceCacheService.convertAmount(
          balance.balance,
          balance.assetCode,
          merchant.baseCurrency
        );

        const valueInUsd = await priceCacheService.convertAmount(
          balance.balance,
          balance.assetCode,
          'USD'
        );

        if (valueInBaseCurrency === null || valueInUsd === null) {
          logger.warn(`Cannot convert ${balance.assetCode} balance for merchant ${merchantId}`);
          continue;
        }

        const currentPrice = await priceCacheService.getPrice(balance.assetCode, 'USD');
        const priceChange24h = currentPrice 
          ? await priceCacheService.get24HourPriceChange(balance.assetCode, 'USD')
          : null;

        const breakdown: AssetBreakdown = {
          assetCode: balance.assetCode,
          assetIssuer: balance.assetIssuer,
          balance: balance.balance,
          valueInBaseCurrency: valueInBaseCurrency.toFixed(6),
          valueInUsd: valueInUsd.toFixed(6),
          percentageOfTotal: 0, // Will calculate after total is known
          currentPrice: currentPrice?.price || '0',
          priceChange24h: priceChange24h || undefined
        };

        assetBreakdown.push(breakdown);
        totalValueInBaseCurrency += valueInBaseCurrency;
        totalValueInUsd += valueInUsd;
      }

      // Calculate percentages
      assetBreakdown.forEach(asset => {
        asset.percentageOfTotal = totalValueInUsd > 0 
          ? (parseFloat(asset.valueInUsd) / totalValueInUsd) * 100 
          : 0;
      });

      // Sort by value descending
      assetBreakdown.sort((a, b) => parseFloat(b.valueInUsd) - parseFloat(a.valueInUsd));

      // Calculate 24h delta
      const delta24h = await this.calculate24hDelta(merchantId, totalValueInUsd);

      const consolidatedTreasury: ConsolidatedTreasury = {
        merchantId,
        baseCurrency: merchant.baseCurrency,
        totalValueLocked: totalValueInBaseCurrency.toFixed(6),
        totalValueLockedUsd: totalValueInUsd.toFixed(6),
        delta24h,
        assetBreakdown,
        lastUpdated: new Date()
      };

      // Save snapshot for historical tracking
      await merchantService.saveTreasurySnapshot(
        merchantId,
        totalValueInUsd.toFixed(6),
        assetBreakdown
      );

      return consolidatedTreasury;
    } catch (error) {
      logger.error('Error calculating consolidated treasury', { merchantId, error });
      return null;
    }
  }

  private async calculate24hDelta(
    merchantId: string,
    currentValue: number
  ): Promise<{ absolute: string; percentage: string }> {
    try {
      const historicalValues = await merchantService.getHistoricalTreasuryValue(merchantId, 24);
      
      if (historicalValues.length === 0) {
        return { absolute: '0', percentage: '0' };
      }

      const oldestValue = historicalValues[0].totalValue;
      const absoluteChange = currentValue - oldestValue;
      const percentageChange = oldestValue > 0 ? (absoluteChange / oldestValue) * 100 : 0;

      return {
        absolute: absoluteChange.toFixed(6),
        percentage: percentageChange.toFixed(4)
      };
    } catch (error) {
      logger.error('Error calculating 24h delta', { merchantId, error });
      return { absolute: '0', percentage: '0' };
    }
  }

  private createEmptyTreasury(merchantId: string, baseCurrency: string): ConsolidatedTreasury {
    return {
      merchantId,
      baseCurrency,
      totalValueLocked: '0',
      totalValueLockedUsd: '0',
      delta24h: { absolute: '0', percentage: '0' },
      assetBreakdown: [],
      lastUpdated: new Date()
    };
  }

  async getTreasuryHistory(
    merchantId: string,
    days: number = 30
  ): Promise<{ timestamp: Date; totalValueUsd: string }[]> {
    try {
      const historicalValues = await merchantService.getHistoricalTreasuryValue(merchantId, days * 24);
      
      return historicalValues.map(value => ({
        timestamp: value.timestamp,
        totalValueUsd: value.totalValue.toFixed(6)
      }));
    } catch (error) {
      logger.error('Error fetching treasury history', { merchantId, days, error });
      return [];
    }
  }
}

export const treasuryService = new TreasuryService();
