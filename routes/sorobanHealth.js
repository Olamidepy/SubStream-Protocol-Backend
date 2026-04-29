const express = require('express');
const router = express.Router();
const { authenticateTenant } = require('../middleware/tenantAuth');
const rateLimit = require('express-rate-limit');
const { logger } = require('../src/utils/logger');

// Rate limiting for health endpoints
const healthRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all health routes
router.use(healthRateLimit);

/**
 * Get Soroban circuit breaker status
 * GET /api/soroban/circuit-breaker
 */
router.get('/circuit-breaker', authenticateTenant, async (req, res) => {
  try {
    const sorobanService = req.app.get('enhancedSorobanService');
    
    if (!sorobanService) {
      return res.status(503).json({
        success: false,
        error: 'Soroban service not available'
      });
    }

    const status = sorobanService.getCircuitBreakerStatus();

    res.json({
      success: true,
      ...status
    });

  } catch (error) {
    logger.error('Error getting circuit breaker status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get circuit breaker status'
    });
  }
});

/**
 * Comprehensive Soroban health check
 * GET /api/soroban/health
 */
router.get('/health', authenticateTenant, async (req, res) => {
  try {
    const sorobanService = req.app.get('enhancedSorobanService');
    
    if (!sorobanService) {
      return res.status(503).json({
        success: false,
        error: 'Soroban service not available'
      });
    }

    const health = await sorobanService.healthCheck();
    
    // Determine overall health status
    let overallStatus = 'healthy';
    if (health.rpc_health === 'error' || !health.circuit_breaker_healthy) {
      overallStatus = 'unhealthy';
    } else if (health.rpc_health === 'degraded' || health.circuit_breaker_degraded) {
      overallStatus = 'degraded';
    }

    res.status(overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503).json({
      success: true,
      overall_status: overallStatus,
      ...health
    });

  } catch (error) {
    logger.error('Error in Soroban health check:', error);
    res.status(503).json({
      success: false,
      error: 'Health check failed',
      overall_status: 'unhealthy'
    });
  }
});

/**
 * Force circuit breaker state (admin only)
 * POST /api/soroban/circuit-breaker/force
 */
router.post('/circuit-breaker/force', authenticateTenant, async (req, res) => {
  try {
    // Only allow admin tenants
    if (!req.tenant.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { state } = req.body; // 'open' or 'close'
    const sorobanService = req.app.get('enhancedSorobanService');
    
    if (!sorobanService) {
      return res.status(503).json({
        success: false,
        error: 'Soroban service not available'
      });
    }

    if (state === 'open') {
      sorobanService.forceCircuitOpen();
    } else if (state === 'close') {
      sorobanService.forceCircuitClose();
    } else if (state === 'reset') {
      sorobanService.resetCircuitBreaker();
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid state. Must be "open", "close", or "reset"'
      });
    }

    const newStatus = sorobanService.getCircuitBreakerStatus();

    logger.info('Soroban circuit breaker state forced', {
      forced_by: req.tenant.id,
      new_state: state,
      previous_state: newStatus.state
    });

    res.json({
      success: true,
      message: `Circuit breaker forced to ${state}`,
      new_status: newStatus
    });

  } catch (error) {
    logger.error('Error forcing circuit breaker state:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to force circuit breaker state'
    });
  }
});

/**
 * Update circuit breaker configuration (admin only)
 * PUT /api/soroban/circuit-breaker/config
 */
router.put('/circuit-breaker/config', authenticateTenant, async (req, res) => {
  try {
    // Only allow admin tenants
    if (!req.tenant.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const config = req.body;
    const sorobanService = req.app.get('enhancedSorobanService');
    
    if (!sorobanService) {
      return res.status(503).json({
        success: false,
        error: 'Soroban service not available'
      });
    }

    sorobanService.updateCircuitBreakerConfig(config);

    const newStatus = sorobanService.getCircuitBreakerStatus();

    logger.info('Soroban circuit breaker configuration updated', {
      updated_by: req.tenant.id,
      new_config: config
    });

    res.json({
      success: true,
      message: 'Circuit breaker configuration updated',
      new_config: config,
      current_status: newStatus
    });

  } catch (error) {
    logger.error('Error updating circuit breaker config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration'
    });
  }
});

/**
 * Get Soroban metrics for monitoring
 * GET /api/soroban/metrics
 */
router.get('/metrics', authenticateTenant, async (req, res) => {
  try {
    const sorobanService = req.app.get('enhancedSorobanService');
    
    if (!sorobanService) {
      return res.status(503).json({
        success: false,
        error: 'Soroban service not available'
      });
    }

    const circuitStatus = sorobanService.getCircuitBreakerStatus();
    const health = await sorobanService.healthCheck();

    const metrics = {
      timestamp: new Date().toISOString(),
      circuit_breaker: {
        state: circuitStatus.state,
        failure_count: circuitStatus.failureCount,
        failure_threshold: circuitStatus.failureThreshold,
        success_count: circuitStatus.successCount,
        current_rate: circuitStatus.currentRate,
        max_rate: circuitStatus.maxRate,
        last_failure_time: circuitStatus.lastFailureTime,
        circuit_opened_time: circuitStatus.circuitOpenedTime
      },
      rpc: {
        health: health.rpc_health,
        ledger_lag: health.ledger_lag
      },
      alerts: this.generateAlerts(circuitStatus, health)
    };

    res.json({
      success: true,
      ...metrics
    });

  } catch (error) {
    logger.error('Error getting Soroban metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get metrics'
    });
  }
});

/**
 * Generate alerts based on circuit breaker and RPC health
 */
function generateAlerts(circuitStatus, health) {
  const alerts = [];

  // Circuit breaker alerts
  if (circuitStatus.state === 'OPEN') {
    alerts.push({
      type: 'critical',
      message: 'Soroban RPC circuit breaker is OPEN - All RPC calls are blocked',
      timestamp: new Date().toISOString(),
      recommendation: 'Check RPC endpoint connectivity and consider manual intervention'
    });
  } else if (circuitStatus.state === 'HALF_OPEN') {
    alerts.push({
      type: 'warning',
      message: 'Soroban RPC circuit breaker is HALF_OPEN - Testing connectivity',
      timestamp: new Date().toISOString(),
      recommendation: 'Monitor for successful recovery or circuit re-opening'
    });
  }

  // Failure rate alerts
  if (circuitStatus.failureCount > 0) {
    const failureRate = (circuitStatus.failureCount / circuitStatus.failureThreshold) * 100;
    if (failureRate >= 80) {
      alerts.push({
        type: 'critical',
        message: `Soroban RPC failure rate is ${failureRate.toFixed(1)}% of threshold`,
        timestamp: new Date().toISOString(),
        recommendation: 'Immediate investigation required'
      });
    } else if (failureRate >= 50) {
      alerts.push({
        type: 'warning',
        message: `Soroban RPC failure rate is ${failureRate.toFixed(1)}% of threshold`,
        timestamp: new Date().toISOString(),
        recommendation: 'Monitor closely and prepare for potential circuit opening'
      });
    }
  }

  // Rate limiting alerts
  if (circuitStatus.currentRate >= circuitStatus.maxRate * 0.9) {
    alerts.push({
      type: 'warning',
      message: `Soroban RPC request rate is at ${((circuitStatus.currentRate / circuitStatus.maxRate) * 100).toFixed(1)}% capacity`,
      timestamp: new Date().toISOString(),
      recommendation: 'Consider rate limiting adjustments or scaling'
    });
  }

  // RPC health alerts
  if (health.rpc_health === 'error') {
    alerts.push({
      type: 'critical',
      message: 'Soroban RPC endpoint is experiencing errors',
      timestamp: new Date().toISOString(),
      recommendation: 'Check RPC endpoint status and network connectivity'
    });
  } else if (health.rpc_health === 'degraded') {
    alerts.push({
      type: 'warning',
      message: 'Soroban RPC endpoint performance is degraded',
      timestamp: new Date().toISOString(),
      recommendation: 'Monitor performance and investigate potential issues'
    });
  }

  return alerts;
}

module.exports = router;
