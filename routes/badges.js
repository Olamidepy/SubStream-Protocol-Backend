const express = require('express');
const router = express.Router();
const badgeService = require('../services/badgeService');

// Get user's badges
router.get('/user/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const badges = await badgeService.getUserBadgesForDisplay(userAddress);
    
    res.json({
      success: true,
      data: {
        badges,
        totalBadges: badges.length
      }
    });
  } catch (error) {
    console.error('Error fetching user badges:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user badges'
    });
  }
});

// Check milestones for a specific user
router.post('/check-milestones/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'User address is required'
      });
    }

    const earnedBadges = await badgeService.checkMilestones(userAddress);
    
    res.json({
      success: true,
      data: {
        newlyEarnedBadges: earnedBadges,
        count: earnedBadges.length
      }
    });
  } catch (error) {
    console.error('Error checking milestones:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check milestones'
    });
  }
});

// Run daily milestone check (admin endpoint)
router.post('/run-daily-check', async (req, res) => {
  try {
    // This should be protected by admin middleware
    await badgeService.runDailyMilestoneCheck();
    
    res.json({
      success: true,
      message: 'Daily milestone check completed'
    });
  } catch (error) {
    console.error('Error running daily milestone check:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to run daily milestone check'
    });
  }
});

// Get all available milestones
router.get('/milestones', async (req, res) => {
  try {
    const milestones = badgeService.milestones;
    
    res.json({
      success: true,
      data: {
        milestones,
        totalMilestones: milestones.length
      }
    });
  } catch (error) {
    console.error('Error fetching milestones:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch milestones'
    });
  }
});

// Award badge manually (admin endpoint)
router.post('/award', async (req, res) => {
  try {
    const { userAddress, badgeId } = req.body;
    
    if (!userAddress || !badgeId) {
      return res.status(400).json({
        success: false,
        error: 'User address and badge ID are required'
      });
    }

    const milestone = badgeService.milestones.find(m => m.id === badgeId);
    if (!milestone) {
      return res.status(404).json({
        success: false,
        error: 'Badge not found'
      });
    }

    const awardedBadge = await badgeService.awardBadge(userAddress, milestone);
    
    res.json({
      success: true,
      data: awardedBadge
    });
  } catch (error) {
    console.error('Error awarding badge:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to award badge'
    });
  }
});

module.exports = router;
