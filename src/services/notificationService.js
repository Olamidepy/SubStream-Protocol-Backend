// services/notificationService.js
// Service for handling in-app notifications for creators

class NotificationService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Add a notification for a creator
   * @param {string} creatorId
   * @param {object} notification { type, message, metadata, timestamp }
   */
  addNotification(creatorId, notification) {
    // For now, store in DB (implement DB logic as needed)
    return this.database.insertNotification({
      creatorId,
      ...notification,
      read: false,
    });
  }

  /**
   * List notifications for a creator
   * @param {string} creatorId
   */
  listNotifications(creatorId) {
    return this.database.listNotificationsByCreatorId(creatorId);
  }

  /**
   * Mark notification as read
   * @param {string} notificationId
   */
  markAsRead(notificationId) {
    return this.database.markNotificationAsRead(notificationId);
  }
}

module.exports = { NotificationService };