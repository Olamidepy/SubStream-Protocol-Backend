const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const AutomatedCopyrightFingerprintingService = require('../src/services/automatedCopyrightFingerprintingService');

const router = express.Router();

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = uuidv4();
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'), false);
    }
  }
});

function createVideoRoutes(config, database, videoWorker) {
  const fingerprintingService = new AutomatedCopyrightFingerprintingService(database);

  router.post('/upload', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No video file provided'
        });
      }

      const { title, description, creatorId, visibility = 'private' } = req.body;
      
      if (!title || !creatorId) {
        return res.status(400).json({
          success: false,
          error: 'Title and creator ID are required'
        });
      }

      const videoId = uuidv4();

      await fingerprintingService.ensureSchema();
      const perceptualHash = await fingerprintingService.generatePerceptualHash(req.file.path);
      const protectedHashMatch = await fingerprintingService.findProtectedMatch(perceptualHash);
      
      await database.run(
        `INSERT INTO videos 
         (id, title, description, creator_id, original_filename, file_path, file_size, status, visibility, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, CURRENT_TIMESTAMP)`,
        [
          videoId,
          title,
          description || null,
          creatorId,
          req.file.originalname,
          req.file.path,
          req.file.size,
          visibility
        ]
      );

      if (protectedHashMatch) {
        await database.run(
          `UPDATE videos
           SET status = ?, message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            'flagged_for_review',
            'Potential copyright match detected. Upload flagged for manual review.',
            videoId,
          ],
        );

        await fingerprintingService.recordFingerprint({
          videoId,
          phash: perceptualHash,
          matchedProtectedHashId: protectedHashMatch.id,
          status: 'flagged_for_review',
        });

        return res.status(202).json({
          success: true,
          data: {
            videoId,
            title,
            status: 'flagged_for_review',
            message: 'Upload flagged for manual review due to copyright fingerprint match.',
          },
        });
      }

      await fingerprintingService.recordFingerprint({
        videoId,
        phash: perceptualHash,
        matchedProtectedHashId: null,
        status: 'uploaded',
      });

      const transcodingJob = await videoWorker.addTranscodingJob(
        videoId,
        req.file.path,
        {
          priority: visibility === 'public' ? 'high' : 'normal'
        }
      );

      res.status(201).json({
        success: true,
        data: {
          videoId,
          title,
          status: 'uploaded',
          jobId: transcodingJob.id,
          message: 'Video uploaded successfully. Transcoding started.'
        }
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to upload video'
      });
    }
  });

  router.get('/:videoId/playlist', async (req, res) => {
    try {
      const { videoId } = req.params;
      const { quality } = req.query;
      
      const video = await database.get(
        'SELECT * FROM videos WHERE id = ?',
        [videoId]
      );

      if (!video) {
        return res.status(404).json({
          success: false,
          error: 'Video not found'
        });
      }

      if (video.visibility === 'private') {
        const authResult = await req.subscriptionVerifier?.verifySubscription({
          walletAddress: req.query.walletAddress,
          creatorAddress: video.creator_id,
          contentId: videoId,
          segmentPath: 'master.m3u8'
        });

        if (!authResult?.active) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. Active subscription required.'
          });
        }
      }

      const transcodingResult = await database.get(
        'SELECT * FROM transcoding_results WHERE video_id = ?',
        [videoId]
      );

      if (!transcodingResult) {
        return res.status(404).json({
          success: false,
          error: 'Video not yet processed'
        });
      }

      const masterPlaylist = JSON.parse(transcodingResult.master_playlist);
      
      if (quality) {
        const qualityPlaylist = await getQualityPlaylist(videoId, quality, database);
        if (qualityPlaylist) {
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          return res.send(qualityPlaylist);
        }
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(masterPlaylist.content);

    } catch (error) {
      console.error('Playlist error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get playlist'
      });
    }
  });

  router.get('/:videoId/segment/:segmentName', async (req, res) => {
    try {
      const { videoId, segmentName } = req.params;
      
      const video = await database.get(
        'SELECT * FROM videos WHERE id = ?',
        [videoId]
      );

      if (!video) {
        return res.status(404).json({
          success: false,
          error: 'Video not found'
        });
      }

      if (video.visibility === 'private') {
        const authResult = await req.subscriptionVerifier?.verifySubscription({
          walletAddress: req.query.walletAddress,
          creatorAddress: video.creator_id,
          contentId: videoId,
          segmentPath: segmentName
        });

        if (!authResult?.active) {
          return res.status(403).json({
            success: false,
            error: 'Access denied. Active subscription required.'
          });
        }
      }

      const segmentUrl = getSegmentUrl(videoId, segmentName, req.config);
      
      if (segmentUrl.startsWith('http')) {
        const response = await fetch(segmentUrl);
        if (!response.ok) {
          return res.status(404).json({
            success: false,
            error: 'Segment not found'
          });
        }
        
        res.setHeader('Content-Type', 'video/mp2t');
        return res.send(await response.arrayBuffer());
      }

      res.status(404).json({
        success: false,
        error: 'Segment not found'
      });

    } catch (error) {
      console.error('Segment error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get segment'
      });
    }
  });

  router.get('/:videoId/status', async (req, res) => {
    try {
      const { videoId } = req.params;
      
      const video = await database.get(
        'SELECT * FROM videos WHERE id = ?',
        [videoId]
      );

      if (!video) {
        return res.status(404).json({
          success: false,
          error: 'Video not found'
        });
      }

      const processingStatus = await videoWorker.getVideoStatus(videoId);
      
      res.json({
        success: true,
        data: {
          videoId: video.id,
          title: video.title,
          status: video.status,
          message: video.message,
          processingStatus,
          createdAt: video.created_at,
          updatedAt: video.updated_at
        }
      });

    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get video status'
      });
    }
  });

  router.post('/:videoId/analyze-connection', async (req, res) => {
    try {
      const { videoId } = req.params;
      const { bandwidth, latency, packetLoss } = req.body;

      if (!bandwidth || !latency || packetLoss === undefined) {
        return res.status(400).json({
          success: false,
          error: 'Bandwidth, latency, and packet loss are required'
        });
      }

      const connectionMetrics = {
        bandwidth: parseFloat(bandwidth),
        latency: parseInt(latency),
        packetLoss: parseFloat(packetLoss)
      };

      const job = await videoWorker.addAdaptiveBitrateJob(videoId, connectionMetrics);

      res.json({
        success: true,
        data: {
          videoId,
          jobId: job.id,
          message: 'Connection analysis started'
        }
      });

    } catch (error) {
      console.error('Connection analysis error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze connection'
      });
    }
  });

  router.get('/:videoId/recommended-quality', async (req, res) => {
    try {
      const { videoId } = req.params;
      
      const recommendedQuality = await videoWorker.getRecommendedQuality(videoId);
      
      res.json({
        success: true,
        data: {
          videoId,
          recommendedQuality
        }
      });

    } catch (error) {
      console.error('Quality recommendation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get recommended quality'
      });
    }
  });

  router.get('/queue/stats', async (req, res) => {
    try {
      const stats = await videoWorker.getQueueStats();
      
      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      console.error('Queue stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get queue statistics'
      });
    }
  });

  return router;
}

async function getQualityPlaylist(videoId, quality, database) {
  try {
    const transcodingResult = await database.get(
      'SELECT * FROM transcoding_results WHERE video_id = ?',
      [videoId]
    );

    if (!transcodingResult) return null;

    const resolutions = JSON.parse(transcodingResult.resolutions);
    const targetResolution = resolutions.find(r => r.resolution === quality);
    
    if (!targetResolution) return null;

    return `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD

#EXTINF:10.0,
${targetResolution.segments.replace('%03d', '001')}
#EXTINF:10.0,
${targetResolution.segments.replace('%03d', '002')}
#EXTINF:10.0,
${targetResolution.segments.replace('%03d', '003')}
#EXT-X-ENDLIST`;

  } catch (error) {
    console.error('Quality playlist error:', error);
    return null;
  }
}

function getSegmentUrl(videoId, segmentName, config) {
  if (config.cdn?.baseUrl) {
    return `${config.cdn.baseUrl}/${videoId}/${segmentName}`;
  }
  
  if (config.s3?.bucket && config.s3?.region) {
    return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/videos/${videoId}/${segmentName}`;
  }
  
  return `/videos/${videoId}/${segmentName}`;
}

module.exports = createVideoRoutes;
