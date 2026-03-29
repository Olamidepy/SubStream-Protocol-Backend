const express = require('express');
const router = express.Router();
const contentService = require('../services/contentService');
const { authenticateToken, requireTier } = require('../middleware/auth');

// Get content by ID with tier-based filtering
router.get('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const content = contentService.getContent(contentId, req.user.address);

    res.json({
      success: true,
      content
    });

  } catch (error) {
    console.error('Get content error:', error);
    res.status(404).json({
      success: false,
      error: error.message || 'Content not found'
    });
  }
});

// List content with tier-based filtering
router.get('/', authenticateToken, (req, res) => {
  try {
    const filters = {
      creator: req.query.creator,
      tags: req.query.tags ? req.query.tags.split(',') : [],
      search: req.query.search,
      tier: req.query.tier
    };

    const contentList = contentService.listContent(req.user.address, filters);

    res.json({
      success: true,
      content: contentList,
      count: contentList.length,
      filters
    });

  } catch (error) {
    console.error('List content error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list content'
    });
  }
});

// Create new content (creator only)
router.post('/', authenticateToken, requireTier('bronze'), async (req, res) => {
  try {
    const {
      title,
      description,
      requiredTier = 'bronze',
      thumbnail,
      duration,
      price,
      tags,
      federate = true // Allow creators to opt-out of federation
    } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        success: false,
        error: 'Title and description are required'
      });
    }

    const content = contentService.addContent({
      title,
      description,
      requiredTier,
      thumbnail,
      duration: parseFloat(duration),
      price,
      tags: tags || []
    }, req.user.address);

    // Queue content for ActivityPub federation if enabled
    if (federate && req.app.get('federationService')) {
      try {
        await req.app.get('federationService').queueContentForFederation(content);
      } catch (federationError) {
        // Log error but don't fail content creation
        console.error('Federation queue error:', federationError);
      }
    }

    res.status(201).json({
      success: true,
      content
    });

  } catch (error) {
    console.error('Create content error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create content'
    });
  }
});

// Update content (creator only)
router.put('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const updates = req.body;

    // Don't allow updating creator or creation date
    delete updates.creator;
    delete updates.createdAt;

    const updatedContent = contentService.updateContent(contentId, updates, req.user.address);

    res.json({
      success: true,
      content: updatedContent
    });

  } catch (error) {
    console.error('Update content error:', error);
    res.status(403).json({
      success: false,
      error: error.message || 'Failed to update content'
    });
  }
});

// Delete content (creator only)
router.delete('/:contentId', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;

    contentService.deleteContent(contentId, req.user.address);

    res.json({
      success: true,
      message: 'Content deleted successfully'
    });

  } catch (error) {
    console.error('Delete content error:', error);
    res.status(403).json({
      success: false,
      error: error.message || 'Failed to delete content'
    });
  }
});

// Check if user can access content
router.get('/:contentId/access', authenticateToken, (req, res) => {
  try {
    const { contentId } = req.params;
    const canAccess = contentService.canAccessContent(contentId, req.user.address);

    res.json({
      success: true,
      contentId,
      canAccess,
      userTier: contentService.getUserTier(req.user.address)
    });

  } catch (error) {
    console.error('Check access error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check access'
    });
  }
});

// Get creator statistics
router.get('/creator/:creatorAddress/stats', authenticateToken, (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const stats = contentService.getCreatorStats(creatorAddress, req.user.address);

    res.json({
      success: true,
      creatorAddress,
      stats
    });

  } catch (error) {
    console.error('Get creator stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get creator statistics'
    });
  }
});

// Get upgrade suggestions for user
router.get('/upgrade/suggestions', authenticateToken, (req, res) => {
  try {
    const suggestions = contentService.getUpgradeSuggestions(req.user.address);

    res.json({
      success: true,
      suggestions
    });

  } catch (error) {
    console.error('Get upgrade suggestions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get upgrade suggestions'
    });
  }
});

// Get content by tier (for discovery)
router.get('/tier/:tierName', authenticateToken, (req, res) => {
  try {
    const { tierName } = req.params;

    // Validate tier name
    const validTiers = ['bronze', 'silver', 'gold'];
    if (!validTiers.includes(tierName)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tier. Must be bronze, silver, or gold'
      });
    }

    const filters = {
      ...req.query,
      requiredTier: tierName
    };

    const contentList = contentService.listContent(req.user.address, filters);

    res.json({
      success: true,
      tier: tierName,
      content: contentList,
      count: contentList.length
    });

  } catch (error) {
    console.error('Get content by tier error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get content by tier'
    });
  }
});

// Search content with tier awareness
router.post('/search', authenticateToken, (req, res) => {
  try {
    const { query, filters = {} } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }

    const searchFilters = {
      ...filters,
      search: query
    };

    const results = contentService.listContent(req.user.address, searchFilters);

    res.json({
      success: true,
      query,
      results,
      count: results.length
    });

  } catch (error) {
    console.error('Search content error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search content'
    });
  }
});

// Get user's accessible content summary
router.get('/user/summary', authenticateToken, (req, res) => {
  try {
    const userTier = contentService.getUserTier(req.user.address);
    const allContent = contentService.listContent(req.user.address);

    const summary = {
      userTier,
      totalContent: allContent.length,
      accessibleContent: allContent.filter(c => !c.censored).length,
      restrictedContent: allContent.filter(c => c.censored).length,
      contentByTier: {
        bronze: allContent.filter(c => c.requiredTier === 'bronze').length,
        silver: allContent.filter(c => c.requiredTier === 'silver').length,
        gold: allContent.filter(c => c.requiredTier === 'gold').length
      }
    };

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    console.error('Get user summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user summary'
    });
  }
});

module.exports = router;
