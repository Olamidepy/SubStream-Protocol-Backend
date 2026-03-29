const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { createApp } = require('./index');

async function testVideoTranscoding() {
  console.log('🧪 Testing Video Transcoding API...\n');

  // Mock configuration for testing
  const testConfig = {
    port: 3001,
    auth: {
      creatorJwtSecret: 'test-secret',
      issuer: 'test-issuer',
      audience: 'test-audience',
    },
    database: {
      filename: ':memory:',
    },
    cdn: {
      baseUrl: 'http://localhost:3001',
      tokenSecret: 'test-cdn-secret',
      tokenTtlSeconds: 300,
    },
    soroban: {
      rpcUrl: '',
      networkPassphrase: 'Test Network',
      contractId: 'test-contract',
      sourceSecret: '',
      method: 'has_active_subscription',
    },
    transcoding: {
      ffmpegPath: 'ffmpeg',
      outputDir: './test-transcoded',
      maxConcurrent: 1,
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 1, // Use test DB
    },
    s3: null, // Disable S3 for testing
    ipfs: null, // Disable IPFS for testing
  };

  const app = createApp({ config: testConfig });

  try {
    // Test 1: Health check
    console.log('1. Testing health check...');
    const healthResponse = await request(app)
      .get('/')
      .expect(200);
    
    console.log('✅ Health check passed:', healthResponse.body.project);

    // Test 2: Queue stats
    console.log('\n2. Testing queue stats...');
    const queueResponse = await request(app)
      .get('/api/videos/queue/stats')
      .expect(200);
    
    console.log('✅ Queue stats:', queueResponse.body.data);

    // Test 3: Video status for non-existent video
    console.log('\n3. Testing video status (non-existent)...');
    const statusResponse = await request(app)
      .get('/api/videos/non-existent-video/status')
      .expect(404);
    
    console.log('✅ Correctly returns 404 for non-existent video');

    // Test 4: Playlist for non-existent video
    console.log('\n4. Testing playlist (non-existent video)...');
    const playlistResponse = await request(app)
      .get('/api/videos/non-existent-video/playlist')
      .expect(404);
    
    console.log('✅ Correctly returns 404 for non-existent playlist');

    console.log('\n🎉 All basic tests passed!');
    console.log('\n📝 Note: Full video transcoding tests require:');
    console.log('   - FFmpeg installation');
    console.log('   - Redis server');
    console.log('   - Actual video files');
    console.log('\n🚀 To test with real video upload:');
    console.log('   1. Install FFmpeg and start Redis');
    console.log('   2. Set up environment variables');
    console.log('   3. Use curl or Postman to upload a video file');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  testVideoTranscoding()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Test suite failed:', error);
      process.exit(1);
    });
}

module.exports = { testVideoTranscoding };
