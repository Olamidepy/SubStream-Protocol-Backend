require('dotenv').config();

const cors = require('cors');
const express = require('express');

const { loadConfig } = require('./src/config');
const { CdnTokenService, TokenValidationError } = require('./src/services/cdnTokenService');
const { SorobanSubscriptionVerifier } = require('./src/services/sorobanSubscriptionVerifier');

function createApp(dependencies = {}) {
  const app = express();
  const config = dependencies.config || loadConfig();
  const subscriptionVerifier =
    dependencies.subscriptionVerifier || new SorobanSubscriptionVerifier(config);
  const tokenService = dependencies.tokenService || new CdnTokenService(config);

  app.use(cors());
  app.use(express.json());

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

  return app;
}

function extractToken(req) {
  const authHeader = req.headers.authorization || '';

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return req.query.token || req.body?.token || null;
}

const app = createApp();
const port = Number(process.env.PORT || 3000);

if (require.main === module) {
  app.listen(port, () => console.log(`SubStream API running on port ${port}`));
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/content', require('./routes/content'));
app.use('/analytics', require('./routes/analytics'));
app.use('/storage', require('./routes/storage'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      auth: 'active',
      content: 'active',
      analytics: 'active',
      storage: 'active'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    project: 'SubStream Protocol', 
    status: 'Active', 
    contract: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
    version: '1.0.0',
    endpoints: {
      auth: '/auth',
      content: '/content',
      analytics: '/analytics',
      storage: '/storage',
      health: '/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`SubStream API running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
  });
}

module.exports = app;
module.exports.createApp = createApp;
