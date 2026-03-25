const { AppDatabase } = require('../src/db/appDatabase');

class CommentService {
  constructor(database, subscriptionVerifier) {
    this.database = database;
    this.subscriptionVerifier = subscriptionVerifier;
  }

  /**
   * Verify that the user has an active subscription to the creator.
   * 
   * @param {string} userAddress - The user's wallet address
   * @param {string} creatorId - The creator's ID
   * @returns {Promise<boolean>} - Whether the user has an active subscription
   */
  async verifySubscription(userAddress, creatorId) {
    if (!this.subscriptionVerifier) {
      // If no subscription verifier is configured, allow access (for testing)
      return true;
    }

    try {
      const accessRequest = {
        walletAddress: userAddress,
        creatorAddress: creatorId,
      };

      const subscription = await this.subscriptionVerifier.verifySubscription(accessRequest);
      return subscription.active;
    } catch (error) {
      console.error('Subscription verification error:', error);
      return false;
    }
  }

  /**
   * Create a new comment on a post.
   * 
   * @param {object} commentData - The comment data
   * @param {string} commentData.postId - The post ID
   * @param {string} commentData.userAddress - The user's wallet address
   * @param {string} commentData.creatorId - The creator's ID
   * @param {string} commentData.content - The comment content
   * @returns {Promise<object>} - The created comment
   */
  async createComment(commentData) {
    const { postId, userAddress, creatorId, content } = commentData;

    // Verify subscription before allowing comment
    const hasSubscription = await this.verifySubscription(userAddress, creatorId);
    if (!hasSubscription) {
      const error = new Error('Active subscription required to comment');
      error.statusCode = 403;
      throw error;
    }

    return this.database.createComment({
      postId,
      userAddress,
      creatorId,
      content,
    });
  }

  /**
   * Get comments for a post.
   * 
   * @param {string} postId - The post ID
   * @returns {object[]} - The comments
   */
  getCommentsByPostId(postId) {
    return this.database.getCommentsByPostId(postId);
  }

  /**
   * Get a comment by ID.
   * 
   * @param {string} commentId - The comment ID
   * @returns {object|null} - The comment or null if not found
   */
  getCommentById(commentId) {
    return this.database.getCommentById(commentId);
  }

  /**
   * Update a comment.
   * 
   * @param {object} updateData - The update data
   * @param {string} updateData.commentId - The comment ID
   * @param {string} updateData.content - The new content
   * @param {string} updateData.userAddress - The user's wallet address (for authorization)
   * @returns {object} - The updated comment
   */
  updateComment(updateData) {
    const { commentId, content, userAddress } = updateData;

    const existingComment = this.database.getCommentById(commentId);
    if (!existingComment) {
      const error = new Error('Comment not found');
      error.statusCode = 404;
      throw error;
    }

    // Only the comment author can update their comment
    if (existingComment.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
      const error = new Error('Not authorized to update this comment');
      error.statusCode = 403;
      throw error;
    }

    return this.database.updateComment({ commentId, content });
  }

  /**
   * Delete a comment.
   * 
   * @param {object} deleteData - The delete data
   * @param {string} deleteData.commentId - The comment ID
   * @param {string} deleteData.userAddress - The user's wallet address (for authorization)
   * @param {string} deleteData.isCreator - Whether the user is the creator of the post
   * @returns {boolean} - Whether the deletion was successful
   */
  deleteComment(deleteData) {
    const { commentId, userAddress, isCreator } = deleteData;

    const existingComment = this.database.getCommentById(commentId);
    if (!existingComment) {
      const error = new Error('Comment not found');
      error.statusCode = 404;
      throw error;
    }

    // Only the comment author or the creator can delete the comment
    const isCommentAuthor = existingComment.userAddress.toLowerCase() === userAddress.toLowerCase();
    if (!isCommentAuthor && !isCreator) {
      const error = new Error('Not authorized to delete this comment');
      error.statusCode = 403;
      throw error;
    }

    return this.database.deleteComment(commentId);
  }
}

module.exports = {
  CommentService,
};