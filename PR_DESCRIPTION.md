# Asynchronous Event Processing with RabbitMQ

## Summary

This PR implements asynchronous event processing using RabbitMQ to handle heavy tasks like sending emails, processing notifications, and updating leaderboards without blocking the main API thread. This ensures users get instant success responses while heavy lifting happens in the background.

## Features Implemented

### 🚀 Core Infrastructure
- **RabbitMQ Integration**: Added `amqplib` dependency and connection management
- **Event Publisher Service**: Non-blocking message publishing for all event types
- **Background Worker Service**: Dedicated consumer for processing events
- **Resilience Patterns**: Circuit breaker, retry logic, and dead letter queue

### 📦 Message Queues
- **Events Queue**: `substream_events_queue` - Subscription events (subscribed, unsubscribed, expired)
- **Notifications Queue**: `substream_notifications_queue` - User notifications
- **Email Queue**: `substream_emails_queue` - Email notifications
- **Leaderboard Queue**: `substream_leaderboard_queue` - Creator ranking updates

### 🛡️ Reliability Features
- **Automatic Retries**: Exponential backoff for failed operations
- **Circuit Breaker**: Prevents cascading failures during high load
- **Dead Letter Queue**: Failed message handling for debugging
- **Graceful Shutdown**: Clean connection handling on process termination

### 🔄 Integration Points
- **Subscription Service**: Async event publishing for all subscription changes
- **Main Application**: Background worker initialization and management
- **Standalone Worker**: Separate process for production deployments

## Files Added/Modified

### New Files
- `src/config/rabbitmq.js` - RabbitMQ connection and topology management
- `src/services/eventPublisherService.js` - Event publishing service
- `src/services/backgroundWorkerService.js` - Background event processing
- `src/utils/resilience.js` - Retry, circuit breaker, and dead letter utilities
- `worker.js` - Standalone background worker process

### Modified Files
- `package.json` - Added amqplib dependency and worker scripts
- `src/config.js` - Added RabbitMQ configuration
- `src/services/subscriptionService.js` - Integrated async event publishing
- `index.js` - Added background worker initialization
- `.env.example` - Added RabbitMQ environment variables
- `README.md` - Updated documentation and setup instructions

## Configuration

### Environment Variables
```bash
# RabbitMQ Configuration
RABBITMQ_URL=amqp://localhost:5672
RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=
RABBITMQ_PASSWORD=
RABBITMQ_VHOST=/
RABBITMQ_EVENT_EXCHANGE=substream_events
RABBITMQ_EVENT_QUEUE=substream_events_queue
RABBITMQ_NOTIFICATION_QUEUE=substream_notifications_queue
RABBITMQ_EMAIL_QUEUE=substream_emails_queue
RABBITMQ_LEADERBOARD_QUEUE=substream_leaderboard_queue
```

### New NPM Scripts
```json
{
  "worker": "node worker.js",
  "worker:dev": "nodemon worker.js"
}
```

## Usage

### Development
```bash
# Terminal 1: Start API server
npm run dev

# Terminal 2: Start background worker
npm run worker:dev
```

### Production
```bash
# Start API server
npm start

# Start background worker separately
npm run worker
```

### Worker Health Check
```bash
npm run worker -- --health
```

## Event Flow

1. **User Action**: Fan subscribes to a creator
2. **API Response**: Instant success response (non-blocking)
3. **Event Publishing**: Subscription event sent to RabbitMQ
4. **Background Processing**: Worker picks up event and processes:
   - Updates analytics
   - Sends notification to creator
   - Sends welcome email to fan
   - Updates leaderboard rankings
5. **Error Handling**: Failed operations retried or sent to dead letter queue

## Benefits

### Performance
- **Instant API Responses**: No more blocking on heavy operations
- **Scalable Processing**: Multiple worker instances can process events in parallel
- **Load Distribution**: Separate processes for API and background tasks

### Reliability
- **Fault Tolerance**: Failed operations are retried automatically
- **Message Persistence**: Events survive worker restarts
- **Monitoring**: Circuit breaker prevents cascading failures

### Maintainability
- **Separation of Concerns**: API and background processing are decoupled
- **Easy Testing**: Services can be tested independently
- **Observability**: Failed messages are preserved for debugging

## Testing

The implementation includes comprehensive error handling and resilience patterns. All services are designed to fail gracefully:

- Event publishing failures don't block API responses
- Worker failures trigger automatic retries
- Critical errors are logged for monitoring
- Dead letter queue captures failed messages for analysis

## Migration Notes

- **Backward Compatible**: Existing API endpoints remain unchanged
- **Optional Feature**: System works without RabbitMQ (falls back to sync processing)
- **Graceful Degradation**: Worker failures don't impact core API functionality

## Future Enhancements

- **Monitoring Dashboard**: Real-time queue metrics and worker status
- **Event Replay**: Ability to reprocess failed messages
- **Dynamic Scaling**: Auto-scaling workers based on queue length
- **Event Sourcing**: Complete event history for audit trails

## Security Considerations

- **Message Encryption**: Sensitive data in messages should be encrypted
- **Access Control**: RabbitMQ credentials should be properly secured
- **Input Validation**: All event data is validated before processing
- **Rate Limiting**: Worker processes include rate limiting for external services

This implementation significantly improves the user experience by providing instant responses while ensuring reliable background processing of all critical operations.
