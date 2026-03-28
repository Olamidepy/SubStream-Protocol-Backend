const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
require('dotenv').config();
dotenv.config();

// Initialize structured logging and error tracking
const { logger, requestTracingMiddleware } = require('./src/utils/logger');
const { errorTracking } = require('./src/utils/errorTracking');

// Initialize error tracking
errorTracking.initialize();

const { AppDatabase } = require('./src/db/appDatabase');
const { loadConfig } = require('./src/config');
const { CdnTokenService, TokenValidationError } = require('./src/services/cdnTokenService');
const { CreatorActionService } = require('./src/services/creatorActionService');
const { CreatorAuditLogService } = require('./src/services/creatorAuditLogService');
const { CreatorAuthService } = require('./src/services/creatorAuthService');
const { SorobanSubscriptionVerifier } = require('./src/services/sorobanSubscriptionVerifier');
const { SubscriptionService } = require('./src/services/subscriptionService');
const { SubscriptionExpiryChecker } = require('./src/services/subscriptionExpiryChecker');
const VideoProcessingWorker = require('./src/services/videoProcessingWorker');
const { BackgroundWorkerService } = require('./src/services/backgroundWorkerService');
const GlobalStatsService = require('./src/services/globalStatsService');
const GlobalStatsWorker = require('./src/services/globalStatsWorker');
const EngagementLeaderboardService = require('./services/engagementLeaderboardService');
const LeaderboardWorker = require('./src/services/leaderboardWorker');
const createVideoRoutes = require('./routes/video');
const createGlobalStatsRouter = require('./routes/globalStats');
const createDeviceRoutes = require('./routes/device');
const createSwaggerRoutes = require('./routes/swagger');
const createLeaderboardRoutes = require('./routes/leaderboard');
const { buildAuditLogCsv } = require('./src/utils/export/auditLogCsv');
const { buildAuditLogPdf } = require('./src/utils/export/auditLogPdf');
const { getRequestIp } = require('./src/utils/requestIp');
const { getRedisClient, closeRedisClient } = require('./src/config/redis');
const { createRateLimiter } = require('./middleware/rateLimiter');


/**
 * Create the Express application with injectable services for testing.
 *
 * @param {object} [dependencies={}] Optional service overrides.
 * @returns {import('express').Express}
 */
function createApp(dependencies = {}) {
  const app = express();
  const config = dependencies.config || loadConfig();
  const database = dependencies.database || new AppDatabase(config.database.filename);

  const auditLogService = dependencies.auditLogService || new CreatorAuditLogService(database);
  const creatorActionService =
    dependencies.creatorActionService || new CreatorActionService(database, auditLogService);
  const creatorAuthService = dependencies.creatorAuthService || new CreatorAuthService(config);
  const subscriptionVerifier =
    dependencies.subscriptionVerifier || new SorobanSubscriptionVerifier(config);
  const tokenService = dependencies.tokenService || new CdnTokenService(config);

  // Notification and email utilities
  const { NotificationService } = require('./src/services/notificationService');
  const { sendEmail } = require('./src/utils/email');
  const notificationService = dependencies.notificationService || new NotificationService(database);

  const subscriptionService =
    dependencies.subscriptionService || new SubscriptionService({
      database,
      auditLogService,
      notificationService,
      emailUtil: { sendEmail },
    });
  dependencies.subscriptionService || new SubscriptionService({ database, auditLogService, config });
  const subscriptionExpiryChecker =
    dependencies.subscriptionExpiryChecker ||
    new SubscriptionExpiryChecker({
      database,
      lowBalanceEmailService: dependencies.lowBalanceEmailService,
    });

  // Initialize background worker service for async processing
  const backgroundWorker = dependencies.backgroundWorker || new BackgroundWorkerService(config.rabbitmq);

  // expose the service on the express app so external routers can access it
  app.set('subscriptionService', subscriptionService);
  app.set('subscriptionExpiryChecker', subscriptionExpiryChecker);
  app.set('backgroundWorker', backgroundWorker);

  // Start federation worker if ActivityPub is enabled
  if (config.activityPub?.enabled !== false) {
    const federationWorker = dependencies.federationWorker || new FederationWorker(database, config);
    federationWorker.start().catch(error => {
      console.error('Failed to start federation worker:', error);
    });
  }

  // Start leaderboard worker if enabled
  if (config.leaderboard?.enabled !== false) {
    const leaderboardWorker = dependencies.leaderboardWorker || new LeaderboardWorker(config, database, getRedisClient(), EngagementLeaderboardService);
    leaderboardWorker.start().catch(error => {
      console.error('Failed to start leaderboard worker:', error);
    });
  }

  const dayInMs = 24 * 60 * 60 * 1000;
  const subscriptionExpiryCheckerInterval = setInterval(async () => {
    try {
      await subscriptionExpiryChecker.runDailyCheck();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        'Subscription expiry checker failed:',
        error && error.message ? error.message : error,
      );
    }
  }, dayInMs);

  if (typeof subscriptionExpiryCheckerInterval.unref === 'function') {
    subscriptionExpiryCheckerInterval.unref();
  }

  app.set('subscriptionExpiryCheckerInterval', subscriptionExpiryCheckerInterval);

  const videoWorker = dependencies.videoWorker || new VideoProcessingWorker(config, database);

  // Initialize global stats service and worker
  const globalStatsService = dependencies.globalStatsService || new GlobalStatsService(database);
  const globalStatsWorker = dependencies.globalStatsWorker || new GlobalStatsWorker(database, {
    refreshInterval: process.env.GLOBAL_STATS_REFRESH_INTERVAL ? parseInt(process.env.GLOBAL_STATS_REFRESH_INTERVAL) : 60000,
    initialDelay: process.env.GLOBAL_STATS_INITIAL_DELAY ? parseInt(process.env.GLOBAL_STATS_INITIAL_DELAY) : 5000
  });

  // Initialize leaderboard service and worker
  const redisClient = getRedisClient();
  const leaderboardService = dependencies.leaderboardService || new EngagementLeaderboardService(config, database, redisClient);
  const leaderboardWorker = dependencies.leaderboardWorker || new LeaderboardWorker(config, database, redisClient, leaderboardService);

  // Initialize subdomain and SSL services
  const subdomainService = dependencies.subdomainService || new SubdomainService(database, config);
  const sslCertificateService = dependencies.sslCertificateService || new SslCertificateService(config);
  const subdomainMiddleware = dependencies.subdomainMiddleware || new SubdomainMiddleware(database, config);

  // expose services on the express app so external routers can access them
  app.set('subscriptionService', subscriptionService);
  app.set('subscriptionExpiryChecker', subscriptionExpiryChecker);
  app.set('backgroundWorker', backgroundWorker);
  app.set('globalStatsService', globalStatsService);
  app.set('globalStatsWorker', globalStatsWorker);
  app.set('leaderboardService', leaderboardService);
  app.set('leaderboardWorker', leaderboardWorker);
  app.set('subdomainService', subdomainService);
  app.set('sslCertificateService', sslCertificateService);

  // Initialize and start predictive churn analysis worker
  const { PredictiveChurnAnalysisWorker } = require('./src/services/predictiveChurnAnalysisWorker');
  const churnAnalysisWorker = dependencies.churnAnalysisWorker || new PredictiveChurnAnalysisWorker(database, {
    checkInterval: process.env.CHURN_ANALYSIS_INTERVAL ? parseInt(process.env.CHURN_ANALYSIS_INTERVAL) : 3600000,
  });
  app.set('churnAnalysisWorker', churnAnalysisWorker);
  churnAnalysisWorker.start().catch(error => {
    console.error('Failed to start PredictiveChurnAnalysisWorker:', error);
  });

  // Start global stats worker
  globalStatsWorker.start().catch(error => {
    console.error('Failed to start global stats worker:', error);
  });

  app.use(cors());
  app.use(express.json());


  // Subscription events webhook
  app.use('/api/subscription', require('./routes/subscription'));
  // Payouts API
  app.use('/api/payouts', require('./routes/payouts'));

  // Global stats endpoints
  app.use('/api/global-stats', createGlobalStatsRouter({ database, globalStatsService }));

  // Subdomain management endpoints
  app.use('/api/subdomains', createSubdomainRoutes({ database, config, subdomainService, sslCertificateService }));

  // Price feed endpoints
  const createPriceRouter = require('./routes/price');
  app.use('/api/price-feed', createPriceRouter());

  // Engagement leaderboard endpoints
  app.use('/api/leaderboard', createLeaderboardRoutes());

  app.use((req, res, next) => {
    req.config = config;
    req.database = database;
    req.subscriptionVerifier = subscriptionVerifier;
    next();
  });

  // Leaky-bucket rate limiting per wallet address (requires Redis).
  if (dependencies.rateLimiter) {
    app.use('/api', dependencies.rateLimiter);
  } else if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    app.use('/api', createRateLimiter({
      redis: getRedisClient(),
      bucketCapacity: Number(process.env.RATE_LIMIT_CAPACITY || 60),
      leakRatePerSecond: Number(process.env.RATE_LIMIT_LEAK_RATE || 1),
      blockDurationSeconds: Number(process.env.RATE_LIMIT_BLOCK_SECONDS || 300),
      sybilThreshold: Number(process.env.SYBIL_THRESHOLD || 3),
    }));
  }

  app.get('/', (req, res) => {
    res.json({
      project: 'SubStream Protocol',
      status: 'Active',
      contract: config.soroban.contractId,
    });
  });

  app.post('/api/cdn/token', async (req, res) => {
    const requiredFields = ['walletAddress', 'creatorAddress', 'contentId', 'segmentPath'];
    const missingFields = requiredFields.filter((field) => !req.body?.[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        missingFields,
      });
    }

    try {
      const accessRequest = {
        walletAddress: req.body.walletAddress,
        creatorAddress: req.body.creatorAddress,
        contentId: req.body.contentId,
        segmentPath: req.body.segmentPath,
      };

      const subscription = await subscriptionVerifier.verifySubscription(accessRequest);

      if (!subscription.active) {
        return res.status(403).json({
          error: 'Active on-chain subscription required',
          creatorAddress: accessRequest.creatorAddress,
          contentId: accessRequest.contentId,
        });
      }

      const issuedToken = tokenService.issueToken({
        walletAddress: accessRequest.walletAddress,
        creatorAddress: accessRequest.creatorAddress,
        contentId: accessRequest.contentId,
        segmentPath: accessRequest.segmentPath,
        subscription,
      });

      return res.status(200).json({
        token: issuedToken.token,
        tokenType: 'Bearer',
        expiresInSeconds: issuedToken.expiresInSeconds,
        expiresAt: issuedToken.expiresAt,
        playbackUrl: tokenService.buildPlaybackUrl({
          contentId: accessRequest.contentId,
          segmentPath: accessRequest.segmentPath,
          token: issuedToken.token,
        }),
      });
    } catch (error) {
      return res.status(error.statusCode || 503).json({
        error: error.message || 'Unable to verify subscription',
      });
    }
  });

  app.all('/api/cdn/validate', (req, res) => {
    const token = extractToken(req);

    if (!token) {
      return res.status(400).json({ error: 'Missing CDN access token' });
    }

    try {
      const decoded = tokenService.verifyToken(token, {
        contentId: req.query.contentId || req.body?.contentId,
        segmentPath: req.query.segmentPath || req.body?.segmentPath,
      });

      return res.status(200).json({
        valid: true,
        expiresAt: new Date(decoded.exp * 1000).toISOString(),
        claims: {
          walletAddress: decoded.sub,
          creatorAddress: decoded.creatorAddress,
          contentId: decoded.contentId,
          segmentPath: decoded.segmentPath,
        },
      });
    } catch (error) {
      const statusCode = error instanceof TokenValidationError ? 401 : 400;
      return res.status(statusCode).json({
        valid: false,
        error: error.message || 'Invalid CDN access token',
      });
    }
  });

  app.patch('/api/creator/flow-rate', requireCreatorAuth(creatorAuthService), async (req, res) => {
    if (!isPresent(req.body?.flowRate)) {
      return res.status(400).json({ success: false, error: 'flowRate is required' });
    }

    try {
      const result = creatorActionService.updateFlowRate({
        creatorId: req.creator.id,
        flowRate: normalizeScalar(req.body.flowRate),
        currency: isPresent(req.body.currency) ? String(req.body.currency) : null,
        ipAddress: getRequestIp(req),
      });

      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return handleActionError(res, error);
    }
  });

  app.patch(
    '/api/creator/videos/:videoId/visibility',
    requireCreatorAuth(creatorAuthService),
    async (req, res) => {
      if (!isPresent(req.body?.visibility)) {
        return res.status(400).json({ success: false, error: 'visibility is required' });
      }

      try {
        const result = creatorActionService.updateVideoVisibility({
          creatorId: req.creator.id,
          videoId: req.params.videoId,
          visibility: String(req.body.visibility),
          ipAddress: getRequestIp(req),
        });

        return res.status(200).json({ success: true, data: result });
      } catch (error) {
        return handleActionError(res, error);
      }
    },
  );

  app.patch(
    '/api/creator/coop-splits/:splitId',
    requireCreatorAuth(creatorAuthService),
    async (req, res) => {
      if (!req.body?.splits || !Array.isArray(req.body.splits) || req.body.splits.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: 'splits must be a non-empty array' });
      }

      try {
        const result = creatorActionService.updateCoopSplit({
          creatorId: req.creator.id,
          splitId: req.params.splitId,
          splits: req.body.splits,
          ipAddress: getRequestIp(req),
        });

        return res.status(200).json({ success: true, data: result });
      } catch (error) {
        return handleActionError(res, error);
      }
    },
  );

  app.get('/api/creator/audit-log', requireCreatorAuth(creatorAuthService), (req, res) => {
    const logs = auditLogService.listByCreatorId(req.creator.id);
    return res.status(200).json({ success: true, data: logs });
  });

  // Get creator stats (including cached subscriber count)
  app.get('/api/creator/:id/stats', (req, res) => {
    try {
      const creatorId = req.params.id;
      const subscriberCount = database.getCreatorSubscriberCount(creatorId);

      return res.status(200).json({ success: true, data: { creatorId, subscriberCount } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch stats' });
    }
  });

  app.get('/api/creator/audit-log/export', requireCreatorAuth(creatorAuthService), (req, res) => {
    const format = String(req.query.format || '').toLowerCase();

    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be one of: csv, pdf',
      });
    }

    const logs = auditLogService.listByCreatorId(req.creator.id);
    const exportTimestamp = new Date().toISOString();

    if (format === 'csv') {
      const csv = buildAuditLogCsv(logs);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="creator-audit-log-${req.creator.id}.csv"`,
      );
      return res.status(200).send(csv);
    }

    const pdf = buildAuditLogPdf({
      creatorId: req.creator.id,
      exportedAt: exportTimestamp,
      logs,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="creator-audit-log-${req.creator.id}.pdf"`,
    );
    return res.status(200).send(pdf);
  });

  app.use('/api/videos', createVideoRoutes(config, database, videoWorker));

  // Device fingerprinting endpoints for fraud prevention
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    const deviceService = new DeviceFingerprintService(getRedisClient());
    app.set('deviceFingerprintService', deviceService);
    app.use('/api/device', createDeviceRoutes);
  }

  // API Documentation with Swagger UI
  app.use('/api/docs', createSwaggerRoutes);

  // Health check endpoint
  app.get('/health', async (req, res) => {
    const health = {
      status: 'Healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: 'Unknown',
        redis: 'Unknown',
        rabbitmq: 'Unknown',
        stellar: 'Unknown',
      },
    };

    let isDegraded = false;

    // Check Database
    try {
      database.db.prepare('SELECT 1').get();
      health.services.database = 'Connected';
    } catch (error) {
      health.services.database = 'Offline';
      isDegraded = true;
    }

    // Check Redis
    try {
      if (process.env.REDIS_URL || process.env.REDIS_HOST) {
        const redisClient = getRedisClient();
        const ping = await redisClient.ping();
        health.services.redis = ping === 'PONG' ? 'Connected' : 'Offline';
        if (ping !== 'PONG') isDegraded = true;
      } else {
        health.services.redis = 'Not Configured';
      }
    } catch (error) {
      health.services.redis = 'Offline';
      isDegraded = true;
    }

    // Check RabbitMQ
    try {
      if (backgroundWorker && backgroundWorker.rabbitmq) {
        const status = backgroundWorker.getStatus();
        health.services.rabbitmq = status.connected ? 'Connected' : 'Offline';
        if (!status.connected) isDegraded = true;
      } else {
        health.services.rabbitmq = 'Not Configured';
      }
    } catch (error) {
      health.services.rabbitmq = 'Offline';
      isDegraded = true;
    }

    // Check Stellar/Soroban
    try {
      if (subscriptionVerifier && subscriptionVerifier.server) {
        await subscriptionVerifier.server.getLatestLedger();
        health.services.stellar = 'Connected';
      } else {
        health.services.stellar = 'Not Configured';
      }
    } catch (error) {
      health.services.stellar = 'Offline';
      isDegraded = true;
    }

    if (isDegraded) {
      health.status = 'Degraded';
    }

    return res.status(isDegraded ? 200 : 200).json(health); // Reporting degraded status still returns 200 for status page transparency
  });

  app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

  // Global error handler with Sentry integration
  app.use((err, req, res, next) => {
    // Log error with structured logging
    const errorContext = {
      traceId: req.logger?.fields?.traceId,
      method: req.method,
      path: req.path,
      walletAddress: req.user?.publicKey || req.body?.walletAddress,
      endpoint: req.originalUrl,
    };

    // Capture with Sentry
    errorTracking.captureException(err, errorContext);

    // Return error response
    res.status(err.statusCode || err.status || 500).json({
      success: false,
      error: process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    });
  });

  return app;
}

/**
 * Read a bearer token from the request.
 *
 * @param {import('express').Request} req The current request.
 * @returns {string|null}
 */
function extractToken(req) {
  const authHeader = req.headers.authorization || '';

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return req.query.token || req.body?.token || null;
}

/**
 * Build creator auth middleware from the configured auth service.
 *
 * @param {CreatorAuthService} creatorAuthService Authentication service.
 * @returns {import('express').RequestHandler}
 */
function requireCreatorAuth(creatorAuthService) {
  return (req, res, next) => {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    try {
      req.creator = creatorAuthService.verifyToken(token);
      return next();
    } catch (error) {
      return res.status(401).json({ success: false, error: error.message });
    }
  };
}

/**
 * Normalize scalar request values to strings for durable storage.
 *
 * @param {string|number|boolean} value The value to normalize.
 * @returns {string}
 */
function normalizeScalar(value) {
  return String(value).trim();
}

/**
 * Check whether a value is present in a request body.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean}
 */
function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Send a consistent JSON error payload for creator actions.
 *
 * @param {import('express').Response} res The response object.
 * @param {Error & {statusCode?: number}} error The thrown error.
 * @returns {import('express').Response}
 */
function handleActionError(res, error) {
  return res
    .status(error.statusCode || 500)
    .json({ success: false, error: error.message || 'Request failed' });
}

const app = createApp();
const port = Number(process.env.PORT || 3000);

if (require.main === module) {
  app.listen(port, () => {
    console.log(`SubStream API running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
  });
}

module.exports = app;
module.exports.createApp = createApp;

