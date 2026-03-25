const path = require('path');

const { Networks } = require('@stellar/stellar-sdk');

const DEFAULT_CONTRACT_ID = 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L';

/**
 * Load runtime configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment values.
 * @returns {object}
 */
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    auth: {
      creatorJwtSecret: env.CREATOR_AUTH_SECRET || 'development-only-creator-secret',
      issuer: env.CREATOR_AUTH_ISSUER || 'substream-backend',
      audience: env.CREATOR_AUTH_AUDIENCE || 'substream-creators',
    },
    database: {
      filename:
        env.DATABASE_FILENAME ||
        path.join(process.cwd(), 'data', 'substream-protocol.sqlite'),
    },
    cdn: {
      baseUrl: env.CDN_BASE_URL || '',
      tokenSecret: env.CDN_TOKEN_SECRET || 'development-only-cdn-secret',
      tokenTtlSeconds: Number(env.CDN_TOKEN_TTL_SECONDS || 300),
      issuer: env.CDN_TOKEN_ISSUER || 'substream-backend',
      audience: env.CDN_TOKEN_AUDIENCE || 'substream-cdn',
    },
    soroban: {
      rpcUrl: env.SOROBAN_RPC_URL || '',
      networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE || Networks.PUBLIC,
      contractId: env.SOROBAN_CONTRACT_ID || DEFAULT_CONTRACT_ID,
      sourceSecret: env.SOROBAN_SOURCE_SECRET || '',
      method: env.SOROBAN_SUBSCRIPTION_METHOD || 'has_active_subscription',
      argumentMapping:
        env.SOROBAN_SUBSCRIPTION_ARGUMENTS || 'address:walletAddress,address:creatorAddress',
    },
    transcoding: {
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      outputDir: env.TRANSCODING_OUTPUT_DIR || './transcoded',
      maxConcurrent: Number(env.MAX_CONCURRENT_TRANSCODINGS || 3),
    },
    redis: {
      host: env.REDIS_HOST || 'localhost',
      port: Number(env.REDIS_PORT || 6379),
      password: env.REDIS_PASSWORD || '',
      db: Number(env.REDIS_DB || 0),
    },
    s3: env.S3_BUCKET ? {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    } : null,
    ipfs: env.IPFS_HOST ? {
      host: env.IPFS_HOST,
      port: Number(env.IPFS_PORT || 5001),
      protocol: env.IPFS_PROTOCOL || 'http',
    } : null,
    rabbitmq: {
      url: env.RABBITMQ_URL || '',
      host: env.RABBITMQ_HOST || 'localhost',
      port: Number(env.RABBITMQ_PORT || 5672),
      username: env.RABBITMQ_USERNAME || '',
      password: env.RABBITMQ_PASSWORD || '',
      vhost: env.RABBITMQ_VHOST || '/',
      eventExchange: env.RABBITMQ_EVENT_EXCHANGE || 'substream_events',
      eventQueue: env.RABBITMQ_EVENT_QUEUE || 'substream_events_queue',
      notificationQueue: env.RABBITMQ_NOTIFICATION_QUEUE || 'substream_notifications_queue',
      emailQueue: env.RABBITMQ_EMAIL_QUEUE || 'substream_emails_queue',
      leaderboardQueue: env.RABBITMQ_LEADERBOARD_QUEUE || 'substream_leaderboard_queue',
    },
  };
}

module.exports = {
  DEFAULT_CONTRACT_ID,
  loadConfig,
};
