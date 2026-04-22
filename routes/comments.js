const express = require('express');
const { AppDatabase } = require('../src/db/appDatabase');
const { loadConfig } = require('../src/config');
const { SorobanSubscriptionVerifier } = require('../src/services/sorobanSubscriptionVerifier');
const { CommentService } = require('../services/commentService');
const { authenticateToken, getUserId } = require('../middleware/unifiedAuth');

// Initialize services
const config = loadConfig();
const database = new AppDatabase(config.database.filename);
const subscriptionVerifier = new SorobanSubscriptionVerifier(config);
const commentService = new CommentService(database, subscriptionVerifier);

// Create router
const commentsRouter = express.Router();

/**
 * GET /api/comments/:postId
 * Get all comments for a post
 * Public endpoint - no subscription required for viewing
 */
commentsRouter.get('/:postId', (req, res) => {
  try {
    const { postId } = req.params;
    
    const comments = commentService.getCommentsByPostId(postId);

    res.json({
      success: true,
      comments
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get comments'
    });
  }
});

/**
 * POST /api/comments
 * Create a new comment on a post
 * Requires: valid JWT token + active subscription
 */
commentsRouter.post('/', authenticateToken, async (req, res) => {
  try {
    const { post_id, creator_id, content } = req.body;

    if (!post_id || !creator_id || !content) {
      return res.status(400).json({
        success: false,
        error: 'post_id, creator_id, and content are required'
      });
    }

    const comment = await commentService.createComment({
      postId: post_id,
      userAddress: req.user.address,
      creatorId: creator_id,
      content
    });

    res.status(201).json({
      success: true,
      comment
    });
  } catch (error) {
    console.error('Create comment error:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to create comment'
    });
  }
});

/**
 * PUT /api/comments/:commentId
 * Update a comment
 * Requires: valid JWT token + ownership of the comment
 */
commentsRouter.put('/:commentId', authenticateToken, (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'content is required'
      });
    }

    const comment = commentService.updateComment({
      commentId,
      content,
      userAddress: req.user.address
    });

    res.json({
      success: true,
      comment
    });
  } catch (error) {
    console.error('Update comment error:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update comment'
    });
  }
});

/**
 * DELETE /api/comments/:commentId
 * Delete a comment
 * Requires: valid JWT token + ownership of the comment OR creator of the post
 */
commentsRouter.delete('/:commentId', authenticateToken, (req, res) => {
  try {
    const { commentId } = req.params;
    const { is_creator } = req.body;

    const deleted = commentService.deleteComment({
      commentId,
      userAddress: req.user.address,
      isCreator: is_creator === true
    });

    if (deleted) {
      res.json({
        success: true,
        message: 'Comment deleted successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }
  } catch (error) {
    console.error('Delete comment error:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete comment'
    });
  }
});

module.exports = commentsRouter;