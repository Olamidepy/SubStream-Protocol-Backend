# IP Intelligence and VPN Detection System

## Overview

The IP Intelligence and VPN Detection system provides active defense against fraudsters who hide behind VPNs, Tor, and other high-risk IP addresses. This system addresses issues #78 and #43 by integrating multiple IP intelligence providers to assess risk scores for every connecting IP during the Sign-In With Stellar (SIWS) flow and other critical operations.

## 🎯 Key Features

### **Multi-Provider Intelligence**
- **IPInfo.io** - Comprehensive IP geolocation and VPN detection
- **MaxMind** - Advanced geolocation and risk assessment
- **AbuseIPDB** - Community-driven abuse reporting and confidence scores
- **IPQualityScore** - Fraud detection, bot detection, and proxy identification

### **Real-Time Risk Assessment**
- **Risk Scoring** (0-100 scale): Minimal, Low, Medium, High, Critical
- **Pattern Recognition**: Tor exit nodes, VPN providers, data centers, proxy servers
- **Behavioral Analysis**: IP reputation tracking and violation history
- **Geographic Intelligence**: Country-based risk assessment and concentration analysis

### **Active Defense Mechanisms**
- **Automatic Blocking**: Temporary and permanent IP blocking for high-risk addresses
- **Access Restrictions**: Limit critical actions based on IP risk level
- **Enhanced Rate Limiting**: Dynamic rate limiting based on IP reputation
- **SIWS Protection**: Real-time blocking during authentication flow

### **Comprehensive Monitoring**
- **Real-time Alerts**: Email notifications for security events
- **Analytics Dashboard**: Detailed risk analytics and trend analysis
- **Audit Trail**: Complete logging of all IP intelligence actions
- **Performance Metrics**: System health and performance monitoring

## 🏗️ Architecture

### **Core Services**

#### 1. IPIntelligenceService
```javascript
// Primary service for IP risk assessment
const riskAssessment = await ipIntelligenceService.assessIPRisk('192.168.1.1');
```

**Key Capabilities:**
- Multi-provider data aggregation
- Intelligent caching (1-hour TTL)
- Rate limiting and error handling
- Risk score calculation and normalization

#### 2. IPIntelligenceMiddleware
```javascript
// Middleware for real-time protection
app.use('/api/creator', ipMiddleware.createCreatorMiddleware());
app.use('/api/subscription', ipMiddleware.createSIWSMiddleware());
```

**Protection Points:**
- SIWS authentication flow
- Creator channel creation
- High-value withdrawals
- Content uploads
- CDN access

#### 3. IPBlockingService
```javascript
// Automatic IP blocking and restriction
const blockDecision = await ipBlockingService.evaluateIP(ipAddress, riskAssessment);
```

**Blocking Features:**
- Temporary blocks (configurable duration)
- Permanent blocks for critical threats
- Automatic escalation based on violation history
- Manual override capabilities

#### 4. IPMonitoringService
```javascript
// Continuous monitoring and analytics
const analytics = await ipMonitoringService.getAnalytics({ period: '24h' });
```

**Monitoring Capabilities:**
- Real-time event tracking
- Risk trend analysis
- Geographic distribution analysis
- Automated alerting system

## 🔧 Configuration

### **Environment Variables**

```bash
# Enable IP Intelligence System
IP_INTELLIGENCE_ENABLED=true

# Provider Configuration
IPINFO_ENABLED=true
IPINFO_API_KEY=your-ipinfo-api-key

MAXMIND_ENABLED=true
MAXMIND_API_KEY=your-maxmind-api-key

ABUSEIPDB_ENABLED=true
ABUSEIPDB_API_KEY=your-abuseipdb-api-key

IPQUALITYSCORE_ENABLED=true
IPQUALITYSCORE_API_KEY=your-ipqualityscore-api-key

# Risk Thresholds
IP_RISK_THRESHOLD_LOW=30
IP_RISK_THRESHOLD_MEDIUM=60
IP_RISK_THRESHOLD_HIGH=80
IP_RISK_THRESHOLD_CRITICAL=90

# Cache Configuration
IP_CACHE_ENABLED=true
IP_CACHE_TTL_MS=3600000
IP_CACHE_MAX_SIZE=10000

# Security Alerts
SECURITY_ALERT_EMAIL=security@yourdomain.com
```

### **Risk Level Configuration**

| Risk Level | Score Range | Actions Allowed | Typical Response |
|------------|-------------|----------------|-----------------|
| Minimal | 0-29 | All actions | Standard processing |
| Low | 30-59 | Most actions | Basic monitoring |
| Medium | 60-79 | Limited actions | Enhanced monitoring |
| High | 80-89 | Restricted actions | Additional verification |
| Critical | 90-100 | No actions | Automatic blocking |

## 📊 API Endpoints

### **Management API** (`/api/ip-intelligence`)

#### Get Service Statistics
```http
GET /api/ip-intelligence/stats
```

#### Assess IP Risk
```http
POST /api/ip-intelligence/assess
Content-Type: application/json

{
  "ipAddress": "192.168.1.1",
  "options": {
    "context": "siws_auth",
    "userAgent": "Mozilla/5.0..."
  }
}
```

#### Check IP Block Status
```http
GET /api/ip-intelligence/is-blocked/:ipAddress
```

#### Manual IP Blocking
```http
POST /api/ip-intelligence/block
Content-Type: application/json

{
  "ipAddress": "192.168.1.1",
  "type": "temporary",
  "duration": 3600000,
  "reason": "Manual block by administrator"
}
```

#### Get Analytics Dashboard
```http
GET /api/ip-intelligence/dashboard
```

#### Get Detailed Analytics
```http
GET /api/ip-intelligence/analytics?period=24h&includeDetails=true
```

#### Export Data
```http
GET /api/ip-intelligence/export?period=7d&format=csv&type=all
```

### **Response Examples**

#### Risk Assessment Response
```json
{
  "success": true,
  "data": {
    "ipAddress": "192.168.1.1",
    "riskScore": 75,
    "riskLevel": "medium",
    "providerScores": {
      "ipinfo": { "score": 70, "weight": 0.25 },
      "abuseipdb": { "score": 85, "weight": 0.35 },
      "ipqualityscore": { "score": 72, "weight": 0.25 }
    },
    "riskFactors": [
      "VPN detected via IPInfo",
      "Recent abuse detected"
    ],
    "recommendations": [
      "Enhanced monitoring required",
      "Rate limiting recommended"
    ],
    "assessedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

#### Blocking Decision Response
```json
{
  "success": true,
  "data": {
    "ipAddress": "192.168.1.1",
    "action": "restrict",
    "reason": "Elevated risk score (75)",
    "duration": 86400000,
    "metadata": {
      "riskScore": 75,
      "riskLevel": "medium",
      "blockId": "block_1642248600000_abc123"
    }
  }
}
```

## 🛡️ Security Features

### **Real-Time Protection**

#### SIWS Flow Protection
- Blocks high-risk IPs during authentication
- Requires additional verification for medium-risk IPs
- Maintains audit trail of all authentication attempts

#### Critical Action Protection
- **Creator Channel Creation**: Blocks high-risk IPs
- **High-Value Withdrawals**: Additional verification required
- **Content Uploads**: Enhanced monitoring for suspicious IPs
- **CDN Access**: Rate limiting based on IP reputation

### **Automatic Blocking**

#### Blocking Triggers
- **Risk Score ≥ 90**: Automatic permanent block
- **Risk Score ≥ 80**: Temporary block (24 hours default)
- **Multiple Violations**: Escalated blocking
- **Critical Risk Factors**: Immediate blocking

#### Block Types
- **Temporary**: Configurable duration (1 hour to 7 days)
- **Permanent**: Manual review required for unblocking
- **Restriction**: Limited actions allowed

### **Enhanced Rate Limiting**

#### Dynamic Rate Limiting
```javascript
// Rate limits adjusted based on IP risk
const riskMultiplier = getRiskMultiplier(riskScore);
// High risk: 25% of normal rate limit
// Medium risk: 50% of normal rate limit
// Low risk: 75% of normal rate limit
// Minimal risk: 100% of normal rate limit
```

## 📈 Analytics and Monitoring

### **Risk Analytics**

#### Risk Distribution
- Real-time risk level distribution
- Geographic risk concentration analysis
- Provider accuracy comparison
- Trend analysis over time

#### IP Reputation Tracking
- Historical behavior analysis
- Violation history tracking
- Reputation score calculation
- Pattern recognition

### **Performance Metrics**

#### System Performance
- API response times by provider
- Cache hit rates
- Error rates and failures
- Resource utilization

#### Security Metrics
- Blocks applied per hour
- False positive rates
- Threat detection accuracy
- Alert response times

### **Alerting System**

#### Alert Types
- **High Risk Spike**: Unusual increase in high-risk IPs
- **Geographic Concentration**: Traffic concentration from single country
- **Provider Failures**: API provider connectivity issues
- **System Health**: Performance degradation alerts

#### Alert Delivery
- Email notifications to security team
- Dashboard alerts and indicators
- Integration with monitoring systems
- Historical alert tracking

## 🧪 Testing

### **Unit Tests**
```bash
# Run IP intelligence tests
npm test ipIntelligence.test.js

# Test coverage includes:
# - IP validation and private IP detection
# - Risk assessment and scoring
# - Provider integration and error handling
# - Cache management and rate limiting
# - Middleware functionality
# - Blocking service operations
# - Monitoring and analytics
```

### **Integration Tests**
```bash
# Test complete workflow
npm run test:integration

# Tests include:
# - End-to-end IP assessment
# - SIWS flow protection
# - Blocking and unblocking
# - Analytics generation
# - Alert delivery
```

### **Performance Tests**
```bash
# Load testing for IP intelligence
npm run test:performance

# Tests include:
# - Concurrent IP assessments
# - Cache performance
# - Rate limiting effectiveness
# - Memory usage optimization
```

## 🔍 Troubleshooting

### **Common Issues**

#### Provider API Failures
```bash
# Check API key configuration
echo $IPINFO_API_KEY
echo $ABUSEIPDB_API_KEY

# Test provider connectivity
curl -H "Authorization: Bearer $IPINFO_API_KEY" \
     https://ipinfo.io/8.8.8.8/json
```

#### High Memory Usage
```bash
# Check cache size
curl http://localhost:3000/api/ip-intelligence/stats

# Reduce cache size if needed
IP_CACHE_MAX_SIZE=5000 npm start
```

#### Rate Limiting Issues
```bash
# Check rate limit configuration
curl http://localhost:3000/api/ip-intelligence/monitoring-status

# Adjust rate limits
IP_RATE_LIMIT_PER_MINUTE=200 npm start
```

### **Debugging Tools**

#### Enable Debug Logging
```bash
# Enable detailed logging
DEBUG=ip-intelligence:* npm start
```

#### Manual IP Assessment
```bash
# Test specific IP addresses
curl -X POST http://localhost:3000/api/ip-intelligence/assess \
     -H "Content-Type: application/json" \
     -d '{"ipAddress":"8.8.8.8"}'
```

#### Check Block Status
```bash
# Verify IP blocking
curl http://localhost:3000/api/ip-intelligence/is-blocked/192.168.1.1
```

## 🚀 Production Deployment

### **Pre-Deployment Checklist**

1. **API Key Configuration**
   - Obtain production API keys from all providers
   - Test API connectivity and rate limits
   - Configure secure key storage

2. **Risk Threshold Tuning**
   - Adjust thresholds based on traffic patterns
   - Monitor false positive rates
   - Fine-tune blocking policies

3. **Monitoring Setup**
   - Configure security alert emails
   - Set up dashboard monitoring
   - Integrate with existing monitoring systems

4. **Performance Optimization**
   - Configure appropriate cache sizes
   - Set up database indexes
   - Monitor resource utilization

### **Security Considerations**

#### API Key Security
- Store API keys in environment variables only
- Use different keys for development and production
- Regularly rotate API keys
- Monitor API usage for anomalies

#### Privacy Compliance
- Comply with GDPR and data protection laws
- Implement data retention policies
- Provide user access to their data
- Document data processing activities

#### Access Control
- Protect IP intelligence endpoints with authentication
- Implement role-based access control
- Audit all administrative actions
- Use secure communication channels

### **Scaling Considerations**

#### Horizontal Scaling
- Deploy multiple instances behind load balancer
- Use Redis for distributed caching
- Implement database connection pooling
- Monitor and optimize resource usage

#### Provider Management
- Implement provider failover logic
- Monitor provider API health
- Configure timeout and retry policies
- Balance load across providers

## 📚 API References

### **Provider APIs**

#### IPInfo.io
- **Documentation**: https://ipinfo.io/developers
- **Rate Limits**: 1,000 requests/day (free), 50,000+/day (paid)
- **Features**: Geolocation, VPN detection, carrier info

#### MaxMind
- **Documentation**: https://dev.maxmind.com/geoip/docs
- **Rate Limits**: Based on subscription tier
- **Features**: Geolocation, risk assessment, connection type

#### AbuseIPDB
- **Documentation**: https://www.abuseipdb.com/api
- **Rate Limits**: 1,000 requests/day (free), 100,000+/day (paid)
- **Features**: Abuse confidence score, country blocking

#### IPQualityScore
- **Documentation**: https://www.ipqualityscore.com/documentation
- **Rate Limits**: 5,000 requests/month (free), 100,000+/month (paid)
- **Features**: Fraud detection, bot detection, proxy detection

### **Integration Examples**

#### JavaScript/Node.js
```javascript
const { IPIntelligenceService } = require('./src/services/ipIntelligenceService');

const ipService = new IPIntelligenceService({
  providers: {
    ipinfo: { enabled: true, apiKey: 'your-key' },
    abuseipdb: { enabled: true, apiKey: 'your-key' }
  }
});

const assessment = await ipService.assessIPRisk('192.168.1.1');
```

#### Python
```python
import requests

def assess_ip_risk(ip_address):
    response = requests.post('http://localhost:3000/api/ip-intelligence/assess', 
                           json={'ipAddress': ip_address})
    return response.json()
```

#### curl
```bash
curl -X POST http://localhost:3000/api/ip-intelligence/assess \
     -H "Content-Type: application/json" \
     -d '{"ipAddress":"192.168.1.1"}'
```

## 📞 Support

### **Getting Help**
- **Documentation**: Review this comprehensive guide
- **Issue Tracking**: Create issues in the repository
- **Security Issues**: Report to security team immediately
- **Performance Issues**: Contact technical support

### **Community Resources**
- **GitHub Discussions**: Ask questions and share experiences
- **Security Forums**: Discuss threat intelligence and best practices
- **Provider Support**: Contact individual provider support teams

---

**⚠️ Important**: This is a critical security system. Ensure proper testing, monitoring, and review before deploying to production. Regular updates and maintenance are essential for continued effectiveness.
