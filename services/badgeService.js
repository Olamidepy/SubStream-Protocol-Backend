class BadgeService {
  constructor() {
    this.milestones = [
      { id: 'early_adopter', name: 'Early Adopter', description: 'Joined in the first month', condition: 'joinedWithinDays', value: 30 },
      { id: 'bronze_veteran', name: 'Bronze Veteran', description: '100 days as Bronze subscriber', condition: 'daysInTier', tier: 'bronze', value: 100 },
      { id: 'silver_veteran', name: 'Silver Veteran', description: '100 days as Silver subscriber', condition: 'daysInTier', tier: 'silver', value: 100 },
      { id: 'gold_veteran', name: 'Gold Veteran', description: '100 days as Gold subscriber', condition: 'daysInTier', tier: 'gold', value: 100 },
      { id: 'content_creator', name: 'Content Creator', description: 'Created 10+ pieces of content', condition: 'contentCount', value: 10 },
      { id: 'super_fan', name: 'Super Fan', description: 'Watched 100+ hours of content', condition: 'totalWatchTime', value: 360000 },
      { id: 'commentator', name: 'Commentator', description: 'Made 50+ comments', condition: 'commentCount', value: 50 },
      { id: 'loyal_fan', name: 'Loyal Fan', description: '365 days subscribed', condition: 'totalDaysSubscribed', value: 365 },
      { id: 'whale', name: 'Whale', description: 'Spent $1000+ on content', condition: 'totalSpent', value: 1000 },
      { id: 'engaged', name: 'Highly Engaged', description: 'Active for 30+ consecutive days', condition: 'consecutiveActiveDays', value: 30 }
    ];
  }

  async checkMilestones(userAddress) {
    const userStats = await this.getUserStats(userAddress);
    const earnedBadges = [];
    const existingBadges = await this.getUserBadges(userAddress);

    for (const milestone of this.milestones) {
      if (existingBadges.some(badge => badge.id === milestone.id)) {
        continue; // Already earned this badge
      }

      const earned = await this.evaluateCondition(userStats, milestone);
      if (earned) {
        await this.awardBadge(userAddress, milestone);
        earnedBadges.push(milestone);
      }
    }

    return earnedBadges;
  }

  async evaluateCondition(userStats, milestone) {
    switch (milestone.condition) {
      case 'joinedWithinDays':
        return this.checkJoinedWithinDays(userStats.joinedAt, milestone.value);
      
      case 'daysInTier':
        return this.checkDaysInTier(userStats.tierHistory, milestone.tier, milestone.value);
      
      case 'contentCount':
        return userStats.contentCount >= milestone.value;
      
      case 'totalWatchTime':
        return userStats.totalWatchTime >= milestone.value;
      
      case 'commentCount':
        return userStats.commentCount >= milestone.value;
      
      case 'totalDaysSubscribed':
        return this.checkTotalDaysSubscribed(userStats.subscriptionHistory, milestone.value);
      
      case 'totalSpent':
        return userStats.totalSpent >= milestone.value;
      
      case 'consecutiveActiveDays':
        return this.checkConsecutiveActiveDays(userStats.activityHistory, milestone.value);
      
      default:
        return false;
    }
  }

  checkJoinedWithinDays(joinedAt, days) {
    const joinDate = new Date(joinedAt);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    return joinDate >= cutoffDate;
  }

  checkDaysInTier(tierHistory, tier, days) {
    const tierEntry = tierHistory.find(entry => entry.tier === tier);
    if (!tierEntry) return false;
    
    const daysInTier = Math.floor((Date.now() - new Date(tierEntry.startDate).getTime()) / (1000 * 60 * 60 * 24));
    return daysInTier >= days;
  }

  checkTotalDaysSubscribed(subscriptionHistory, days) {
    let totalDays = 0;
    
    for (const subscription of subscriptionHistory) {
      const startDate = new Date(subscription.startDate);
      const endDate = subscription.endDate ? new Date(subscription.endDate) : new Date();
      totalDays += Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
    }
    
    return totalDays >= days;
  }

  checkConsecutiveActiveDays(activityHistory, days) {
    if (activityHistory.length < days) return false;
    
    const sortedActivities = activityHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
    let consecutiveCount = 0;
    let expectedDate = new Date();
    
    for (const activity of sortedActivities) {
      const activityDate = new Date(activity.date);
      const daysDiff = Math.floor((expectedDate - activityDate) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === 0) {
        consecutiveCount++;
        expectedDate.setDate(expectedDate.getDate() - 1);
      } else if (daysDiff === 1) {
        consecutiveCount++;
        expectedDate = activityDate;
        expectedDate.setDate(expectedDate.getDate() - 1);
      } else {
        break;
      }
    }
    
    return consecutiveCount >= days;
  }

  async getUserStats(userAddress) {
    // This would integrate with existing services to get real user statistics
    // Mock data for demonstration
    return {
      joinedAt: '2024-01-01T00:00:00Z',
      contentCount: 15,
      totalWatchTime: 400000, // seconds
      commentCount: 75,
      totalSpent: 1200,
      tierHistory: [
        { tier: 'bronze', startDate: '2024-01-01T00:00:00Z' },
        { tier: 'silver', startDate: '2024-02-15T00:00:00Z' }
      ],
      subscriptionHistory: [
        { startDate: '2024-01-01T00:00:00Z', endDate: null }
      ],
      activityHistory: Array.from({ length: 45 }, (_, i) => ({
        date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString()
      }))
    };
  }

  async getUserBadges(userAddress) {
    // This would query the database for existing badges
    // Mock data for demonstration
    return [
      { id: 'early_adopter', awardedAt: '2024-01-01T00:00:00Z' }
    ];
  }

  async awardBadge(userAddress, milestone) {
    // This would save the badge to the database
    console.log(`Awarding badge ${milestone.id} to user ${userAddress}`);
    
    // In a real implementation, this would:
    // 1. Save badge to database
    // 2. Send notification to user
    // 3. Update user's badge count
    // 4. Trigger any badge-related events
    
    return {
      userId: userAddress,
      badgeId: milestone.id,
      awardedAt: new Date().toISOString(),
      milestone: milestone
    };
  }

  async runDailyMilestoneCheck() {
    // This would be called by a cron job daily
    console.log('Running daily milestone check for all users...');
    
    // Get all active users
    const activeUsers = await this.getAllActiveUsers();
    
    for (const user of activeUsers) {
      try {
        const earnedBadges = await this.checkMilestones(user.address);
        
        if (earnedBadges.length > 0) {
          console.log(`User ${user.address} earned ${earnedBadges.length} new badges:`, 
                     earnedBadges.map(b => b.name).join(', '));
          
          // Send notifications
          await this.sendBadgeNotifications(user.address, earnedBadges);
        }
      } catch (error) {
        console.error(`Error checking milestones for user ${user.address}:`, error);
      }
    }
  }

  async getAllActiveUsers() {
    // This would query the database for all active users
    // Mock data for demonstration
    return [
      { address: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45' },
      { address: '0x1234567890123456789012345678901234567890' }
    ];
  }

  async sendBadgeNotifications(userAddress, badges) {
    // This would send notifications via email, push notifications, etc.
    console.log(`Sending badge notifications to ${userAddress} for:`, 
               badges.map(b => b.name).join(', '));
  }

  async getUserBadgesForDisplay(userAddress) {
    const badges = await this.getUserBadges(userAddress);
    const badgeDetails = badges.map(badge => {
      const milestone = this.milestones.find(m => m.id === badge.badgeId);
      return {
        ...badge,
        ...milestone
      };
    });
    
    return badgeDetails;
  }
}

module.exports = new BadgeService();
