const Queue = require('bull');
const redis = require('redis');
const VideoTranscodingService = require('./videoTranscodingService');
const { AppDatabase } = require('../db/appDatabase');

class VideoProcessingWorker {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.redis = redis.createClient(config.redis);
    this.transcodingService = new VideoTranscodingService(config);
    
    this.processingQueue = new Queue('video processing', {
      redis: config.redis,
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 5,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    });

    this.setupProcessors();
    this.setupEventListeners();
  }

  setupProcessors() {
    this.processingQueue.process('transcode-video', async (job) => {
      const { videoId, inputPath, options } = job.data;
      
      try {
        await this.updateVideoStatus(videoId, 'processing', 'Starting transcoding...');
        
        const result = await this.transcodingService.transcodeToHLS(inputPath, videoId, options);
        
        await this.updateVideoStatus(videoId, 'completed', 'Transcoding completed successfully');
        await this.saveTranscodingResult(videoId, result);
        
        return result;
      } catch (error) {
        await this.updateVideoStatus(videoId, 'failed', `Transcoding failed: ${error.message}`);
        throw error;
      }
    });

    this.processingQueue.process('adaptive-bitrate-analysis', async (job) => {
      const { videoId, connectionMetrics } = job.data;
      
      const recommendedQuality = this.analyzeConnectionQuality(connectionMetrics);
      
      await this.updateRecommendedQuality(videoId, recommendedQuality);
      
      return { videoId, recommendedQuality };
    });
  }

  setupEventListeners() {
    this.processingQueue.on('completed', (job, result) => {
      console.log(`Job ${job.id} completed:`, result);
    });

    this.processingQueue.on('failed', (job, err) => {
      console.error(`Job ${job.id} failed:`, err);
    });

    this.processingQueue.on('progress', (job, progress) => {
      console.log(`Job ${job.id} progress: ${progress}%`);
    });
  }

  async addTranscodingJob(videoId, inputPath, options = {}) {
    const job = await this.processingQueue.add('transcode-video', {
      videoId,
      inputPath,
      options
    }, {
      priority: options.priority || 'normal'
    });

    await this.updateVideoStatus(videoId, 'queued', 'Video queued for transcoding');
    
    return job;
  }

  async addAdaptiveBitrateJob(videoId, connectionMetrics) {
    const job = await this.processingQueue.add('adaptive-bitrate-analysis', {
      videoId,
      connectionMetrics
    }, {
      delay: 0,
      priority: 'high'
    });

    return job;
  }

  analyzeConnectionQuality(metrics) {
    const { bandwidth, latency, packetLoss } = metrics;
    
    if (bandwidth < 1 || packetLoss > 0.05) {
      return '360p';
    } else if (bandwidth < 3 || latency > 200) {
      return '720p';
    } else {
      return '1080p';
    }
  }

  async updateVideoStatus(videoId, status, message) {
    try {
      await this.database.run(
        'UPDATE videos SET status = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, message, videoId]
      );

      await this.redis.setex(`video:${videoId}:status`, 3600, JSON.stringify({
        status,
        message,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      console.error('Failed to update video status:', error);
    }
  }

  async saveTranscodingResult(videoId, result) {
    try {
      await this.database.run(
        `INSERT OR REPLACE INTO transcoding_results 
         (video_id, master_playlist, resolutions, upload_results, created_at) 
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          videoId,
          JSON.stringify(result.masterPlaylist),
          JSON.stringify(result.resolutions),
          JSON.stringify(result.uploadResults)
        ]
      );
    } catch (error) {
      console.error('Failed to save transcoding result:', error);
    }
  }

  async updateRecommendedQuality(videoId, quality) {
    try {
      await this.redis.setex(`video:${videoId}:quality`, 1800, quality);
    } catch (error) {
      console.error('Failed to update recommended quality:', error);
    }
  }

  async getRecommendedQuality(videoId) {
    try {
      const quality = await this.redis.get(`video:${videoId}:quality`);
      return quality || '720p';
    } catch (error) {
      console.error('Failed to get recommended quality:', error);
      return '720p';
    }
  }

  async getVideoStatus(videoId) {
    try {
      const status = await this.redis.get(`video:${videoId}:status`);
      return status ? JSON.parse(status) : null;
    } catch (error) {
      console.error('Failed to get video status:', error);
      return null;
    }
  }

  async getQueueStats() {
    try {
      const waiting = await this.processingQueue.getWaiting();
      const active = await this.processingQueue.getActive();
      const completed = await this.processingQueue.getCompleted();
      const failed = await this.processingQueue.getFailed();

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length
      };
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return null;
    }
  }

  async pauseQueue() {
    await this.processingQueue.pause();
  }

  async resumeQueue() {
    await this.processingQueue.resume();
  }

  async gracefulShutdown() {
    console.log('Shutting down video processing worker...');
    
    await this.processingQueue.close();
    await this.redis.quit();
    
    console.log('Video processing worker shut down successfully');
  }
}

module.exports = VideoProcessingWorker;
