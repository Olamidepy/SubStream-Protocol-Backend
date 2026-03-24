const express = require('express');
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
app.use('/posts', require('./routes/posts'));

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
      storage: 'active',
      posts: 'active'
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
      posts: '/posts',
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
