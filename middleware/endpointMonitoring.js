const { logger } = require('../src/utils/logger');

/**
 * Endpoint monitoring middleware
 * Records HTTP requests, response times, and errors for monitoring
 */
function createEndpointMonitoringMiddleware(monitoringService) {
  return (req, res, next) => {
    const startTime = Date.now();
    
    // Store original end function
    const originalEnd = res.end;
    
    // Override end function to capture response
    res.end = function(chunk, encoding) {
      // Call original end function
      originalEnd.call(this, chunk, encoding);
      
      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Record request in monitoring service
      try {
        monitoringService.recordRequest(req, res, responseTime);
      } catch (error) {
        logger.error('Error recording request in monitoring service:', error);
      }
    };
    
    next();
  };
}

/**
 * Error monitoring middleware
 * Specifically tracks 5xx errors for alerting
 */
function createErrorMonitoringMiddleware(monitoringService) {
  return (error, req, res, next) => {
    // Record the error even if we don't send a response
    try {
      monitoringService.recordRequest(req, {
        statusCode: error.statusCode || 500
      }, Date.now() - (req.startTime || Date.now()));
    } catch (monitoringError) {
      logger.error('Error recording in monitoring middleware:', monitoringError);
    }
    
    // Continue to next error handler
    next(error);
  };
}

/**
 * Request start time middleware
 * Adds startTime to request object for accurate timing
 */
function addRequestStartTime(req, res, next) {
  req.startTime = Date.now();
  next();
}

module.exports = {
  createEndpointMonitoringMiddleware,
  createErrorMonitoringMiddleware,
  addRequestStartTime
};
