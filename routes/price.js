const express = require('express');
const { PriceService } = require('../src/services/priceService');
const { getRedisClient } = require('../src/config/redis');

/**
 * Multi-Currency Price Feed Router (XLM/USDC/Fiat)
 * Injected for the creator dashboard to display estimated USD earnings.
 */
function createPriceRouter() {
  const router = express.Router();
  const redis = (process.env.REDIS_URL || process.env.REDIS_HOST) ? getRedisClient() : null;
  const priceService = new PriceService({ redis });

  /**
   * GET /api/price-feed
   * Returns conversion rates for configured currencies.
   */
  router.get('/feed', async (req, res) => {
    try {
      const base = req.query.base || 'stellar';
      const targets = (req.query.targets || 'usd,eur,usdc').split(',');
      
      const prices = await priceService.getLatestPrices(base, targets);
      
      return res.status(200).json({
        success: true,
        data: prices
      });
    } catch (error) {
      console.error('Price feed error:', error.message);
      return res.status(503).json({
        success: false,
        error: error.message || 'Price service temporarily unavailable'
      });
    }
  });

  /**
   * GET /api/price-feed/convert
   * Performs conversion between currencies for a given amount.
   */
  router.get('/convert', async (req, res) => {
    try {
      const { amount, from, to } = req.query;
      
      if (!amount || isNaN(Number(amount))) {
        return res.status(400).json({ success: false, error: 'Valid amount is required' });
      }

      const conversion = await priceService.convert(
        Number(amount), 
        from || 'XLM', 
        to || 'USD'
      );
      
      return res.status(200).json({
        success: true,
        data: {
          original: Number(amount),
          from: (from || 'XLM').toUpperCase(),
          to: (to || 'USD').toUpperCase(),
          result: conversion,
          currencySymbol: '$' // Mock for USD
        }
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createPriceRouter;
