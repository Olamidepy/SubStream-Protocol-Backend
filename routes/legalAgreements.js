const express = require('express');
const router = express.Router();
const { LegalAgreementService } = require('../services/legalAgreementService');
const { loadConfig } = require('../config');

const config = loadConfig();
const agreementService = new LegalAgreementService(config);

router.post('/store', async (req, res) => {
  try {
    const { vaultId, agreements, adminPublicKey, adminSignature } = req.body;

    if (!vaultId || !agreements || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vaultId, agreements, adminPublicKey, adminSignature',
      });
    }

    if (!Array.isArray(agreements)) {
      return res.status(400).json({
        success: false,
        error: 'agreements must be an array',
      });
    }

    const result = await agreementService.storeAgreementHashes(
      vaultId,
      agreements,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Agreement hashes stored successfully',
    });
  } catch (error) {
    console.error('Failed to store agreements:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to store agreements',
    });
  }
});

router.get('/:vaultId', async (req, res) => {
  try {
    const { vaultId } = req.params;
    
    if (!vaultId) {
      return res.status(400).json({
        success: false,
        error: 'vaultId is required',
      });
    }

    const agreements = await agreementService.getAgreementHashes(vaultId);
    
    res.json({
      success: true,
      data: {
        vaultId,
        agreements,
        count: agreements.length,
      },
    });
  } catch (error) {
    console.error('Error fetching agreements:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch agreements',
    });
  }
});

router.get('/:vaultId/primary/:language', async (req, res) => {
  try {
    const { vaultId, language } = req.params;
    
    if (!vaultId || !language) {
      return res.status(400).json({
        success: false,
        error: 'vaultId and language are required',
      });
    }

    const agreement = await agreementService.getPrimaryAgreementByLanguage(vaultId, language);
    
    res.json({
      success: true,
      data: agreement,
    });
  } catch (error) {
    console.error('Error fetching primary agreement:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch primary agreement',
    });
  }
});

router.post('/:vaultId/update-primary/:language', async (req, res) => {
  try {
    const { vaultId, language } = req.params;
    const { newHash, adminPublicKey, adminSignature } = req.body;

    if (!vaultId || !language || !newHash || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vaultId, language, newHash, adminPublicKey, adminSignature',
      });
    }

    const result = await agreementService.updatePrimaryAgreement(
      vaultId,
      language,
      newHash,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Primary agreement updated successfully',
    });
  } catch (error) {
    console.error('Failed to update primary agreement:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update primary agreement',
    });
  }
});

router.post('/:vaultId/verify', async (req, res) => {
  try {
    const { vaultId } = req.params;
    const { language, hash } = req.body;

    if (!vaultId || !language || !hash) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vaultId, language, hash',
      });
    }

    const isValid = await agreementService.verifyAgreementHash(vaultId, language, hash);
    
    res.json({
      success: true,
      data: {
        vaultId,
        language,
        providedHash: hash,
        isValid,
      },
      message: isValid ? 'Hash verified' : 'Hash mismatch',
    });
  } catch (error) {
    console.error('Verification failed:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to verify hash',
    });
  }
});

router.get('/:vaultId/history', async (req, res) => {
  try {
    const { vaultId } = req.params;
    
    if (!vaultId) {
      return res.status(400).json({
        success: false,
        error: 'vaultId is required',
      });
    }

    const history = await agreementService.getAgreementHistory(vaultId);
    
    res.json({
      success: true,
      data: {
        vaultId,
        history,
      },
    });
  } catch (error) {
    console.error('Error fetching history:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch history',
    });
  }
});

module.exports = router;
