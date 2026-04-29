const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

class GDPRService {
  constructor() {
    this.exportDir = path.join(__dirname, '../exports');
    this.ensureExportDir();
  }

  ensureExportDir() {
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  async exportUserData(userAddress) {
    try {
      const userData = await this.collectAllUserData(userAddress);
      const exportData = {
        userAddress,
        exportDate: new Date().toISOString(),
        data: userData
      };

      const filename = `user-data-export-${userAddress}-${Date.now()}.json`;
      const filePath = path.join(this.exportDir, filename);

      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));

      return {
        filename,
        filePath,
        size: fs.statSync(filePath).size,
        downloadUrl: `/user/export/download/${filename}`
      };
    } catch (error) {
      console.error('Error exporting user data:', error);
      throw new Error('Failed to export user data');
    }
  }

  async collectAllUserData(userAddress) {
    const userData = {
      profile: await this.getUserProfile(userAddress),
      comments: await this.getUserComments(userAddress),
      content: await this.getUserContent(userAddress),
      analytics: await this.getUserAnalytics(userAddress),
      subscriptions: await this.getUserSubscriptions(userAddress),
      transactions: await this.getUserTransactions(userAddress),
      badges: await this.getUserBadges(userAddress),
      activity: await this.getUserActivity(userAddress),
      preferences: await this.getUserPreferences(userAddress)
    };

    return userData;
  }

  async getUserProfile(userAddress) {
    // Mock data - in real implementation, this would query the database
    return {
      address: userAddress,
      username: 'user_' + userAddress.slice(0, 8),
      email: 'user@example.com',
      tier: 'bronze',
      joinedAt: '2024-01-01T00:00:00Z',
      lastActiveAt: '2024-03-28T10:30:00Z',
      profilePicture: 'https://example.com/avatar.jpg',
      bio: 'Content creator and enthusiast',
      socialLinks: {
        twitter: '@userhandle',
        website: 'https://userwebsite.com'
      }
    };
  }

  async getUserComments(userAddress) {
    // Mock data - in real implementation, this would query the database
    return [
      {
        id: 'comment_001',
        contentId: 'content_001',
        text: 'Great content! Really enjoyed this episode.',
        createdAt: '2024-02-15T14:30:00Z',
        updatedAt: '2024-02-15T14:30:00Z',
        likes: 5,
        replies: []
      },
      {
        id: 'comment_002',
        contentId: 'content_002',
        text: 'Looking forward to more content like this.',
        createdAt: '2024-03-01T09:15:00Z',
        updatedAt: '2024-03-01T09:15:00Z',
        likes: 3,
        replies: []
      }
    ];
  }

  async getUserContent(userAddress) {
    // Mock data - in real implementation, this would query the database
    return [
      {
        id: 'content_001',
        title: 'My First Podcast Episode',
        description: 'An introduction to my podcast journey',
        type: 'podcast',
        duration: 1800,
        fileSize: 50000000,
        createdAt: '2024-01-15T10:00:00Z',
        updatedAt: '2024-01-15T10:00:00Z',
        views: 150,
        likes: 25,
        tags: ['podcast', 'introduction', 'journey'],
        accessTier: 'bronze'
      }
    ];
  }

  async getUserAnalytics(userAddress) {
    // Mock data - in real implementation, this would query the analytics service
    return {
      totalWatchTime: 400000,
      totalViews: 250,
      averageSessionDuration: 1600,
      mostViewedContent: 'content_001',
      peakActivityHour: 19,
      deviceBreakdown: {
        desktop: 0.6,
        mobile: 0.35,
        tablet: 0.05
      },
      geographicDistribution: {
        'US': 0.4,
        'UK': 0.2,
        'CA': 0.15,
        'Other': 0.25
      }
    };
  }

  async getUserSubscriptions(userAddress) {
    // Mock data - in real implementation, this would query the subscription service
    return [
      {
        id: 'sub_001',
        creatorAddress: '0xcreator123...',
        tier: 'bronze',
        startDate: '2024-01-01T00:00:00Z',
        endDate: null,
        status: 'active',
        amount: 10,
        currency: 'USDC',
        autoRenew: true
      }
    ];
  }

  async getUserTransactions(userAddress) {
    // Mock data - in real implementation, this would query the blockchain/database
    return [
      {
        id: 'tx_001',
        type: 'subscription_payment',
        amount: 10,
        currency: 'USDC',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'completed',
        hash: '0x123abc...',
        description: 'Monthly subscription payment'
      }
    ];
  }

  async getUserBadges(userAddress) {
    // Mock data - in real implementation, this would query the badge service
    return [
      {
        id: 'early_adopter',
        name: 'Early Adopter',
        description: 'Joined in the first month',
        awardedAt: '2024-01-01T00:00:00Z'
      }
    ];
  }

  async getUserActivity(userAddress) {
    // Mock data - in real implementation, this would query the activity logs
    return [
      {
        type: 'login',
        timestamp: '2024-03-28T10:30:00Z',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0...'
      },
      {
        type: 'content_view',
        timestamp: '2024-03-28T09:15:00Z',
        contentId: 'content_001',
        duration: 1200
      }
    ];
  }

  async getUserPreferences(userAddress) {
    // Mock data - in real implementation, this would query the preferences service
    return {
      language: 'en',
      timezone: 'UTC',
      emailNotifications: true,
      pushNotifications: false,
      autoPlay: true,
      quality: '720p',
      privacy: {
        profileVisible: true,
        activityVisible: false,
        commentsVisible: true
      }
    };
  }

  async deleteUserData(userAddress) {
    try {
      // This is a critical operation that should be carefully implemented
      // In a real implementation, this would:
      // 1. Anonymize user data instead of hard deletion (for data integrity)
      // 2. Handle foreign key constraints
      // 3. Create audit logs
      // 4. Handle any legal hold requirements

      const deletionLog = {
        userAddress,
        deletionDate: new Date().toISOString(),
        operations: []
      };

      // Anonymize user profile
      await this.anonymizeUserProfile(userAddress);
      deletionLog.operations.push('profile_anonymized');

      // Anonymize comments
      await this.anonymizeUserComments(userAddress);
      deletionLog.operations.push('comments_anonymized');

      // Handle user content (transfer or delete based on policy)
      await this.handleUserContent(userAddress);
      deletionLog.operations.push('content_handled');

      // Delete analytics data
      await this.deleteUserAnalytics(userAddress);
      deletionLog.operations.push('analytics_deleted');

      // Delete subscriptions
      await this.deleteUserSubscriptions(userAddress);
      deletionLog.operations.push('subscriptions_deleted');

      // Delete activity logs
      await this.deleteUserActivity(userAddress);
      deletionLog.operations.push('activity_deleted');

      // Save deletion log for audit purposes
      await this.saveDeletionLog(deletionLog);

      return {
        success: true,
        message: 'User data has been successfully anonymized/deleted',
        deletionDate: deletionLog.deletionDate,
        operations: deletionLog.operations
      };
    } catch (error) {
      console.error('Error deleting user data:', error);
      throw new Error('Failed to delete user data');
    }
  }

  async anonymizeUserProfile(userAddress) {
    // Replace user data with anonymized values
    const anonymizedData = {
      address: userAddress, // Keep address for reference
      username: 'deleted_user_' + Math.random().toString(36).substr(2, 9),
      email: null,
      tier: null,
      joinedAt: null,
      lastActiveAt: null,
      profilePicture: null,
      bio: null,
      socialLinks: null,
      deletedAt: new Date().toISOString()
    };

    // In real implementation, this would update the database
    console.log('Anonymized user profile');
  }

  async anonymizeUserComments(userAddress) {
    // Replace user comments with anonymized placeholder
    // In real implementation, this would update the database
    console.log('Anonymized user comments');
  }

  async handleUserContent(userAddress) {
    // Depending on policy, either transfer ownership or delete content
    // In real implementation, this would handle content according to legal requirements
    console.log('Handled user content');
  }

  async deleteUserAnalytics(userAddress) {
    // Delete analytics data
    // In real implementation, this would delete from analytics database
    console.log('Deleted user analytics');
  }

  async deleteUserSubscriptions(userAddress) {
    // Cancel and delete subscription data
    // In real implementation, this would update subscription database
    console.log('Deleted user subscriptions');
  }

  async deleteUserActivity(userAddress) {
    // Delete activity logs
    // In real implementation, this would delete from activity database
    console.log('Deleted user activity logs');
  }

  async saveDeletionLog(deletionLog) {
    const logFilename = `deletion-log-${deletionLog.userAddress}-${Date.now()}.json`;
    const logFilePath = path.join(this.exportDir, logFilename);

    fs.writeFileSync(logFilePath, JSON.stringify(deletionLog, null, 2));
    console.log(`Saved deletion log to ${logFilePath}`);
  }

  async createZipArchive(userAddress, exportFiles) {
    return new Promise((resolve, reject) => {
      const zipFilename = `user-data-${userAddress}-${Date.now()}.zip`;
      const zipFilePath = path.join(this.exportDir, zipFilename);
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        resolve({
          filename: zipFilename,
          filePath: zipFilePath,
          size: archive.pointer(),
          downloadUrl: `/user/export/download/${zipFilename}`
        });
      });

      archive.on('error', reject);
      archive.pipe(output);

      // Add files to archive
      exportFiles.forEach(file => {
        archive.file(file.filePath, { name: file.filename });
      });

      archive.finalize();
    });
  }

  async getExportStatus(filename) {
    const filePath = path.join(this.exportDir, filename);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);

    return {
      filename,
      size: stats.size,
      createdAt: stats.birthtime.toISOString(),
      downloadUrl: `/user/export/download/${filename}`,
      expiresAt: new Date(stats.birthtime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
    };
  }

  async cleanupExpiredExports() {
    const files = fs.readdirSync(this.exportDir);
    const now = Date.now();
    const expiredFiles = [];

    files.forEach(file => {
      const filePath = path.join(this.exportDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.birthtime.getTime();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

      if (age > maxAge) {
        fs.unlinkSync(filePath);
        expiredFiles.push(file);
      }
    });

    return expiredFiles;
  }
}

module.exports = new GDPRService();
