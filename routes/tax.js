const express = require('express');
const router = express.Router();
const taxService = require('../services/taxService');

// Generate tax report for a creator
router.get('/report/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    
    if (!creatorAddress || !year) {
      return res.status(400).json({
        success: false,
        error: 'Creator address and year are required'
      });
    }

    const report = await taxService.generateTaxReport(creatorAddress, parseInt(year));
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    console.error('Error generating tax report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate tax report'
    });
  }
});

// Download tax report as CSV
router.get('/csv/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    
    if (!creatorAddress || !year) {
      return res.status(400).json({
        success: false,
        error: 'Creator address and year are required'
      });
    }

    const csvReport = await taxService.generateTaxCSV(creatorAddress, parseInt(year));
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${csvReport.filename}"`);
    res.send(csvReport.csvData);
  } catch (error) {
    console.error('Error generating tax CSV:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate tax CSV'
    });
  }
});

// Get tax summary for a creator
router.get('/summary/:creatorAddress/:year', async (req, res) => {
  try {
    const { creatorAddress, year } = req.params;
    
    if (!creatorAddress || !year) {
      return res.status(400).json({
        success: false,
        error: 'Creator address and year are required'
      });
    }

    const report = await taxService.generateTaxReport(creatorAddress, parseInt(year));
    
    res.json({
      success: true,
      data: {
        creatorAddress,
        year,
        summary: report.summary,
        generatedAt: report.generatedAt
      }
    });
  } catch (error) {
    console.error('Error generating tax summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate tax summary'
    });
  }
});

// Get available years for tax reports
router.get('/years/:creatorAddress', async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    
    if (!creatorAddress) {
      return res.status(400).json({
        success: false,
        error: 'Creator address is required'
      });
    }

    // Get the first transaction date to determine available years
    const currentYear = new Date().getFullYear();
    const years = [];
    
    // For now, return the last 5 years or since 2020 (whichever is more recent)
    const startYear = Math.max(2020, currentYear - 5);
    
    for (let year = startYear; year <= currentYear; year++) {
      years.push(year);
    }
    
    res.json({
      success: true,
      data: {
        creatorAddress,
        availableYears: years,
        currentYear
      }
    });
  } catch (error) {
    console.error('Error fetching available years:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available years'
    });
  }
});

// Get fair market value for a specific asset at a specific time
router.get('/fmv/:asset/:timestamp', async (req, res) => {
  try {
    const { asset, timestamp } = req.params;
    
    if (!asset || !timestamp) {
      return res.status(400).json({
        success: false,
        error: 'Asset and timestamp are required'
      });
    }

    const fmvData = await taxService.getFairMarketValue(timestamp, asset.toUpperCase());
    
    res.json({
      success: true,
      data: fmvData
    });
  } catch (error) {
    console.error('Error fetching fair market value:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fair market value'
    });
  }
});

module.exports = router;
