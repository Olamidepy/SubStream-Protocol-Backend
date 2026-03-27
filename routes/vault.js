const express = require('express');
const router = express.Router();
const { SorobanVaultManager } = require('../services/sorobanVaultManager');
const { loadConfig } = require('../config');

const config = loadConfig();
const vaultManager = new SorobanVaultManager(config);

/**
 * Get current contract code hash
 * GET /vault/code-hash
 */
router.get('/code-hash', async (req, res) => {
  try {
    const codeHash = await vaultManager.getCurrentCodeHash();
    
    res.json({
      success: true,
      data: {
        contractId: config.soroban.contractId,
        codeHash,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching code hash:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch code hash',
    });
  }
});

/**
 * Get immutable terms from the contract
 * GET /vault/immutable-terms
 */
router.get('/immutable-terms', async (req, res) => {
  try {
    const terms = await vaultManager.getImmutableTerms();
    
    res.json({
      success: true,
      data: {
        contractId: config.soroban.contractId,
        terms,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching immutable terms:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch immutable terms',
    });
  }
});

/**
 * Upgrade contract logic to new Wasm code
 * POST /vault/upgrade
 */
router.post('/upgrade', async (req, res) => {
  try {
    const { newCodeHash, adminPublicKey, adminSignature } = req.body;

    if (!newCodeHash || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: newCodeHash, adminPublicKey, adminSignature',
      });
    }

    const result = await vaultManager.upgradeContractLogic(
      newCodeHash,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Contract logic upgraded successfully',
    });
  } catch (error) {
    console.error('Contract upgrade failed:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to upgrade contract logic',
    });
  }
});

/**
 * Validate new code compatibility
 * POST /vault/validate-code
 */
router.post('/validate-code', async (req, res) => {
  try {
    const { codeHash } = req.body;

    if (!codeHash) {
      return res.status(400).json({
        success: false,
        error: 'codeHash is required',
      });
    }

    const terms = await vaultManager.validateNewCodeCompatibility(codeHash);
    
    res.json({
      success: true,
      data: {
        codeHash,
        terms,
        compatible: true,
      },
      message: 'Code validation successful',
    });
  } catch (error) {
    console.error('Code validation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to validate code',
    });
  }
});

module.exports = router;
