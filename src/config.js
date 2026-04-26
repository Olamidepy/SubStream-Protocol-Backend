const path = require('path');
const crypto = require('crypto');

const { Networks } = require('@stellar/stellar-sdk');

const DEFAULT_CONTRACT_ID = 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L';

/**
 * Load runtime configuration from environment variables or Vault.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment values.
 * @param {object} [vaultService] Optional VaultService instance for secret retrieval.
 * @returns {object}
 */
async function loadConfig(env = process.env, vaultService = null) {
  let vaultSecrets = {};

  // Try to load secrets from Vault if Vault is enabled and service is provided
  if (env.VAULT_ENABLED === 'true' && vaultService) {
    try {
      await vaultService.initialize();
      vaultSecrets = vaultService.getAllSecrets();
    } catch (error) {
      console.error('[Config] Failed to load secrets from Vault, falling back to environment variables:', error.message);
    }
  }

  // Helper function to get value from Vault first, then environment, then default
  const getSecret = (key, defaultValue = '') => {
    return vaultSecrets[key] !== undefined ? vaultSecrets[key] : (env[key] || defaultValue);
  };

  return {
    port: Number(env.PORT || 3000),
    vaultEnabled: env.VAULT_ENABLED === 'true',
    vault: {
      addr: env.VAULT_ADDR || 'http://vault:8200',
      role: env.VAULT_ROLE || 'substream-backend',
      authPath: env.VAULT_AUTH_PATH || 'auth/kubernetes',
      secretPath: env.VAULT_SECRET_PATH || 'secret/data/substream',
      dbPath: env.VAULT_DB_PATH || 'database/creds/substream-role'
    },
    auth: {
      creatorJwtSecret: getSecret('CREATOR_AUTH_SECRET') || 'development-only-creator-secret',
      issuer: env.CREATOR_AUTH_ISSUER || 'substream-backend',
      audience: env.CREATOR_AUTH_AUDIENCE || 'substream-creators',
      jwtSecret: getSecret('JWT_SECRET') || 'development-only-jwt-secret',
    },
    database: {
      // Use Vault dynamic credentials if available, otherwise use environment or SQLite
      useVault: env.VAULT_ENABLED === 'true' && vaultService,
      filename: env.DATABASE_FILENAME || path.join(process.cwd(), 'data', 'substream-protocol.sqlite'),
      url: env.DATABASE_URL || '',
      encryptionKey: getSecret('DB_ENCRYPTION_KEY') || '',
      maxConnections: Number(env.DB_MAX_CONNECTIONS || 20),
    },
    cdn: {
      baseUrl: env.CDN_BASE_URL || '',
      tokenSecret: getSecret('CDN_TOKEN_SECRET') || 'development-only-cdn-secret',
      tokenTtlSeconds: Number(env.CDN_TOKEN_TTL_SECONDS || 300),
      issuer: env.CDN_TOKEN_ISSUER || 'substream-backend',
      audience: env.CDN_TOKEN_AUDIENCE || 'substream-cdn',
    },
    soroban: {
      rpcUrl: env.SOROBAN_RPC_URL || '',
      networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE || Networks.PUBLIC,
      contractId: env.SOROBAN_CONTRACT_ID || DEFAULT_CONTRACT_ID,
      sourceSecret: getSecret('SOROBAN_SOURCE_SECRET') || '',
      method: env.SOROBAN_SUBSCRIPTION_METHOD || 'has_active_subscription',
      argumentMapping: env.SOROBAN_SUBSCRIPTION_ARGUMENTS || 'address:walletAddress,address:creatorAddress',
    },
    transcoding: {
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      outputDir: env.TRANSCODING_OUTPUT_DIR || './transcoded',
      maxConcurrent: Number(env.MAX_CONCURRENT_TRANSCODINGS || 3),
    },
    redis: {
      host: env.REDIS_HOST || 'localhost',
      port: Number(env.REDIS_PORT || 6379),
      password: getSecret('REDIS_PASSWORD') || '',
      db: Number(env.REDIS_DB || 0),
    },
    aml: {
      enabled: env.AML_ENABLED === 'true',
      scanInterval: Number(env.AML_SCAN_INTERVAL_MS || 24 * 60 * 60 * 1000),
      batchSize: Number(env.AML_BATCH_SIZE || 50),
      maxRetries: Number(env.AML_MAX_RETRIES || 3),
      complianceOfficerEmail: env.COMPLIANCE_OFFICER_EMAIL || '',
      sanctions: {
        ofacApiKey: getSecret('OFAC_API_KEY') || '',
        euSanctionsApiKey: getSecret('EU_SANCTIONS_API_KEY') || '',
        unSanctionsApiKey: getSecret('UN_SANCTIONS_API_KEY') || '',
        ukSanctionsApiKey: getSecret('UK_SANCTIONS_API_KEY') || '',
        cacheTimeout: Number(env.SANCTIONS_CACHE_TIMEOUT_MS || 60 * 60 * 1000),
      }
    },
    ipIntelligence: {
      enabled: env.IP_INTELLIGENCE_ENABLED === 'true',
      providers: {
        ipinfo: {
          enabled: env.IPINFO_ENABLED === 'true',
          apiKey: getSecret('IPINFO_API_KEY') || '',
          timeout: Number(env.IPINFO_TIMEOUT || 5000)
        },
        maxmind: {
          enabled: env.MAXMIND_ENABLED === 'true',
          apiKey: getSecret('MAXMIND_API_KEY') || '',
          timeout: Number(env.MAXMIND_TIMEOUT || 5000)
        },
        abuseipdb: {
          enabled: env.ABUSEIPDB_ENABLED === 'true',
          apiKey: getSecret('ABUSEIPDB_API_KEY') || '',
          timeout: Number(env.ABUSEIPDB_TIMEOUT || 5000)
        },
        ipqualityscore: {
          enabled: env.IPQUALITYSCORE_ENABLED === 'true',
          apiKey: getSecret('IPQUALITYSCORE_API_KEY') || '',
          timeout: Number(env.IPQUALITYSCORE_TIMEOUT || 5000)
        }
      },
      riskThresholds: {
        low: Number(env.IP_RISK_THRESHOLD_LOW || 30),
        medium: Number(env.IP_RISK_THRESHOLD_MEDIUM || 60),
        high: Number(env.IP_RISK_THRESHOLD_HIGH || 80),
        critical: Number(env.IP_RISK_THRESHOLD_CRITICAL || 90)
      },
      cache: {
        enabled: env.IP_CACHE_ENABLED !== 'false',
        ttl: Number(env.IP_CACHE_TTL_MS || 3600000),
        maxSize: Number(env.IP_CACHE_MAX_SIZE || 10000)
      },
      rateLimit: {
        requestsPerMinute: Number(env.IP_RATE_LIMIT_PER_MINUTE || 100),
        burstLimit: Number(env.IP_RATE_LIMIT_BURST || 20)
      }
    },
    s3: env.S3_BUCKET ? {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: getSecret('S3_ACCESS_KEY_ID') || env.S3_ACCESS_KEY_ID,
        secretAccessKey: getSecret('S3_SECRET_ACCESS_KEY') || env.S3_SECRET_ACCESS_KEY,
      },
    } : null,
    ipfs: env.IPFS_HOST ? {
      host: env.IPFS_HOST,
      port: Number(env.IPFS_PORT || 5001),
      protocol: env.IPFS_PROTOCOL || 'http',
    } : null,
    email: {
      sesApiKey: getSecret('SES_API_KEY') || '',
      sendgridApiKey: getSecret('SENDGRID_API_KEY') || '',
    },
    webhook: {
      signingSecret: getSecret('WEBHOOK_SIGNING_SECRET') || '',
    },
    monitoring: {
      sentryDsn: getSecret('SENTRY_DSN') || '',
    },
    behavioralBiometric: {
      enabled: env.BEHAVIORAL_BIOMETRIC_ENABLED === 'true',
      collection: {
        enabled: env.BEHAVIORAL_COLLECTION_ENABLED !== 'false',
        sampleRate: Number(env.BEHAVIORAL_SAMPLE_RATE || 1.0),
        maxEventsPerSession: Number(env.BEHAVIORAL_MAX_EVENTS_PER_SESSION || 1000),
        sessionTimeout: Number(env.BEHAVIORAL_SESSION_TIMEOUT || 30 * 60 * 1000),
        anonymizeIP: env.BEHAVIORAL_ANONYMIZE_IP !== 'false',
        hashSalt: env.BEHAVIORAL_HASH_SALT || crypto.randomBytes(32).toString('hex')
      },
      classifier: {
        enabled: env.BEHAVIORAL_CLASSIFIER_ENABLED !== 'false',
        modelType: env.BEHAVIORAL_MODEL_TYPE || 'rule_based',
        confidenceThreshold: Number(env.BEHAVIORAL_CONFIDENCE_THRESHOLD || 0.7),
        trainingThreshold: Number(env.BEHAVIORAL_TRAINING_THRESHOLD || 100),
        retrainInterval: Number(env.BEHAVIORAL_RETRAIN_INTERVAL || 7 * 24 * 60 * 60 * 1000)
      },
      thresholds: {
        botScoreThreshold: Number(env.BEHAVIORAL_BOT_SCORE_THRESHOLD || 0.8),
        throttlingThreshold: env.BEHAVIORAL_THROTTLING_THRESHOLD || 0.6,
        watchListThreshold: env.BEHAVIORAL_WATCH_LIST_THRESHOLD || 0.9,
        anomalyThreshold: env.BEHAVIORAL_ANOMALY_THRESHOLD || 0.75
      },
      privacy: {
        dataRetentionDays: Number(env.BEHAVIORAL_DATA_RETENTION_DAYS || 30),
        hashPersonalData: env.BEHAVIORAL_HASH_PERSONAL_DATA !== 'false',
        excludePII: env.BEHAVIORAL_EXCLUDE_PII !== 'false',
        gdprCompliant: env.BEHAVIORAL_GDPR_COMPLIANT !== 'false'
      }
    },
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
    substream: {
      baseDomain: env.SUBSTREAM_BASE_DOMAIN || 'substream.app',
      backendUrl: env.SUBSTREAM_BACKEND_URL || 'http://localhost:3000',
      ssl: {
        enabled: env.SUBSTREAM_SSL_ENABLED === 'true',
        caddyConfigPath: env.SUBSTREAM_CADDY_CONFIG_PATH || '/etc/caddy/Caddyfile',
        caddyApiUrl: env.SUBSTREAM_CADDY_API_URL || 'http://localhost:2019',
        certsDir: env.SUBSTREAM_CERTS_DIR || '/etc/caddy/certs',
        testMode: env.SUBSTREAM_SSL_TEST_MODE === 'true',
        useApi: env.SUBSTREAM_CADDY_USE_API === 'true',
      },
    },
    ssl: {
      letsEncryptEmail: env.LETS_ENCRYPT_EMAIL || 'admin@substream.app',
      caddyConfigPath: env.CADDY_CONFIG_PATH || '/etc/caddy/Caddyfile',
      caddyApiUrl: env.CADDY_API_URL || 'http://localhost:2019',
      certsDir: env.CERTS_DIR || '/etc/caddy/certs',
      testMode: env.SSL_TEST_MODE === 'true',
      useApi: env.CADDY_USE_API === 'true',
    },
  };
}

/**
 * Synchronous version of loadConfig for backward compatibility.
 * Does not load from Vault.
 */
function loadConfigSync(env = process.env) {
  return loadConfig(env, null);
}

module.exports = {
  DEFAULT_CONTRACT_ID,
  loadConfig,
  loadConfigSync,
};
