# SubStream Protocol Backend

A comprehensive backend API for the SubStream Protocol, supporting wallet-based authentication, tier-based content access, real-time analytics, and multi-region storage replication.

## Features

### 🔐 Authentication (SIWE)
- Wallet-based authentication using Sign In With Ethereum
- JWT token generation and validation
- Nonce-based security
- Multi-tier user support (Bronze, Silver, Gold)

### 📊 Real-time Analytics
- View-time event aggregation
- On-chain withdrawal event tracking
- Heatmap generation for content engagement
- Server-sent events for real-time updates
- Creator analytics dashboard

### 🌍 Multi-Region Storage
- IPFS content replication across multiple services
- Automatic failover between regions
- Health monitoring and service recovery
- Support for Pinata, Web3.Storage, and Infura

### 🛡️ Tier-Based Access Control
- Content filtering based on user subscription tier
- Censored previews for unauthorized content
- Database-level access control
- Upgrade suggestions and tier management

## Quick Start

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone https://github.com/jobbykings/SubStream-Protocol-Backend.git
cd SubStream-Protocol-Backend
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment variables:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
- Set your JWT secret
- Add IPFS service API keys
- Configure database connections (optional for development)

5. Start the server:
```bash
# Development
npm run dev

# Production
npm start
```

The API will be available at `http://localhost:3000`

## API Endpoints

### Authentication
- `GET /auth/nonce?address={address}` - Get nonce for SIWE
- `POST /auth/login` - Authenticate with wallet signature

### Content
- `GET /content` - List content (filtered by user tier)
- `GET /content/{id}` - Get specific content
- `POST /content` - Create new content (requires authentication)
- `PUT /content/{id}` - Update content (creator only)
- `DELETE /content/{id}` - Delete content (creator only)
- `GET /content/{id}/access` - Check access permissions
- `GET /content/upgrade/suggestions` - Get upgrade suggestions

### Analytics
- `POST /analytics/view-event` - Record view-time event
- `POST /analytics/withdrawal-event` - Record withdrawal event
- `GET /analytics/heatmap/{videoId}` - Get content heatmap
- `GET /analytics/creator/{address}` - Get creator analytics
- `GET /analytics/stream/{videoId}` - Real-time analytics stream

### Storage
- `POST /storage/pin` - Pin content to multiple regions
- `GET /storage/content/{id}` - Get content with failover
- `GET /storage/metadata/{id}` - Get content metadata
- `GET /storage/health` - Check storage service health
- `GET /storage/url/{id}` - Get content URLs

### System
- `GET /` - API information
- `GET /health` - Health check

## Usage Examples

### Authentication
```javascript
// 1. Get nonce
const nonceResponse = await fetch('/auth/nonce?address=0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');
const { nonce } = await nonceResponse.json();

// 2. Sign message with wallet
const message = `Sign in to SubStream Protocol at ${new Date().toISOString()}\n\nNonce: ${nonce}\nAddress: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45`;
const signature = await signer.signMessage(message);

// 3. Login
const loginResponse = await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, signature, message, nonce })
});
const { token } = await loginResponse.json();
```

### Content Access
```javascript
// Get content list (automatically filtered by tier)
const response = await fetch('/content', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { content } = await response.json();

// Content will be full or censored based on user tier
```

### Analytics
```javascript
// Record view event
await fetch('/analytics/view-event', {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    videoId: 'video_001',
    watchTime: 120,
    totalDuration: 300
  })
});

// Get heatmap
const heatmapResponse = await fetch('/analytics/heatmap/video_001', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## Architecture

### Services
- **AuthService**: Handles SIWE authentication and JWT management
- **ContentService**: Manages content with tier-based filtering
- **AnalyticsService**: Processes real-time analytics and generates heatmaps
- **StorageService**: Manages multi-region IPFS replication

### Middleware
- **Authentication**: JWT token validation
- **Tier Access**: Role-based access control
- **Error Handling**: Centralized error management

### Data Flow
1. User authenticates via wallet signature
2. JWT token issued with tier information
3. All subsequent requests include token
4. Content filtered based on user tier
5. Analytics events tracked in real-time
6. Content replicated across multiple regions

## Environment Variables

See `.env.example` for all available configuration options.

## Development

### Running Tests
```bash
npm test
```

### Project Structure
```
├── routes/          # API route handlers
├── middleware/      # Express middleware
├── services/        # Business logic services
├── docs/           # API documentation
├── tests/          # Test files
└── index.js        # Main application entry
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions, please open an issue on GitHub.
