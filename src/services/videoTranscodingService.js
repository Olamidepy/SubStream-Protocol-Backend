const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { create } = require('ipfs-http-client');

class VideoTranscodingService {
  constructor(config) {
    this.config = config;
    this.s3Client = config.s3 ? new S3Client(config.s3) : null;
    this.ipfsClient = config.ipfs ? create(config.ipfs) : null;
    this.outputDir = config.transcoding?.outputDir || './transcoded';
    this.resolutions = [
      { name: '360p', width: 640, height: 360, bitrate: '800k' },
      { name: '720p', width: 1280, height: 720, bitrate: '2500k' },
      { name: '1080p', width: 1920, height: 1080, bitrate: '5000k' }
    ];
  }

  async transcodeToHLS(inputPath, videoId, options = {}) {
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
      const videoDir = path.join(this.outputDir, videoId);
      await fs.mkdir(videoDir, { recursive: true });

      const transcodingPromises = this.resolutions.map(resolution => 
        this.transcodeResolution(inputPath, videoDir, videoId, resolution)
      );

      const transcodedFiles = await Promise.all(transcodingPromises);
      
      const masterPlaylist = await this.generateMasterPlaylist(videoDir, videoId, transcodedFiles);
      
      const uploadResults = await this.uploadToStorage(videoDir, videoId);

      await this.cleanupLocalFiles(videoDir);

      return {
        videoId,
        masterPlaylist,
        resolutions: transcodedFiles,
        uploadResults
      };
    } catch (error) {
      throw new Error(`Transcoding failed: ${error.message}`);
    }
  }

  async transcodeResolution(inputPath, outputDir, videoId, resolution) {
    const playlistPath = path.join(outputDir, `${resolution.name}.m3u8`);
    const segmentPattern = path.join(outputDir, `${resolution.name}_%03d.ts`);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`${resolution.width}x${resolution.height}`)
        .videoBitrate(resolution.bitrate)
        .audioBitrate('128k')
        .format('hls')
        .addOption('-hls_time', '10')
        .addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', segmentPattern)
        .addOption('-f', 'hls')
        .output(playlistPath)
        .on('end', () => {
          resolve({
            resolution: resolution.name,
            playlist: `${resolution.name}.m3u8`,
            segments: `${resolution.name}_%03d.ts`,
            bitrate: resolution.bitrate,
            width: resolution.width,
            height: resolution.height
          });
        })
        .on('error', (error) => {
          reject(new Error(`Failed to transcode ${resolution.name}: ${error.message}`));
        })
        .run();
    });
  }

  async generateMasterPlaylist(outputDir, videoId, transcodedFiles) {
    const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
    
    let playlist = '#EXTM3U\n#EXT-X-VERSION:6\n\n';
    
    transcodedFiles.forEach(file => {
      playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${this.getBandwidth(file.bitrate)},RESOLUTION=${file.width}x${file.height}\n`;
      playlist += `${file.playlist}\n\n`;
    });

    await fs.writeFile(masterPlaylistPath, playlist);
    
    return {
      filename: 'master.m3u8',
      content: playlist,
      url: this.getPlaylistUrl(videoId, 'master.m3u8')
    };
  }

  getBandwidth(bitrate) {
    const numericBitrate = parseInt(bitrate.replace('k', '')) * 1000;
    return numericBitrate + 128000;
  }

  getPlaylistUrl(videoId, filename) {
    if (this.config.cdn?.baseUrl) {
      return `${this.config.cdn.baseUrl}/${videoId}/${filename}`;
    }
    return `/videos/${videoId}/${filename}`;
  }

  async uploadToStorage(videoDir, videoId) {
    const results = { s3: null, ipfs: null };
    const files = await fs.readdir(videoDir);

    if (this.s3Client) {
      results.s3 = await this.uploadToS3(videoDir, videoId, files);
    }

    if (this.ipfsClient) {
      results.ipfs = await this.uploadToIPFS(videoDir, videoId, files);
    }

    return results;
  }

  async uploadToS3(videoDir, videoId, files) {
    const uploadPromises = files.map(async (file) => {
      const filePath = path.join(videoDir, file);
      const fileContent = await fs.readFile(filePath);
      
      const command = new PutObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: `videos/${videoId}/${file}`,
        Body: fileContent,
        ContentType: this.getContentType(file)
      });

      await this.s3Client.send(command);
      return { file, key: `videos/${videoId}/${file}` };
    });

    return Promise.all(uploadPromises);
  }

  async uploadToIPFS(videoDir, videoId, files) {
    const uploadPromises = files.map(async (file) => {
      const filePath = path.join(videoDir, file);
      const fileContent = await fs.readFile(filePath);
      
      const result = await this.ipfsClient.add(fileContent);
      return { file, hash: result.path, url: `ipfs://${result.path}` };
    });

    return Promise.all(uploadPromises);
  }

  getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.ts': 'video/mp2t'
    };
    return contentTypes[ext] || 'application/octet-stream';
  }

  async cleanupLocalFiles(videoDir) {
    try {
      await fs.rmdir(videoDir, { recursive: true });
    } catch (error) {
      console.warn(`Failed to cleanup local files: ${error.message}`);
    }
  }

  async getTranscodingStatus(videoId) {
    const statusFile = path.join(this.outputDir, `${videoId}_status.json`);
    try {
      const content = await fs.readFile(statusFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  async updateTranscodingStatus(videoId, status) {
    const statusFile = path.join(this.outputDir, `${videoId}_status.json`);
    const statusData = {
      videoId,
      status,
      timestamp: new Date().toISOString(),
      ...status
    };
    await fs.writeFile(statusFile, JSON.stringify(statusData, null, 2));
  }
}

module.exports = VideoTranscodingService;
