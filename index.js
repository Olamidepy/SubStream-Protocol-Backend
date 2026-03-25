const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
require('dotenv').config();
dotenv.config();

const { AppDatabase } = require('./src/db/appDatabase');
const { loadConfig } = require('./src/config');
const { CdnTokenService, TokenValidationError } = require('./src/services/cdnTokenService');
const { CreatorActionService } = require('./src/services/creatorActionService');
const { CreatorAuditLogService } = require('./src/services/creatorAuditLogService');
const { CreatorAuthService } = require('./src/services/creatorAuthService');
const { SorobanSubscriptionVerifier } = require('./src/services/sorobanSubscriptionVerifier');
const { SubscriptionService } = require('./src/services/subscriptionService');
const { buildAuditLogCsv } = require('./src/utils/export/auditLogCsv');
const { buildAuditLogPdf } = require('./src/utils/export/auditLogPdf');
const { getRequestIp } = require('./src/utils/requestIp');

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
  const subscriptionService =
    dependencies.subscriptionService || new SubscriptionService({ database, auditLogService });

  // expose the service on the express app so external routers can access it
  app.set('subscriptionService', subscriptionService);

  app.use(cors());
  app.use(express.json());
  // Subscription events webhook
  app.use('/api/subscription', require('./routes/subscription'));

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

  app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

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
  app.listen(port, () => console.log(`SubStream API running on port ${port}`));
}

module.exports = app;
module.exports.createApp = createApp;
