const express = require('express');
const router = express.Router();
const postService = require('../services/postService');
const { authenticateToken, requireTierUnified, getUserId } = require('../middleware/unifiedAuth');

// Get all posts
router.get('/', authenticateToken, (req, res) => {
  try {
    const posts = postService.getAllPosts(getUserId(req.user));
    
    res.json({
      success: true,
      posts
    });

  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get posts'
    });
  }
});

// Create a new post
router.post('/', authenticateToken, (req, res) => {
  try {
    const { content, tier_required, media_url } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Content is required'
      });
    }

    const post = postService.createPost({
      creator_id: req.user.address,
      content,
      tier_required,
      media_url
    });

    res.status(201).json({
      success: true,
      post
    });

  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create post'
    });
  }
});

module.exports = router;
