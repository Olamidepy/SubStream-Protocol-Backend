const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const path = require('path');

const AutomatedCopyrightFingerprintingService = require('./src/services/automatedCopyrightFingerprintingService');

function createDatabaseAdapter() {
  const state = {
    protectedVideoHashes: [],
    videos: [],
    videoFingerprints: [],
    protectedHashIdCounter: 1,
    fingerprintIdCounter: 1,
  };

  return {
    run: async (sql, params = []) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS protected_video_hashes')) {
        return { changes: 0 };
      }

      if (sql.includes('CREATE TABLE IF NOT EXISTS video_fingerprints')) {
        return { changes: 0 };
      }

      if (sql.includes('INSERT INTO protected_video_hashes')) {
        const [phash, label, createdAt] = params;
        state.protectedVideoHashes.push({
          id: state.protectedHashIdCounter,
          phash,
          label,
          created_at: createdAt,
        });
        state.protectedHashIdCounter += 1;
        return { changes: 1 };
      }

      if (sql.includes('INSERT INTO videos')) {
        const [id, title, description, creatorId, originalFilename, filePath, fileSize, visibility] = params;
        state.videos.push({
          id,
          title,
          description,
          creator_id: creatorId,
          original_filename: originalFilename,
          file_path: filePath,
          file_size: fileSize,
          status: 'uploaded',
          message: null,
          visibility,
        });
        return { changes: 1 };
      }

      if (sql.includes('UPDATE videos') && sql.includes('SET status = ?, message = ?')) {
        const [status, message, videoId] = params;
        const video = state.videos.find((item) => item.id === videoId);
        if (video) {
          video.status = status;
          video.message = message;
          return { changes: 1 };
        }
        return { changes: 0 };
      }

      if (sql.includes('INSERT INTO video_fingerprints')) {
        const [videoId, phash, matchedProtectedHashId, status, createdAt] = params;
        state.videoFingerprints.push({
          id: state.fingerprintIdCounter,
          video_id: videoId,
          phash,
          matched_protected_hash_id: matchedProtectedHashId,
          status,
          created_at: createdAt,
        });
        state.fingerprintIdCounter += 1;
        return { changes: 1 };
      }

      throw new Error(`Unsupported SQL in test adapter: ${sql}`);
    },
    get: async (sql, params = []) => {
      if (sql.includes('FROM protected_video_hashes WHERE phash = ?')) {
        const [phash] = params;
        const match = state.protectedVideoHashes.find((item) => item.phash === phash);
        if (!match) return undefined;
        return {
          id: match.id,
          phash: match.phash,
          label: match.label,
          createdAt: match.created_at,
        };
      }

      if (sql.includes('SELECT status, message FROM videos WHERE id = ?')) {
        const [videoId] = params;
        const video = state.videos.find((item) => item.id === videoId);
        if (!video) return undefined;
        return { status: video.status, message: video.message };
      }

      if (sql.includes('FROM video_fingerprints WHERE video_id = ?')) {
        const [videoId] = params;
        const row = state.videoFingerprints.find((item) => item.video_id === videoId);
        if (!row) return undefined;
        return {
          status: row.status,
          matchedProtectedHashId: row.matched_protected_hash_id,
        };
      }

      throw new Error(`Unsupported SQL in test adapter: ${sql}`);
    },
  };
}

describe('Automated copyright fingerprinting on upload', () => {
  let app;
  let database;
  let videoWorker;
  let fingerprintingService;
  let createVideoRoutes;

  beforeEach(async () => {
    jest.resetModules();
    createVideoRoutes = require('./routes/video');

    database = createDatabaseAdapter();
    fingerprintingService = new AutomatedCopyrightFingerprintingService(database);
    await fingerprintingService.ensureSchema();

    videoWorker = {
      addTranscodingJob: jest.fn().mockResolvedValue({ id: 'job-1' }),
      getVideoStatus: jest.fn(),
      addAdaptiveBitrateJob: jest.fn(),
      getRecommendedQuality: jest.fn(),
      getQueueStats: jest.fn(),
    };

    app = express();
    app.use('/api/videos', createVideoRoutes({}, database, videoWorker));
  });

  afterEach(async () => {
    await fs.rm(path.join(process.cwd(), 'uploads'), { recursive: true, force: true });
  });

  it('flags upload for manual review when pHash matches a protected hash', async () => {
    const fileBuffer = Buffer.from('copyright-protected-video-signature-001');
    const phash = fingerprintingService.buildPerceptualHashFromBuffer(fileBuffer);

    await database.run(
      'INSERT INTO protected_video_hashes (phash, label, created_at) VALUES (?, ?, ?)',
      [phash, 'protected-master', new Date().toISOString()],
    );

    const res = await request(app)
      .post('/api/videos/upload')
      .field('title', 'Reupload attempt')
      .field('creatorId', 'creator-1')
      .attach('video', fileBuffer, { filename: 'protected.mp4', contentType: 'video/mp4' });

    expect(res.statusCode).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('flagged_for_review');
    expect(videoWorker.addTranscodingJob).not.toHaveBeenCalled();

    const video = await database.get('SELECT status, message FROM videos WHERE id = ?', [res.body.data.videoId]);
    expect(video.status).toBe('flagged_for_review');
    expect(video.message).toContain('manual review');

    const fingerprint = await database.get(
      'SELECT status, matched_protected_hash_id AS matchedProtectedHashId FROM video_fingerprints WHERE video_id = ?',
      [res.body.data.videoId],
    );
    expect(fingerprint.status).toBe('flagged_for_review');
    expect(fingerprint.matchedProtectedHashId).toBeTruthy();
  });

  it('continues normal upload flow when no protected hash match exists', async () => {
    const fileBuffer = Buffer.from('original-creator-video-content-xyz');

    const res = await request(app)
      .post('/api/videos/upload')
      .field('title', 'Original upload')
      .field('creatorId', 'creator-2')
      .attach('video', fileBuffer, { filename: 'original.mp4', contentType: 'video/mp4' });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('uploaded');
    expect(videoWorker.addTranscodingJob).toHaveBeenCalledTimes(1);

    const fingerprint = await database.get(
      'SELECT status, matched_protected_hash_id AS matchedProtectedHashId FROM video_fingerprints WHERE video_id = ?',
      [res.body.data.videoId],
    );
    expect(fingerprint.status).toBe('uploaded');
    expect(fingerprint.matchedProtectedHashId).toBeNull();
  });
});
