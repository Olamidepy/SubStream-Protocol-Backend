const express = require('express');
const { SubdomainService } = require('../services/subdomainService');

/**
 * Create subdomain management routes.
 * @param {object} dependencies Service dependencies
 * @returns {express.Router} Express router
 */
function createSubdomainRoutes(dependencies = {}) {
  const router = express.Router();
  const database = dependencies.database;
  const config = dependencies.config;
  const subdomainService = dependencies.subdomainService || new SubdomainService(database, config);

  /**
   * GET /api/subdomains/available/:subdomain
   * Check if a subdomain is available
   */
  router.get('/available/:subdomain', (req, res) => {
    try {
      const { subdomain } = req.params;
      const isAvailable = subdomainService.isSubdomainAvailable(subdomain);
      
      res.json({
        available: isAvailable,
        subdomain: subdomain.toLowerCase()
      });
    } catch (error) {
      res.status(400).json({
        error: 'Validation error',
        message: error.message
      });
    }
  });

  /**
   * GET /api/subdomains/suggestions/:preferredName
   * Get available subdomain suggestions based on a preferred name
   */
  router.get('/suggestions/:preferredName', (req, res) => {
    try {
      const { preferredName } = req.params;
      const maxSuggestions = parseInt(req.query.max) || 5;
      
      const suggestions = subdomainService.getAvailableSubdomainSuggestions(preferredName, maxSuggestions);
      
      res.json({
        suggestions,
        preferredName: preferredName.toLowerCase()
      });
    } catch (error) {
      res.status(400).json({
        error: 'Validation error',
        message: error.message
      });
    }
  });

  /**
   * POST /api/subdomains
   * Create a new subdomain for a creator
   */
  router.post('/', (req, res) => {
    try {
      const { creatorId, subdomain } = req.body;
      
      if (!creatorId || !subdomain) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Both creatorId and subdomain are required'
        });
      }
      
      const subdomainRecord = subdomainService.createSubdomain({
        creatorId,
        subdomain
      });
      
      res.status(201).json({
        subdomain: subdomainRecord,
        url: subdomainService.getSubdomainUrl(subdomainRecord.subdomain)
      });
    } catch (error) {
      if (error.message.includes('already taken') || error.message.includes('Invalid')) {
        return res.status(400).json({
          error: 'Creation failed',
          message: error.message
        });
      }
      
      console.error('Error creating subdomain:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create subdomain'
      });
    }
  });

  /**
   * GET /api/subdomains/creator/:creatorId
   * Get all subdomains for a creator
   */
  router.get('/creator/:creatorId', (req, res) => {
    try {
      const { creatorId } = req.params;
      const subdomains = subdomainService.getCreatorSubdomains(creatorId);
      
      // Add full URLs to each subdomain
      const subdomainsWithUrls = subdomains.map(subdomain => ({
        ...subdomain,
        url: subdomainService.getSubdomainUrl(subdomain.subdomain)
      }));
      
      res.json({
        subdomains: subdomainsWithUrls,
        count: subdomainsWithUrls.length
      });
    } catch (error) {
      console.error('Error fetching creator subdomains:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to fetch subdomains'
      });
    }
  });

  /**
   * GET /api/subdomains/:subdomainId
   * Get a specific subdomain by ID
   */
  router.get('/:subdomainId', (req, res) => {
    try {
      const { subdomainId } = req.params;
      const subdomain = subdomainService.getSubdomain(subdomainId);
      
      if (!subdomain) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Subdomain not found'
        });
      }
      
      res.json({
        subdomain: {
          ...subdomain,
          url: subdomainService.getSubdomainUrl(subdomain.subdomain)
        }
      });
    } catch (error) {
      console.error('Error fetching subdomain:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to fetch subdomain'
      });
    }
  });

  /**
   * PUT /api/subdomains/:subdomainId/status
   * Update subdomain status
   */
  router.put('/:subdomainId/status', (req, res) => {
    try {
      const { subdomainId } = req.params;
      const { status } = req.body;
      
      if (!status) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'Status is required'
        });
      }
      
      const subdomain = subdomainService.updateSubdomainStatus({
        subdomainId,
        status
      });
      
      if (!subdomain) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Subdomain not found'
        });
      }
      
      res.json({
        subdomain: {
          ...subdomain,
          url: subdomainService.getSubdomainUrl(subdomain.subdomain)
        }
      });
    } catch (error) {
      if (error.message.includes('Invalid status')) {
        return res.status(400).json({
          error: 'Validation error',
          message: error.message
        });
      }
      
      console.error('Error updating subdomain status:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to update subdomain status'
      });
    }
  });

  /**
   * DELETE /api/subdomains/:subdomainId
   * Delete a subdomain
   */
  router.delete('/:subdomainId', (req, res) => {
    try {
      const { subdomainId } = req.params;
      const deleted = subdomainService.deleteSubdomain(subdomainId);
      
      if (!deleted) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Subdomain not found'
        });
      }
      
      res.json({
        message: 'Subdomain deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting subdomain:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to delete subdomain'
      });
    }
  });

  /**
   * GET /api/subdomains/generate
   * Generate a random available subdomain
   */
  router.get('/generate', (req, res) => {
    try {
      const prefix = req.query.prefix || 'creator';
      const subdomain = subdomainService.generateRandomSubdomain(prefix);
      
      if (!subdomain) {
        return res.status(500).json({
          error: 'Generation failed',
          message: 'Unable to generate an available subdomain'
        });
      }
      
      res.json({
        subdomain,
        url: subdomainService.getSubdomainUrl(subdomain)
      });
    } catch (error) {
      console.error('Error generating subdomain:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to generate subdomain'
      });
    }
  });

  return router;
}

module.exports = createSubdomainRoutes;
