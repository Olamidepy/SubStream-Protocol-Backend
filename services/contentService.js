class ContentService {
  constructor() {
    this.contentDatabase = new Map(); // contentId -> content metadata
    this.userSubscriptions = new Map(); // userAddress -> tier info
    this.tierHierarchy = { bronze: 1, silver: 2, gold: 3 };
    
    this.initializeMockData();
  }

  // Initialize with mock content data
  initializeMockData() {
    // Mock content with different tier requirements
    this.contentDatabase.set('video_001', {
      id: 'video_001',
      title: 'Introduction to DeFi',
      description: 'Learn the basics of decentralized finance',
      creator: '0x1234567890123456789012345678901234567890',
      requiredTier: 'bronze',
      thumbnail: 'https://example.com/thumb1.jpg',
      duration: 300,
      price: '0.001',
      tags: ['defi', 'basics'],
      createdAt: new Date('2024-01-15').toISOString(),
      views: 1250
    });

    this.contentDatabase.set('video_002', {
      id: 'video_002',
      title: 'Advanced Yield Farming Strategies',
      description: 'Master advanced techniques for yield farming',
      creator: '0x1234567890123456789012345678901234567890',
      requiredTier: 'silver',
      thumbnail: 'https://example.com/thumb2.jpg',
      duration: 600,
      price: '0.005',
      tags: ['defi', 'yield', 'advanced'],
      createdAt: new Date('2024-02-01').toISOString(),
      views: 850
    });

    this.contentDatabase.set('video_003', {
      id: 'video_003',
      title: 'Exclusive: NFT Masterclass',
      description: 'Complete guide to creating and selling NFTs',
      creator: '0x1234567890123456789012345678901234567890',
      requiredTier: 'gold',
      thumbnail: 'https://example.com/thumb3.jpg',
      duration: 900,
      price: '0.01',
      tags: ['nft', 'masterclass', 'exclusive'],
      createdAt: new Date('2024-02-15').toISOString(),
      views: 450
    });

    this.contentDatabase.set('video_004', {
      id: 'video_004',
      title: 'Blockchain Fundamentals',
      description: 'Understanding blockchain technology',
      creator: '0x9876543210987654321098765432109876543210',
      requiredTier: 'bronze',
      thumbnail: 'https://example.com/thumb4.jpg',
      duration: 450,
      price: '0.002',
      tags: ['blockchain', 'basics'],
      createdAt: new Date('2024-03-01').toISOString(),
      views: 2100
    });
  }

  // Get user's current tier
  getUserTier(userAddress) {
    const subscription = this.userSubscriptions.get(userAddress.toLowerCase());
    return subscription ? subscription.tier : 'bronze';
  }

  // Set user subscription tier
  setUserTier(userAddress, tier) {
    this.userSubscriptions.set(userAddress.toLowerCase(), {
      tier,
      updatedAt: Date.now()
    });
  }

  // Filter content based on user's tier
  filterContentByTier(content, userTier) {
    const userTierLevel = this.tierHierarchy[userTier] || 1;
    const requiredTierLevel = this.tierHierarchy[content.requiredTier] || 1;

    // If user has access, return full content
    if (userTierLevel >= requiredTierLevel) {
      return content;
    }

    // If user doesn't have access, return censored version
    return this.createCensoredContent(content, userTier);
  }

  // Create censored version of content for unauthorized users
  createCensoredContent(content, userTier) {
    const censored = {
      id: content.id,
      title: content.title,
      description: 'This content requires a higher subscription tier to access.',
      creator: content.creator,
      requiredTier: content.requiredTier,
      thumbnail: this.generateCensoredThumbnail(content.thumbnail),
      duration: null,
      price: content.price,
      tags: content.tags,
      createdAt: content.createdAt,
      views: content.views,
      censored: true,
      userTier,
      requiredTier: content.requiredTier,
      upgradeMessage: `Upgrade to ${content.requiredTier} tier to access this content`
    };

    // For bronze users trying to access gold content, show more information
    if (userTier === 'bronze' && content.requiredTier === 'gold') {
      censored.description = `Exclusive ${content.requiredTier} content: ${content.title}`;
      censored.previewAvailable = true;
    }

    return censored;
  }

  // Generate censored thumbnail URL
  generateCensoredThumbnail(originalThumbnail) {
    // In production, this would generate a blurred version
    return `${originalThumbnail}?censored=true&blur=10`;
  }

  // Get content with tier-based filtering
  getContent(contentId, userAddress) {
    const content = this.contentDatabase.get(contentId);
    
    if (!content) {
      throw new Error(`Content ${contentId} not found`);
    }

    const userTier = this.getUserTier(userAddress);
    return this.filterContentByTier(content, userTier);
  }

  // List content with tier-based filtering
  listContent(userAddress, filters = {}) {
    const userTier = this.getUserTier(userAddress);
    let contentList = Array.from(this.contentDatabase.values());

    // Apply filters
    if (filters.creator) {
      contentList = contentList.filter(content => 
        content.creator.toLowerCase() === filters.creator.toLowerCase()
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      contentList = contentList.filter(content => 
        filters.tags.some(tag => content.tags.includes(tag))
      );
    }

    if (filters.search) {
      const searchTerm = filters.search.toLowerCase();
      contentList = contentList.filter(content => 
        content.title.toLowerCase().includes(searchTerm) ||
        content.description.toLowerCase().includes(searchTerm)
      );
    }

    // Apply tier-based filtering to each content item
    const filteredContent = contentList.map(content => 
      this.filterContentByTier(content, userTier)
    );

    // Sort by creation date (newest first)
    filteredContent.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return filteredContent;
  }

  // Check if user can access content
  canAccessContent(contentId, userAddress) {
    const content = this.contentDatabase.get(contentId);
    if (!content) return false;

    const userTier = this.getUserTier(userAddress);
    const userTierLevel = this.tierHierarchy[userTier] || 1;
    const requiredTierLevel = this.tierHierarchy[content.requiredTier] || 1;

    return userTierLevel >= requiredTierLevel;
  }

  // Get content statistics for creators
  getCreatorStats(creatorAddress, userAddress) {
    const userTier = this.getUserTier(userAddress);
    const creatorContent = Array.from(this.contentDatabase.values())
      .filter(content => content.creator.toLowerCase() === creatorAddress.toLowerCase());

    const stats = {
      totalContent: creatorContent.length,
      totalViews: creatorContent.reduce((sum, content) => sum + content.views, 0),
      contentByTier: {
        bronze: 0,
        silver: 0,
        gold: 0
      },
      accessibleContent: 0
    };

    for (const content of creatorContent) {
      stats.contentByTier[content.requiredTier]++;
      
      if (this.canAccessContent(content.id, userAddress)) {
        stats.accessibleContent++;
      }
    }

    return stats;
  }

  // Get upgrade suggestions for user
  getUpgradeSuggestions(userAddress) {
    const userTier = this.getUserTier(userAddress);
    const userTierLevel = this.tierHierarchy[userTier] || 1;
    
    const suggestions = [];
    
    // Find content that requires higher tiers
    for (const [contentId, content] of this.contentDatabase) {
      const requiredTierLevel = this.tierHierarchy[content.requiredTier] || 1;
      
      if (requiredTierLevel > userTierLevel) {
        const existingSuggestion = suggestions.find(s => s.tier === content.requiredTier);
        
        if (existingSuggestion) {
          existingSuggestion.contentCount++;
          existingSuggestion.content.push({
            id: contentId,
            title: content.title
          });
        } else {
          suggestions.push({
            tier: content.requiredTier,
            tierLevel: requiredTierLevel,
            contentCount: 1,
            content: [{
              id: contentId,
              title: content.title
            }]
          });
        }
      }
    }

    // Sort suggestions by tier level
    suggestions.sort((a, b) => a.tierLevel - b.tierLevel);

    return {
      currentTier: userTier,
      suggestions
    };
  }

  // Add new content
  addContent(contentData, creatorAddress) {
    const content = {
      id: `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      creator: creatorAddress.toLowerCase(),
      createdAt: new Date().toISOString(),
      views: 0,
      ...contentData
    };

    this.contentDatabase.set(content.id, content);
    return content;
  }

  // Update content
  updateContent(contentId, updates, creatorAddress) {
    const content = this.contentDatabase.get(contentId);
    
    if (!content) {
      throw new Error(`Content ${contentId} not found`);
    }

    if (content.creator !== creatorAddress.toLowerCase()) {
      throw new Error('Only content creator can update content');
    }

    const updatedContent = {
      ...content,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    this.contentDatabase.set(contentId, updatedContent);
    return updatedContent;
  }

  // Delete content
  deleteContent(contentId, creatorAddress) {
    const content = this.contentDatabase.get(contentId);
    
    if (!content) {
      throw new Error(`Content ${contentId} not found`);
    }

    if (content.creator !== creatorAddress.toLowerCase()) {
      throw new Error('Only content creator can delete content');
    }

    this.contentDatabase.delete(contentId);
    return true;
  }
}

// Singleton instance
const contentService = new ContentService();

module.exports = contentService;
