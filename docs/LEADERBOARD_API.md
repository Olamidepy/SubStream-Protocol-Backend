# Automated Engagement Leaderboard API

## Overview

The Automated Engagement Leaderboard API provides a high-performance system for generating "Top Fans" leaderboards for every creator on SubStream. The system calculates composite scores based on streaming activity, subscription longevity, and engagement metrics, with results pre-calculated every 6 hours and cached in Redis for optimal performance.

## Features

- **Composite Scoring Algorithm**: Weighted scoring based on streaming amount (40%), subscription length (30%), and engagement (30%)
- **Season-Based Filtering**: Support for monthly, quarterly, and yearly leaderboards
- **Redis Caching**: 6-hour cache TTL for lightning-fast responses
- **Background Processing**: Automatic recalculation every 6 hours without impacting API performance
- **Real-Time Updates**: Immediate cache invalidation on engagement events
- **Historical Tracking**: Season snapshots for trend analysis
- **Export Functionality**: JSON and CSV export for giveaways and analytics

## Architecture

### Core Components

1. **EngagementLeaderboardService** (`services/engagementLeaderboardService.js`)
   - Core scoring algorithm implementation
   - Redis caching management
   - Season handling and date calculations
   - Metric normalization and composite scoring

2. **LeaderboardWorker** (`src/services/leaderboardWorker.js`)
   - Background processing every 6 hours
   - Batch processing of creator leaderboards
   - Cache management and cleanup
   - Export and analytics functions

3. **Leaderboard API** (`routes/leaderboard.js`)
   - RESTful endpoints for leaderboard access
   - Season filtering and pagination
   - Fan rank lookup and statistics
   - Admin endpoints for management

4. **Update Middleware** (`middleware/leaderboardUpdate.js`)
   - Real-time cache invalidation
   - Engagement summary updates
   - Historical snapshot creation

### Database Schema

- `streaming_payments`: Fan payment tracking
- `content_likes`: Like/engagement tracking
- `leaderboard_snapshots`: Historical leaderboard data
- `fan_engagement_summary`: Pre-calculated metrics cache

## Scoring Algorithm

### Composite Score Calculation

```
Composite Score = (Streaming Score × 0.4) + (Subscription Score × 0.3) + (Engagement Score × 0.3)
```

### Component Scoring

#### Streaming Score (0-100)
- **Base Amount**: Logarithmic scaling of total streaming amount
- **Consistency Bonus**: Up to 10 points for streaming frequency
- **Formula**: `log10(amount + 1) / log10(maxAmount + 1) × 90 + consistencyBonus`

#### Subscription Score (0-100)
- **Longevity**: Up to 70 points based on subscription days
- **Active Bonus**: 20 points for current active subscription
- **Streak Bonus**: Up to 10 points for current streak
- **Formula**: `longevityScore + activeBonus + streakBonus`

#### Engagement Score (0-100)
- **Weighted Actions**: Comments (3x), Likes (1x), Shares (5x)
- **Logarithmic Scaling**: Prevents spam from dominating
- **Formula**: `log10(weightedEngagement + 1) / log10(maxEngagement + 1) × 100`

## API Endpoints

### Leaderboard Access

#### Get Creator Leaderboard
```http
GET /api/leaderboard/{creatorAddress}
```

**Query Parameters:**
- `season`: Season identifier (optional, defaults to current)
- `limit`: Maximum results (default: 50, max: 200)
- `offset`: Pagination offset (default: 0)
- `includeMetrics`: Include detailed metrics (default: false)

**Response:**
```json
{
  "success": true,
  "data": {
    "creatorAddress": "GABC...",
    "season": "2024-03",
    "leaderboard": [
      {
        "rank": 1,
        "fanAddress": "GDEF...",
        "score": 87.45,
        "lastUpdated": "2024-03-15T12:00:00.000Z"
      }
    ],
    "pagination": {
      "offset": 0,
      "limit": 50,
      "totalCount": 150,
      "hasMore": true,
      "currentPage": 1,
      "totalPages": 3
    }
  }
}
```

#### Get Fan Rank
```http
GET /api/leaderboard/{creatorAddress}/fan/{fanAddress}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "creatorAddress": "GABC...",
    "fanAddress": "GDEF...",
    "rank": 5,
    "score": 82.30,
    "metrics": {
      "streaming": { "totalAmount": 500, "transactionCount": 25 },
      "subscription": { "isActive": true, "longevityDays": 180 },
      "engagement": { "commentCount": 15, "likeCount": 45 }
    }
  }
}
```

#### Get Available Seasons
```http
GET /api/leaderboard/{creatorAddress}/seasons
```

#### Get Leaderboard Statistics
```http
GET /api/leaderboard/{creatorAddress}/stats
```

### User Rankings

#### Get User's Rankings Across Creators
```http
GET /api/leaderboard/user/rankings
```

**Response:**
```json
{
  "success": true,
  "data": {
    "userAddress": "GDEF...",
    "season": "2024-03",
    "rankings": [
      {
        "creatorAddress": "GABC...",
        "rank": 5,
        "score": 82.30
      }
    ],
    "totalCreators": 10,
    "rankedCreators": 8
  }
}
```

### Analytics & Trends

#### Get Leaderboard Trends
```http
GET /api/leaderboard/{creatorAddress}/trends?seasons=3
```

### Creator Management

#### Force Recalculation (Creator Only)
```http
POST /api/leaderboard/{creatorAddress}/recalculate
```

#### Export Leaderboard (Creator Only)
```http
GET /api/leaderboard/{creatorAddress}/export?format=csv&season=2024-03
```

### Admin Endpoints

#### Get Worker Status
```http
GET /api/leaderboard/worker/status
```

#### Recalculate All Leaderboards
```http
POST /api/leaderboard/worker/recalculate-all
```

#### Cache Cleanup
```http
POST /api/leaderboard/worker/cleanup
```

## Configuration

### Environment Variables

```bash
# Engagement Leaderboard Configuration
LEADERBOARD_ENABLED=true                    # Enable/disable leaderboard
LEADERBOARD_CACHE_TTL=21600                # Cache TTL in seconds (6 hours)
LEADERBOARD_WORKER_INTERVAL=21600000        # Worker interval in milliseconds (6 hours)
LEADERBOARD_BATCH_SIZE=10                   # Creators per batch
LEADERBOARD_SEASON_LENGTH=monthly           # Season length: monthly, quarterly, yearly
LEADERBOARD_CACHE_PREFIX=leaderboard:       # Redis key prefix
```

### Custom Scoring Weights

```javascript
const weights = {
  streamingAmount: 0.4,      // 40% weight for streaming
  subscriptionLength: 0.3,   // 30% weight for subscription
  engagementCount: 0.3       // 30% weight for engagement
};
```

## Performance Optimizations

### Caching Strategy

- **Redis Caching**: 6-hour TTL for all leaderboard data
- **Pre-calculated Metrics**: Engagement summary table for quick lookups
- **Batch Processing**: Process 10 creators per batch to avoid overload
- **Cache Invalidation**: Immediate invalidation on engagement events

### Database Indexes

```sql
-- Optimized indexes for performance
CREATE INDEX idx_streaming_creator_fan ON streaming_payments(creator_address, fan_address);
CREATE INDEX idx_streaming_creator_date ON streaming_payments(creator_address, created_at);
CREATE INDEX idx_subscriptions_creator_active ON subscriptions(creator_id, active);
CREATE INDEX idx_engagement_summary_season_score ON fan_engagement_summary(creator_address, season, composite_score);
```

### Query Optimization

- **Pre-aggregated Data**: Use `fan_engagement_summary` for quick metric retrieval
- **Limited Result Sets**: Default 50 results with pagination
- **Season-based Partitioning**: Separate data by season for faster queries

## Season Management

### Season Types

- **Monthly**: `YYYY-MM` (e.g., "2024-03")
- **Quarterly**: `YYYY-Q#` (e.g., "2024-Q1")
- **Yearly**: `YYYY` (e.g., "2024")

### Season Boundaries

```javascript
// Monthly: First day of the month
// Quarterly: First day of the quarter (Jan, Apr, Jul, Oct)
// Yearly: January 1st
```

### Historical Tracking

- **Snapshots**: Automatic creation of season-end snapshots
- **Trend Analysis**: Compare performance across seasons
- **Rank Changes**: Track fan rank improvements/declines

## Real-Time Updates

### Event-Driven Updates

The system automatically updates when:

1. **Streaming Payments**: New fan payments processed
2. **Subscription Changes**: New, renewed, or cancelled subscriptions
3. **Comments**: New comments on creator content
4. **Likes**: New likes on creator content

### Update Flow

1. Event occurs (payment, subscription, comment, like)
2. Cache invalidated for affected creator
3. Engagement summary updated in real-time
4. Next API request returns fresh data

### Performance Impact

- **Minimal Overhead**: Cache invalidation is O(1) operation
- **Background Processing**: Heavy calculations run in worker
- **API Performance**: Cached responses serve in <10ms

## Analytics & Reporting

### Leaderboard Statistics

```javascript
{
  "totalFans": 150,
  "averageScore": 45.67,
  "topScore": 98.23,
  "medianScore": 42.15,
  "scoreDistribution": [
    { "label": "0-20", "count": 30, "percentage": 20 },
    { "label": "21-40", "count": 45, "percentage": 30 },
    // ... more ranges
  ]
}
```

### Trend Analysis

- **Season-over-Season**: Compare performance between periods
- **Fan Retention**: Track repeat top fans
- **Engagement Growth**: Monitor community health

### Export Capabilities

- **JSON Format**: Complete data with metrics
- **CSV Format**: Spreadsheet-ready with key metrics
- **Custom Seasons**: Export specific time periods

## Use Cases

### Creator Giveaways

1. **Identify Top Fans**: Get current season leaderboard
2. **Export Data**: Download CSV for prize selection
3. **Verify Eligibility**: Check fan activity and scores
4. **Announce Winners**: Share results with community

```bash
# Export March leaderboard for giveaway
curl -H "Authorization: Bearer TOKEN" \
  "https://api.substream.protocol/leaderboard/GABC.../export?season=2024-03&format=csv"
```

### Community Engagement

1. **Monitor Rankings**: Track fan position changes
2. **Recognize Supporters**: Highlight top fans in content
3. **Set Goals**: Fans can work to improve their rank
4. **Reward Loyalty**: Special perks for consistent top fans

### Business Analytics

1. **Revenue Insights**: Correlate leaderboard with revenue
2. **Retention Analysis**: Identify at-risk top fans
3. **Growth Tracking**: Monitor community expansion
4. **Competitive Analysis**: Compare with similar creators

## Troubleshooting

### Common Issues

#### Leaderboard Not Updating
```bash
# Check worker status
curl "https://api.substream.protocol/leaderboard/worker/status"

# Force recalculation
curl -X POST "https://api.substream.protocol/leaderboard/GABC.../recalculate"
```

#### Cache Issues
```bash
# Clear cache for specific creator
# (Admin endpoint)
curl -X POST "https://api.substream.protocol/leaderboard/worker/cleanup"
```

#### Performance Issues
- **Check Redis Memory**: Monitor cache usage
- **Database Indexes**: Ensure proper indexing
- **Worker Load**: Monitor batch processing times

### Debug Mode

```bash
# Enable debug logging
DEBUG=leaderboard:* npm start
```

### Monitoring

Key metrics to monitor:

- **Cache Hit Rate**: Should be >90%
- **Worker Processing Time**: <5 minutes per batch
- **API Response Time**: <50ms for cached requests
- **Database Query Time**: <100ms for metric queries

## Security Considerations

- **Access Control**: Creators can only access their own data
- **Rate Limiting**: Apply to leaderboard endpoints
- **Data Privacy**: Fan addresses are pseudonymous
- **Export Limits**: Restrict bulk data access

## Future Enhancements

Planned improvements:

1. **Real-time Leaderboards**: WebSocket updates for live rankings
2. **Custom Scoring**: Creator-defined weight configurations
3. **Achievement System**: Milestones and badges for fans
4. **Leaderboard Categories**: Separate leaderboards by content type
5. **Mobile Optimization**: Dedicated mobile API responses
6. **Advanced Analytics**: Machine learning for engagement prediction
7. **Social Features**: Fan profiles and achievement sharing
8. **Integration APIs**: Third-party leaderboard integrations

## API Examples

### Basic Leaderboard Request

```javascript
// Get top 10 fans for current season
const response = await fetch('/api/leaderboard/GABCDEF123456789?limit=10&includeMetrics=true', {
  headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
});

const data = await response.json();
console.log(data.data.leaderboard);
```

### Fan Rank Lookup

```javascript
// Check your rank on a creator's leaderboard
const response = await fetch('/api/leaderboard/GABCDEF123456789/fan/GHIJKL789', {
  headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
});

const rankData = await response.json();
console.log(`Your rank: #${rankData.data.rank} with score ${rankData.data.score}`);
```

### Export for Giveaway

```javascript
// Export March leaderboard as CSV
const response = await fetch('/api/leaderboard/GABCDEF123456789/export?season=2024-03&format=csv', {
  headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
});

const csvData = await response.text();
// Save to file or process for giveaway
```

---

This Automated Engagement Leaderboard API transforms community engagement into a gamified experience, helping creators identify and reward their most dedicated supporters while providing valuable insights into community health and growth patterns.
