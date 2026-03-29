const express = require('express');
const router = express.Router();
const { VaultRegistryService } = require('../services/vaultRegistryService');
const { loadConfig } = require('../config');

const config = loadConfig();
const registryService = new VaultRegistryService(config);

router.get('/vaults/:creatorAddress', async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    
    if (!creatorAddress) {
      return res.status(400).json({
        success: false,
        error: 'creatorAddress is required',
      });
    }

    const vaults = await registryService.listVaultsByCreator(creatorAddress);
    
    res.json({
      success: true,
      data: {
        creatorAddress,
        vaults,
        count: vaults.length,
      },
    });
  } catch (error) {
    console.error('Error listing vaults:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list vaults',
    });
  }
});

router.get('/all-vaults', async (req, res) => {
  try {
    const allVaults = await registryService.getAllVaults();
    
    const totalCreators = Object.keys(allVaults).length;
    const totalVaults = Object.values(allVaults).reduce((sum, vaults) => sum + vaults.length, 0);
    
    res.json({
      success: true,
      data: {
        vaultsByCreator: allVaults,
        statistics: {
          totalCreators,
          totalVaults,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching all vaults:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch all vaults',
    });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { creatorAddress, vaultContractId, adminPublicKey, adminSignature } = req.body;

    if (!creatorAddress || !vaultContractId || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: creatorAddress, vaultContractId, adminPublicKey, adminSignature',
      });
    }

    const result = await registryService.registerVault(
      creatorAddress,
      vaultContractId,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Vault registered successfully',
    });
  } catch (error) {
    console.error('Vault registration failed:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to register vault',
    });
  }
});

router.post('/unregister', async (req, res) => {
  try {
    const { creatorAddress, vaultContractId, adminPublicKey, adminSignature } = req.body;

    if (!creatorAddress || !vaultContractId || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: creatorAddress, vaultContractId, adminPublicKey, adminSignature',
      });
    }

    const result = await registryService.unregisterVault(
      creatorAddress,
      vaultContractId,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Vault unregistered successfully',
    });
  } catch (error) {
    console.error('Vault unregistration failed:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to unregister vault',
    });
  }
});

router.get('/check/:vaultContractId', async (req, res) => {
  try {
    const { vaultContractId } = req.params;
    
    if (!vaultContractId) {
      return res.status(400).json({
        success: false,
        error: 'vaultContractId is required',
      });
    }

    const isRegistered = await registryService.isVaultRegistered(vaultContractId);
    
    res.json({
      success: true,
      data: {
        vaultContractId,
        isRegistered,
      },
    });
  } catch (error) {
    console.error('Error checking vault:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check vault',
    });
  }
});

module.exports = router;
