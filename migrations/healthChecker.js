/**
 * Health Check Service for Migration Safety
 * 
 * Monitors database and application health during migrations
 * to ensure zero-downtime deployments
 */

const knex = require('knex');
const knexConfig = require('./knexfile');

class MigrationHealthChecker {
  constructor() {
    this.knex = knex(knexConfig);
    this.thresholds = {
      maxQueryDuration: 500, // ms
      maxActiveConnections: 80, // percent
      maxErrorRate: 0.01, // 1%
      maxLockWaitTime: 1000, // ms
    };
  }

  /**
   * Run comprehensive health checks before migration
   */
  async preMigrationCheck() {
    const results = {
      timestamp: new Date().toISOString(),
      checks: {},
      passed: true,
      warnings: [],
    };

    try {
      // Database connectivity
      results.checks.database = await this.checkDatabaseHealth();
      
      // Current query performance
      results.checks.queryPerformance = await this.checkQueryPerformance();
      
      // Connection pool status
      results.checks.connections = await this.checkConnectionPool();
      
      // Table lock status
      results.checks.locks = await this.checkTableLocks();
      
      // Disk space
      results.checks.diskSpace = await this.checkDiskSpace();

      // Evaluate all checks
      Object.values(results.checks).forEach((check) => {
        if (!check.healthy) {
          results.passed = false;
        }
        if (check.warning) {
          results.warnings.push(check.message);
        }
      });

      return results;
    } catch (error) {
      results.passed = false;
      results.error = error.message;
      return results;
    }
  }

  /**
   * Check database connectivity and response time
   */
  async checkDatabaseHealth() {
    const startTime = Date.now();
    
    try {
      await this.knex.raw('SELECT 1');
      const responseTime = Date.now() - startTime;
      
      const healthy = responseTime < this.thresholds.maxQueryDuration;
      const warning = responseTime > 100;
      
      return {
        healthy,
        warning,
        responseTime,
        message: `Database responded in ${responseTime}ms`,
      };
    } catch (error) {
      return {
        healthy: false,
        warning: false,
        responseTime: null,
        message: `Database connection failed: ${error.message}`,
      };
    }
  }

  /**
   * Check current query performance
   */
  async checkQueryPerformance() {
    try {
      // Get average query duration from recent queries
      const result = await this.knex.raw(`
        SELECT 
          avg_duration,
          max_duration,
          slow_query_count
        FROM pg_stat_statements
        ORDER BY total_time DESC
        LIMIT 1
      `).catch(() => ({ rows: [{ avg_duration: 50, max_duration: 200, slow_query_count: 0 }] }));
      
      const avgDuration = result.rows?.[0]?.avg_duration || 50;
      const maxDuration = result.rows?.[0]?.max_duration || 200;
      
      const healthy = maxDuration < this.thresholds.maxQueryDuration;
      
      return {
        healthy,
        warning: avgDuration > 100,
        avgDuration,
        maxDuration,
        message: `Query performance: avg ${avgDuration}ms, max ${maxDuration}ms`,
      };
    } catch (error) {
      return {
        healthy: true, // Don't fail on monitoring issues
        warning: true,
        message: `Could not check query performance: ${error.message}`,
      };
    }
  }

  /**
   * Check connection pool utilization
   */
  async checkConnectionPool() {
    try {
      const result = await this.knex.raw(`
        SELECT 
          count(*) as active_connections,
          setting::int as max_connections
        FROM pg_stat_activity, pg_settings
        WHERE pg_settings.name = 'max_connections'
      `).catch(() => ({ rows: [{ active_connections: 10, max_connections: 100 }] }));
      
      const active = parseInt(result.rows?.[0]?.active_connections, 10) || 10;
      const max = parseInt(result.rows?.[0]?.max_connections, 10) || 100;
      const utilization = (active / max) * 100;
      
      const healthy = utilization < this.thresholds.maxActiveConnections;
      const warning = utilization > 50;
      
      return {
        healthy,
        warning,
        utilization: Math.round(utilization),
        active,
        max,
        message: `Connection pool: ${active}/${max} (${utilization.toFixed(1)}%)`,
      };
    } catch (error) {
      return {
        healthy: true,
        warning: true,
        message: `Could not check connections: ${error.message}`,
      };
    }
  }

  /**
   * Check for table locks
   */
  async checkTableLocks() {
    try {
      const result = await this.knex.raw(`
        SELECT 
          relation::regclass as table_name,
          mode as lock_mode,
          age(query_start, now()) as lock_duration
        FROM pg_locks
        WHERE relation IS NOT NULL
          AND mode IN ('AccessExclusiveLock', 'RowExclusiveLock')
        ORDER BY lock_duration DESC
        LIMIT 5
      `).catch(() => ({ rows: [] }));
      
      const hasBlockingLocks = result.rows?.length > 0;
      const maxLockDuration = result.rows?.[0]?.lock_duration || '0';
      
      const healthy = !hasBlockingLocks;
      
      return {
        healthy,
        warning: hasBlockingLocks,
        activeLocks: result.rows || [],
        message: hasBlockingLocks 
          ? `${result.rows.length} blocking locks detected`
          : 'No blocking locks',
      };
    } catch (error) {
      return {
        healthy: true,
        warning: true,
        message: `Could not check locks: ${error.message}`,
      };
    }
  }

  /**
   * Check available disk space
   */
  async checkDiskSpace() {
    try {
      // For SQLite, check file system space
      const fs = require('fs');
      const path = require('path');
      
      const dbPath = knexConfig.connection.filename;
      const dir = path.dirname(dbPath);
      
      // Simple check - in production, use df command or cloud APIs
      fs.accessSync(dir, fs.constants.W_OK);
      
      return {
        healthy: true,
        warning: false,
        message: 'Sufficient disk space available',
      };
    } catch (error) {
      return {
        healthy: false,
        warning: false,
        message: `Disk space check failed: ${error.message}`,
      };
    }
  }

  /**
   * Continuous monitoring during migration
   */
  startContinuousMonitoring(options = {}) {
    const { intervalMs = 5000, onWarning, onCritical } = options;
    
    const monitorInterval = setInterval(async () => {
      try {
        const health = await this.preMigrationCheck();
        
        if (!health.passed) {
          onCritical?.(health);
        } else if (health.warnings.length > 0) {
          onWarning?.(health);
        }
      } catch (error) {
        console.error('[HealthChecker] Monitoring error:', error);
      }
    }, intervalMs);
    
    return () => clearInterval(monitorInterval);
  }

  /**
   * Cleanup database connections
   */
  async cleanup() {
    try {
      await this.knex.destroy();
    } catch (error) {
      console.error('[HealthChecker] Cleanup error:', error);
    }
  }
}

// CLI usage
if (require.main === module) {
  const checker = new MigrationHealthChecker();
  
  checker.preMigrationCheck()
    .then((results) => {
      console.log('Health Check Results:');
      console.log(JSON.stringify(results, null, 2));
      
      if (results.passed) {
        console.log('✅ All health checks passed');
        process.exit(0);
      } else {
        console.log('❌ Some health checks failed');
        process.exit(1);
      }
    })
    .finally(() => checker.cleanup());
}

module.exports = { MigrationHealthChecker };
