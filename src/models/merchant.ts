export interface Merchant {
  id: string;
  name: string;
  baseCurrency: string; // e.g., 'USD', 'EUR', 'GBP'
  createdAt: Date;
  updatedAt: Date;
}

export interface MerchantBalance {
  id: string;
  merchantId: string;
  assetCode: string; // e.g., 'XLM', 'USDC', 'EURC'
  assetIssuer?: string;
  balance: string;
  lastUpdated: Date;
}

export interface PriceCache {
  id: string;
  baseAsset: string; // e.g., 'XLM'
  quoteAsset: string; // e.g., 'USD'
  price: string;
  timestamp: Date;
  source: string; // e.g., 'stellar', 'coinbase', 'binance'
}

export interface ConsolidatedTreasury {
  merchantId: string;
  baseCurrency: string;
  totalValueLocked: string;
  totalValueLockedUsd: string;
  delta24h: {
    absolute: string;
    percentage: string;
  };
  assetBreakdown: AssetBreakdown[];
  lastUpdated: Date;
}

export interface AssetBreakdown {
  assetCode: string;
  assetIssuer?: string;
  balance: string;
  valueInBaseCurrency: string;
  valueInUsd: string;
  percentageOfTotal: number;
  currentPrice: string;
  priceChange24h?: number;
}
