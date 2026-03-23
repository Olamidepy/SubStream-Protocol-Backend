const EventEmitter = require('events');

class AnalyticsService extends EventEmitter {
  constructor() {
    super();
    this.viewEvents = [];
    this.withdrawalEvents = [];
    this.heatmapData = new Map(); // videoId -> Map(second -> count)
    this.dripData = new Map(); // videoId -> total drips
    
    // Process events every 10 seconds
    setInterval(() => this.processEvents(), 10000);
  }

  // Record view-time event from frontend
  recordViewEvent(videoId, userId, watchTime, totalDuration) {
    const event = {
      videoId,
      userId,
      watchTime,
      totalDuration,
      timestamp: Date.now(),
      type: 'view'
    };
    
    this.viewEvents.push(event);
    this.emit('viewEvent', event);
  }

  // Record on-chain withdrawal event
  recordWithdrawalEvent(videoId, fromAddress, amount, timestamp) {
    const event = {
      videoId,
      fromAddress,
      amount: parseFloat(amount),
      timestamp,
      type: 'withdrawal'
    };
    
    this.withdrawalEvents.push(event);
    this.emit('withdrawalEvent', event);
  }

  // Process and aggregate events
  processEvents() {
    if (this.viewEvents.length === 0 && this.withdrawalEvents.length === 0) {
      return;
    }

    console.log(`Processing ${this.viewEvents.length} view events and ${this.withdrawalEvents.length} withdrawal events`);

    // Group view events by video
    const viewEventsByVideo = this.groupEventsByVideo(this.viewEvents);
    
    // Group withdrawal events by video
    const withdrawalEventsByVideo = this.groupEventsByVideo(this.withdrawalEvents);

    // Process each video
    for (const [videoId, viewEvents] of viewEventsByVideo) {
      const withdrawalEvents = withdrawalEventsByVideo.get(videoId) || [];
      this.processVideoAnalytics(videoId, viewEvents, withdrawalEvents);
    }

    // Clear processed events
    this.viewEvents = [];
    this.withdrawalEvents = [];
  }

  groupEventsByVideo(events) {
    const grouped = new Map();
    
    for (const event of events) {
      if (!grouped.has(event.videoId)) {
        grouped.set(event.videoId, []);
      }
      grouped.get(event.videoId).push(event);
    }
    
    return grouped;
  }

  processVideoAnalytics(videoId, viewEvents, withdrawalEvents) {
    if (!this.heatmapData.has(videoId)) {
      this.heatmapData.set(videoId, new Map());
    }
    
    if (!this.dripData.has(videoId)) {
      this.dripData.set(videoId, 0);
    }

    const heatmap = this.heatmapData.get(videoId);
    let totalDrips = this.dripData.get(videoId);

    // Calculate drips per second based on withdrawal events
    const dripsPerSecond = this.calculateDripsPerSecond(withdrawalEvents, viewEvents);
    
    // Update heatmap data
    for (const viewEvent of viewEvents) {
      const watchSeconds = Math.floor(viewEvent.watchTime);
      
      // Distribute drips across watched seconds
      for (let second = 0; second < watchSeconds; second++) {
        const currentCount = heatmap.get(second) || 0;
        heatmap.set(second, currentCount + dripsPerSecond);
      }
      
      totalDrips += dripsPerSecond * watchSeconds;
    }

    this.dripData.set(videoId, totalDrips);
    
    // Emit analytics update
    this.emit('analyticsUpdate', {
      videoId,
      heatmap: Object.fromEntries(heatmap),
      totalDrips,
      viewCount: viewEvents.length,
      withdrawalCount: withdrawalEvents.length
    });
  }

  calculateDripsPerSecond(withdrawalEvents, viewEvents) {
    if (withdrawalEvents.length === 0 || viewEvents.length === 0) {
      return 0;
    }

    const totalWithdrawn = withdrawalEvents.reduce((sum, event) => sum + event.amount, 0);
    const totalWatchTime = viewEvents.reduce((sum, event) => sum + event.watchTime, 0);
    
    return totalWatchTime > 0 ? totalWithdrawn / totalWatchTime : 0;
  }

  // Get heatmap data for a video
  getHeatmap(videoId) {
    const heatmap = this.heatmapData.get(videoId);
    return heatmap ? Object.fromEntries(heatmap) : {};
  }

  // Get total drips for a video
  getTotalDrips(videoId) {
    return this.dripData.get(videoId) || 0;
  }

  // Get analytics summary for a creator
  getCreatorAnalytics(videoIds) {
    const summary = {
      totalDrips: 0,
      totalViews: 0,
      totalWithdrawals: 0,
      videos: []
    };

    for (const videoId of videoIds) {
      const heatmap = this.heatmapData.get(videoId);
      const drips = this.dripData.get(videoId) || 0;
      
      if (heatmap) {
        const peakSecond = this.findPeakSecond(heatmap);
        const dropoffRate = this.calculateDropoffRate(heatmap);
        
        summary.videos.push({
          videoId,
          totalDrips: drips,
          peakSecond,
          dropoffRate,
          heatmapSize: heatmap.size
        });
      }
      
      summary.totalDrips += drips;
    }

    return summary;
  }

  findPeakSecond(heatmap) {
    let maxCount = 0;
    let peakSecond = 0;
    
    for (const [second, count] of heatmap) {
      if (count > maxCount) {
        maxCount = count;
        peakSecond = parseInt(second);
      }
    }
    
    return peakSecond;
  }

  calculateDropoffRate(heatmap) {
    if (heatmap.size < 2) return 0;
    
    const seconds = Array.from(heatmap.keys()).map(s => parseInt(s)).sort((a, b) => a - b);
    const firstHalf = seconds.slice(0, Math.floor(seconds.length / 2));
    const secondHalf = seconds.slice(Math.floor(seconds.length / 2));
    
    const firstHalfAvg = firstHalf.reduce((sum, s) => sum + (heatmap.get(s) || 0), 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((sum, s) => sum + (heatmap.get(s) || 0), 0) / secondHalf.length;
    
    return firstHalfAvg > 0 ? ((firstHalfAvg - secondHalfAvg) / firstHalfAvg) * 100 : 0;
  }
}

// Singleton instance
const analyticsService = new AnalyticsService();

module.exports = analyticsService;
