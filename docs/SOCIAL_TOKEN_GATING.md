# Social Token Holder Exclusive Feeds API

## Overview

The Social Token Holder Exclusive Feeds system enables creators to gate content based on Stellar Asset holdings, creating a "binary gate" that provides long-term "skin in the game" investment opportunities for fan communities. Unlike per-second streaming payments, this system verifies minimum token holdings and periodically re-checks balances during content consumption.

## Features

- **Binary Content Gating**: Access granted/revoked based on minimum token holdings
- **Stellar Asset Integration**: Support for any Stellar Asset (custom tokens)
- **Periodic Re-verification**: Automatic balance checks during content consumption
- **Real-time Session Management**: WebSocket-based monitoring for instant revocation
- **Performance Optimized**: Redis caching with 5-minute TTL for balance checks
- **Comprehensive Analytics**: Access tracking and token usage statistics
- **Creator Controls**: Full API for managing gated content and requirements

## Architecture

### Core Components

1. **SocialTokenGatingService** (`services/socialTokenGatingService.js`)
   - Stellar Asset balance verification
   - Content gating requirements management
   - Session management for re-verification
   - Redis caching for performance optimization

2. **SocialTokenGatingMiddleware** (`middleware/socialTokenGating.js`)
   - Express middleware for access control
   - Real-time balance re-verification
   - WebSocket session management
   - Session cleanup and monitoring

3. **Social Token API** (`routes/socialToken.js`)
   - Content gating management endpoints
   - Token balance verification
   - Session management
   - Analytics and statistics

### Database Schema

- `social_token_gated_content`: Content gating requirements
- `social_token_sessions`: Active re-verification sessions
- `social_token_access_logs`: Access attempt analytics
- `content`: Extended with social token metadata

## Binary Gating Logic

The system implements a binary access model:

```
User Token Balance >= Minimum Required Balance → ACCESS GRANTED
User Token Balance < Minimum Required Balance → ACCESS DENIED
```

### Periodic Re-verification

- **Default Interval**: 1 minute (configurable)
- **Session-based Tracking**: Each viewing session monitored independently
- **Instant Revocation**: Access terminated immediately if balance drops
- **WebSocket Integration**: Real-time notifications for balance changes

## API Endpoints

### Content Gating Management

#### Set Social Token Gating (Creator Only)
```http
POST /api/social-token/gating
```

**Request Body:**
```json
{
  "contentId": "content-123",
  "assetCode": "FANTOKEN",
  "assetIssuer": "GABC...XYZ",
  "minimumBalance": "1000.0000000",
  "verificationInterval": 60000
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "contentId": "content-123",
    "gating": {
      "assetCode": "FANTOKEN",
      "assetIssuer": "GABC...XYZ",
      "minimumBalance": 1000.0,
      "verificationInterval": 60000,
      "active": true
    },
    "message": "Social token gating enabled successfully"
  }
}
```

#### Update Gating Requirements
```http
PUT /api/social-token/gating/:contentId
```

#### Remove Gating
```http
DELETE /api/social-token/gating/:contentId
```

#### Get Gating Requirements
```http
GET /api/social-token/gating/:contentId
```

### Access Verification

#### Check Content Access
```http
GET /api/social-token/access/:contentId
```

**Response:**
```json
{
  "success": true,
  "data": {
    "contentId": "content-123",
    "userAddress": "GDEF...XYZ",
    "accessResult": {
      "hasAccess": true,
      "requiresToken": true,
      "assetCode": "FANTOKEN",
      "assetIssuer": "GABC...XYZ",
      "minimumBalance": 1000.0,
      "reason": "Sufficient tokens"
    }
  }
}
```

### Session Management

#### Start Re-verification Session
```http
POST /api/social-token/session
```

**Request Body:**
```json
{
  "contentId": "content-123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "st_550e8400-e29b-41d4-a716-446655440000",
    "contentId": "content-123",
    "userAddress": "GDEF...XYZ",
    "requiresReverification": true,
    "verificationInterval": 60000,
    "assetInfo": {
      "code": "FANTOKEN",
      "issuer": "GABC...XYZ",
      "minimumBalance": 1000.0
    }
  }
}
```

#### Re-verify Balance
```http
POST /api/social-token/session/:sessionId/verify
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "st_550e8400-e29b-41d4-a716-446655440000",
    "stillValid": true,
    "contentId": "content-123",
    "verifiedAt": "2024-03-15T12:00:00.000Z"
  }
}
```

#### End Session
```http
DELETE /api/social-token/session/:sessionId
```

### Asset Management

#### Validate Stellar Asset
```http
POST /api/social-token/validate-asset
```

**Request Body:**
```json
{
  "assetCode": "FANTOKEN",
  "assetIssuer": "GABC...XYZ"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "assetCode": "FANTOKEN",
    "assetIssuer": "GABC...XYZ",
    "exists": true,
    "validatedAt": "2024-03-15T12:00:00.000Z"
  }
}
```

#### Get User Token Holdings
```http
GET /api/social-token/tokens/:assetCode/:assetIssuer
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userAddress": "GDEF...XYZ",
    "assetCode": "FANTOKEN",
    "assetIssuer": "GABC...XYZ",
    "balance": 1500.0,
    "checkedAt": "2024-03-15T12:00:00.000Z"
  }
}
```

### Analytics

#### Get Creator Statistics (Creator Only)
```http
GET /api/social-token/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "creatorAddress": "GABC...XYZ",
    "gatedContentCount": 5,
    "totalAttempts": 1250,
    "successfulAttempts": 1180,
    "uniqueUsers": 850,
    "successRate": 94.4,
    "topTokens": [
      {
        "assetCode": "FANTOKEN",
        "assetIssuer": "GABC...XYZ",
        "usageCount": 800,
        "successRate": 95.2
      }
    ]
  }
}
```

#### Get System Statistics (Admin Only)
```http
GET /api/social-token/admin/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "activeSessions": {
      "webSocket": 45,
      "database": 52,
      "total": 97
    },
    "accessAttempts": {
      "last24Hours": {
        "total": 2500,
        "successful": 2350,
        "successRate": 94.0,
        "uniqueUsers": 1200,
        "gatedContent": 25
      }
    },
    "topAssets": [
      {
        "assetCode": "FANTOKEN",
        "assetIssuer": "GABC...XYZ",
        "usage_count": 1500,
        "success_rate": 94.5
      }
    ],
    "generatedAt": "2024-03-15T12:00:00.000Z"
  }
}
```

## Integration with CDN Token System

The social token gating integrates seamlessly with the existing CDN token system:

### Enhanced Token Request

When requesting a CDN token for gated content:

```http
POST /api/cdn/token
{
  "walletAddress": "GDEF...XYZ",
  "creatorAddress": "GABC...XYZ",
  "contentId": "content-123",
  "segmentPath": "video/segment1.ts"
}
```

**Enhanced Response with Social Token Session:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "expiresInSeconds": 3600,
  "expiresAt": "2024-03-15T13:00:00.000Z",
  "playbackUrl": "https://cdn.example.com/video/segment1.ts?token=...",
  "socialTokenSession": {
    "sessionId": "st_550e8400-e29b-41d4-a716-446655440000",
    "verificationInterval": 60000,
    "assetInfo": {
      "code": "FANTOKEN",
      "issuer": "GABC...XYZ",
      "minimumBalance": 1000.0
    }
  }
}
```

### Access Denied Response

```json
{
  "error": "Social token requirements not met",
  "code": "INSUFFICIENT_SOCIAL_TOKENS",
  "details": {
    "assetCode": "FANTOKEN",
    "assetIssuer": "GABC...XYZ",
    "minimumBalance": 1000.0,
    "reason": "Insufficient tokens"
  }
}
```

## WebSocket Integration

### Real-time Balance Monitoring

For enhanced user experience, the system supports WebSocket-based real-time monitoring:

```javascript
// Connect to WebSocket
const ws = new WebSocket('wss://api.substream.protocol/social-token/ws');

// Send session data
ws.send(JSON.stringify({
  type: 'connect',
  sessionId: 'st_550e8400-e29b-41d4-a716-446655440000',
  userAddress: 'GDEF...XYZ',
  contentId: 'content-123'
}));

// Listen for events
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'access_verified':
      console.log('Access still valid');
      break;
    case 'access_revoked':
      console.log('Access revoked - insufficient tokens');
      // Stop playback and show message
      break;
    case 'verification_error':
      console.log('Verification failed');
      break;
  }
};
```

### WebSocket Events

- **access_verified**: Balance still sufficient
- **access_revoked**: Balance insufficient, access terminated
- **session_expired**: Session expired due to time limit
- **verification_error**: Temporary verification failure
- **session_terminated**: Admin terminated session

## Configuration

### Environment Variables

```bash
# Social Token Gating Configuration
SOCIAL_TOKEN_ENABLED=true                    # Enable/disable social token gating
SOCIAL_TOKEN_CACHE_TTL=300                  # Balance cache TTL in seconds (5 minutes)
SOCIAL_TOKEN_REVERIFICATION_INTERVAL=60000   # Re-verification interval in milliseconds (1 minute)
SOCIAL_TOKEN_CACHE_PREFIX=social_token:      # Redis key prefix
STELLAR_MAX_RETRIES=3                        # Maximum retries for Stellar API calls
STELLAR_RETRY_DELAY=1000                     # Delay between retries in milliseconds
```

### Stellar Network Configuration

```bash
# Stellar Network Settings
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
STELLAR_HORIZON_URL=https://horizon.stellar.org
```

## Performance Optimizations

### Caching Strategy

- **Balance Caching**: 5-minute TTL for Stellar balance queries
- **Session Caching**: In-memory session tracking with Redis persistence
- **Asset Validation**: Cached asset existence verification
- **Request Deduplication**: Prevent duplicate balance checks

### Stellar API Optimization

- **Exponential Backoff**: Retry logic with increasing delays
- **Request Batching**: Group multiple balance checks when possible
- **Connection Pooling**: Reuse HTTP connections to Stellar Horizon
- **Error Handling**: Graceful degradation for Stellar network issues

### Database Optimization

```sql
-- Optimized indexes for performance
CREATE INDEX idx_gated_content_creator ON social_token_gated_content(creator_address, active);
CREATE INDEX idx_sessions_user_valid ON social_token_sessions(user_address, still_valid);
CREATE INDEX idx_access_logs_content_time ON social_token_access_logs(content_id, created_at);
CREATE INDEX idx_sessions_last_verified ON social_token_sessions(last_verified);
```

## Use Cases

### Creator Fan Communities

1. **Token-Based Access Control**: Fans must hold creator's token to access exclusive content
2. **Long-term Engagement**: Encourages fans to maintain token holdings
3. **Community Investment**: Fans become stakeholders in creator success

```javascript
// Example: Creator sets up gated content
await fetch('/api/social-token/gating', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer CREATOR_TOKEN' },
  body: JSON.stringify({
    contentId: 'exclusive-interview-123',
    assetCode: 'CREATORFAN',
    assetIssuer: 'GABC...XYZ',
    minimumBalance: '500.0000000',
    verificationInterval: 30000 // 30 seconds
  })
});
```

### Tiered Access Levels

```javascript
// Bronze tier: 100 tokens required
await setGating('bronze-content', 'FANTOKEN', 'GABC...XYZ', 100);

// Silver tier: 500 tokens required  
await setGating('silver-content', 'FANTOKEN', 'GABC...XYZ', 500);

// Gold tier: 1000 tokens required
await setGating('gold-content', 'FANTOKEN', 'GABC...XYZ', 1000);
```

### Real-time Access Control

```javascript
// Start monitoring session
const session = await startSession('content-123');

// Set up periodic verification
setInterval(async () => {
  const stillValid = await verifyBalance(session.sessionId);
  if (!stillValid) {
    // Immediately stop content playback
    stopPlayback();
    showUpgradePrompt();
  }
}, session.verificationInterval);
```

## Security Considerations

### Asset Validation

- **Issuer Verification**: Validate asset issuer exists on Stellar network
- **Code Format**: Ensure asset code follows Stellar specifications
- **Address Validation**: Verify Stellar address format
- **Existence Checks**: Confirm asset exists before gating content

### Access Control

- **Creator Authorization**: Only content owners can set gating requirements
- **Session Isolation**: Each session tracked independently
- **Token Security**: JWT-based session management
- **Rate Limiting**: Prevent abuse of verification endpoints

### Data Privacy

- **Minimal Data Collection**: Only store necessary session information
- **Session Cleanup**: Automatic cleanup of expired sessions
- **Anonymous Analytics**: Aggregate statistics without personal data
- **GDPR Compliance**: User data handling per privacy regulations

## Monitoring and Analytics

### Key Metrics

- **Access Success Rate**: Percentage of successful access attempts
- **Token Distribution**: Most used tokens for gating
- **Session Duration**: Average time users maintain access
- **Geographic Distribution**: Where fans are accessing from
- **Revenue Correlation**: Token holdings vs. creator revenue

### Alerting

- **Low Success Rate**: Alert when access success rate drops below threshold
- **High Failure Rate**: Monitor for potential token manipulation
- **Stellar Network Issues**: Alert on Stellar API problems
- **Session Anomalies**: Unusual session patterns

### Performance Monitoring

```javascript
// Monitor system health
const stats = await getAdminStats();

if (stats.accessAttempts.last24Hours.successRate < 90) {
  alert('Social token access success rate below 90%');
}

if (stats.activeSessions.total > 1000) {
  alert('High number of active sessions - potential system load');
}
```

## Troubleshooting

### Common Issues

#### Access Denied Despite Having Tokens

```bash
# Check asset validation
curl -X POST "https://api.substream.protocol/api/social-token/validate-asset" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"assetCode": "FANTOKEN", "assetIssuer": "GABC...XYZ"}'

# Check user balance
curl "https://api.substream.protocol/api/social-token/tokens/FANTOKEN/GABC...XYZ" \
  -H "Authorization: Bearer TOKEN"
```

#### Session Terminated Unexpectedly

```javascript
// Check session status
const session = await verifyBalance(sessionId);
console.log('Session valid:', session.stillValid);

// Check session info
const sessionInfo = await getSessionInfo(sessionId);
console.log('Session age:', sessionInfo.duration);
```

#### Performance Issues

```bash
# Check Redis memory usage
redis-cli info memory

# Monitor Stellar API response times
curl -w "@{time_total}\n" -o /dev/null -s "https://horizon.stellar.org/accounts/GDEF...XYZ"
```

### Debug Mode

```bash
# Enable debug logging
DEBUG=social_token:* npm start
```

## Future Enhancements

Planned improvements:

1. **Multi-Asset Gating**: Support for requiring multiple different tokens
2. **Dynamic Balance Requirements**: Adjust minimum balance based on content value
3. **Token Vesting**: Support for time-locked token holdings
4. **Cross-Chain Support**: Extend to other blockchain assets
5. **Smart Contract Integration**: On-chain verification for enhanced security
6. **Advanced Analytics**: Machine learning for token holder behavior prediction
7. **Mobile SDK**: Native mobile app integration
8. **Creator Marketplace**: Platform for discovering gated content

## API Examples

### Basic Content Gating Setup

```javascript
// Creator sets up gated content
const gatingResponse = await fetch('/api/social-token/gating', {
  method: 'POST',
  headers: { 
    'Authorization': 'Bearer CREATOR_JWT',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contentId: 'exclusive-content-123',
    assetCode: 'FANTOKEN',
    assetIssuer: 'GABCDEF123456789012345678901234567890',
    minimumBalance: '1000.0000000',
    verificationInterval: 60000
  })
});

const gating = await gatingResponse.json();
console.log('Gating set up:', gating.data.gating);
```

### User Access Check

```javascript
// User checks if they can access content
const accessResponse = await fetch('/api/social-token/access/exclusive-content-123', {
  headers: { 'Authorization': 'Bearer USER_JWT' }
});

const access = await accessResponse.json();
if (access.data.accessResult.hasAccess) {
  console.log('Access granted - start watching content');
  startContentPlayback(access.data.accessResult);
} else {
  console.log('Access denied - need more tokens');
  showTokenPurchasePrompt(access.data.accessResult);
}
```

### Real-time Session Management

```javascript
// Start monitoring session
const sessionResponse = await fetch('/api/social-token/session', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer USER_JWT' },
  body: JSON.stringify({ contentId: 'exclusive-content-123' })
});

const session = await sessionResponse.json();

// Set up WebSocket monitoring
const ws = new WebSocket('wss://api.substream.protocol/social-token/ws');
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'connect',
    sessionId: session.data.sessionId,
    userAddress: 'USER_ADDRESS',
    contentId: 'exclusive-content-123'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'access_revoked') {
    // Immediately stop playback
    stopVideoPlayback();
    showTokenInsufficientMessage();
  }
};

// Periodic server-side verification
setInterval(async () => {
  const verifyResponse = await fetch(`/api/social-token/session/${session.data.sessionId}/verify`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer USER_JWT' }
  });
  
  const verification = await verifyResponse.json();
  if (!verification.data.stillValid) {
    stopVideoPlayback();
  }
}, session.data.verificationInterval);
```

---

This Social Token Holder Exclusive Feeds system creates a powerful bridge between streaming payments and long-term token investment, enabling creators to build sustainable fan communities while providing fans with meaningful "skin in the game" opportunities in the Stellar ecosystem.
