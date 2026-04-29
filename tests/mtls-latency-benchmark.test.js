/**
 * mTLS Latency Benchmark Tests
 * 
 * This test suite measures the performance impact of mTLS on internal
 * microservice communication. It compares latency with and without mTLS
 * to ensure the overhead is within acceptable limits (< 5ms per request).
 * 
 * Run with: npm test -- tests/mtls-latency-benchmark.test.js
 */

const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');

// Configuration
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const BACKEND_URL_MTLS = process.env.BACKEND_URL_MTLS || 'https://localhost:3000';
const ITERATIONS = 100;
const WARMUP_ITERATIONS = 10;

// Results storage
const results = {
  withoutMtls: [],
  withMtls: [],
  statistics: {}
};

/**
 * Measure request latency
 */
async function measureLatency(url, useMtls = false) {
  const options = useMtls ? {
    rejectUnauthorized: false, // For testing only
    agent: new https.Agent({
      keepAlive: true,
      maxSockets: 10
    })
  } : {
    agent: new http.Agent({
      keepAlive: true,
      maxSockets: 10
    })
  };

  return new Promise((resolve, reject) => {
    const start = performance.now();
    
    const protocol = useMtls ? https : http;
    const request = protocol.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const end = performance.now();
        resolve({
          latency: end - start,
          statusCode: res.statusCode,
          dataSize: data.length
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Run benchmark iterations
 */
async function runBenchmark(url, useMtls = false) {
  const latencies = [];
  
  console.log(`\n${useMtls ? 'WITH' : 'WITHOUT'} mTLS Benchmark`);
  console.log('='.repeat(50));
  
  // Warmup iterations
  console.log('Warming up...');
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    try {
      await measureLatency(url, useMtls);
    } catch (error) {
      // Ignore warmup errors
    }
  }
  
  // Actual benchmark
  console.log(`Running ${ITERATIONS} iterations...`);
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const result = await measureLatency(url, useMtls);
      latencies.push(result.latency);
      
      if ((i + 1) % 20 === 0) {
        console.log(`  Progress: ${i + 1}/${ITERATIONS}`);
      }
    } catch (error) {
      console.error(`  Error on iteration ${i + 1}:`, error.message);
    }
  }
  
  return latencies;
}

/**
 * Calculate statistics
 */
function calculateStatistics(latencies) {
  if (latencies.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0,
      p99: 0,
      stdDev: 0
    };
  }
  
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const mean = sum / latencies.length;
  
  // Median
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  
  // Percentiles
  const p95Index = Math.floor(sorted.length * 0.95);
  const p99Index = Math.floor(sorted.length * 0.99);
  
  // Standard deviation
  const variance = latencies.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / latencies.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    count: latencies.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    p95: sorted[p95Index],
    p99: sorted[p99Index],
    stdDev
  };
}

/**
 * Print results
 */
function printResults(stats, label) {
  console.log(`\n${label} Statistics:`);
  console.log('-'.repeat(50));
  console.log(`  Count:       ${stats.count}`);
  console.log(`  Min:         ${stats.min.toFixed(2)} ms`);
  console.log(`  Max:         ${stats.max.toFixed(2)} ms`);
  console.log(`  Mean:        ${stats.mean.toFixed(2)} ms`);
  console.log(`  Median:      ${stats.median.toFixed(2)} ms`);
  console.log(`  95th %ile:   ${stats.p95.toFixed(2)} ms`);
  console.log(`  99th %ile:   ${stats.p99.toFixed(2)} ms`);
  console.log(`  Std Dev:     ${stats.stdDev.toFixed(2)} ms`);
}

/**
 * Compare results
 */
function compareResults(withoutMtls, withMtls) {
  console.log('\n' + '='.repeat(50));
  console.log('COMPARISON: mTLS Overhead');
  console.log('='.repeat(50));
  
  const overheadMean = withMtls.mean - withoutMtls.mean;
  const overheadP95 = withMtls.p95 - withoutMtls.p95;
  const overheadP99 = withMtls.p99 - withoutMtls.p99;
  const overheadPercent = (overheadMean / withoutMtls.mean) * 100;
  
  console.log(`\nMean Overhead:        ${overheadMean.toFixed(2)} ms (${overheadPercent.toFixed(2)}%)`);
  console.log(`95th Percentile:      ${overheadP95.toFixed(2)} ms`);
  console.log(`99th Percentile:      ${overheadP99.toFixed(2)} ms`);
  
  // Check if overhead is acceptable
  const ACCEPTABLE_OVERHEAD_MS = 5;
  const ACCEPTABLE_OVERHEAD_PERCENT = 10;
  
  console.log('\n' + '-'.repeat(50));
  if (overheadMean <= ACCEPTABLE_OVERHEAD_MS && overheadPercent <= ACCEPTABLE_OVERHEAD_PERCENT) {
    console.log('✅ PASS: mTLS overhead is within acceptable limits');
    console.log(`   Threshold: ${ACCEPTABLE_OVERHEAD_MS}ms or ${ACCEPTABLE_OVERHEAD_PERCENT}%`);
    console.log(`   Actual:    ${overheadMean.toFixed(2)}ms (${overheadPercent.toFixed(2)}%)`);
    return true;
  } else {
    console.log('❌ FAIL: mTLS overhead exceeds acceptable limits');
    console.log(`   Threshold: ${ACCEPTABLE_OVERHEAD_MS}ms or ${ACCEPTABLE_OVERHEAD_PERCENT}%`);
    console.log(`   Actual:    ${overheadMean.toFixed(2)}ms (${overheadPercent.toFixed(2)}%)`);
    return false;
  }
}

/**
 * Main test function
 */
async function runMtlsLatencyBenchmark() {
  console.log('='.repeat(50));
  console.log('mTLS Latency Benchmark Test');
  console.log('='.repeat(50));
  console.log(`Backend URL (no mTLS):  ${BACKEND_URL}`);
  console.log(`Backend URL (mTLS):     ${BACKEND_URL_MTLS}`);
  console.log(`Iterations:              ${ITERATIONS}`);
  console.log(`Warmup iterations:      ${WARMUP_ITERATIONS}`);
  
  try {
    // Benchmark without mTLS
    const latenciesWithoutMtls = await runBenchmark(BACKEND_URL, false);
    results.withoutMtls = latenciesWithoutMtls;
    const statsWithoutMtls = calculateStatistics(latenciesWithoutMtls);
    printResults(statsWithoutMtls, 'WITHOUT mTLS');
    
    // Benchmark with mTLS
    const latenciesWithMtls = await runBenchmark(BACKEND_URL_MTLS, true);
    results.withMtls = latenciesWithMtls;
    const statsWithMtls = calculateStatistics(latenciesWithMtls);
    printResults(statsWithMtls, 'WITH mTLS');
    
    // Compare results
    const passed = compareResults(statsWithoutMtls, statsWithMtls);
    
    // Store statistics
    results.statistics = {
      withoutMtls: statsWithoutMtls,
      withMtls: statsWithMtls,
      overhead: {
        mean: statsWithMtls.mean - statsWithoutMtls.mean,
        p95: statsWithMtls.p95 - statsWithoutMtls.p95,
        p99: statsWithMtls.p99 - statsWithoutMtls.p99,
        percent: ((statsWithMtls.mean - statsWithoutMtls.mean) / statsWithoutMtls.mean) * 100
      },
      passed
    };
    
    // Exit with appropriate code
    process.exit(passed ? 0 : 1);
    
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error.message);
    process.exit(2);
  }
}

/**
 * Benchmark for database connection latency
 */
async function benchmarkDatabaseConnection() {
  console.log('\n' + '='.repeat(50));
  console.log('Database Connection mTLS Benchmark');
  console.log('='.repeat(50));
  
  const { Pool } = require('pg');
  
  // Configuration without SSL
  const configWithoutSSL = {
    host: process.env.DB_HOST || 'localhost',
    port: 5432,
    database: process.env.DB_NAME || 'substream',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    max: 10
  };
  
  // Configuration with SSL verification
  const configWithSSL = {
    ...configWithoutSSL,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync('/etc/postgresql-certs/ca.crt'),
      cert: fs.readFileSync('/etc/postgresql-certs/tls.crt'),
      key: fs.readFileSync('/etc/postgresql-certs/tls.key')
    }
  };
  
  const latenciesWithoutSSL = [];
  const latenciesWithSSL = [];
  
  console.log('\nBenchmarking WITHOUT SSL...');
  const poolWithoutSSL = new Pool(configWithoutSSL);
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      await poolWithoutSSL.query('SELECT 1');
      const end = performance.now();
      latenciesWithoutSSL.push(end - start);
    } catch (error) {
      console.error(`Error on iteration ${i + 1}:`, error.message);
    }
  }
  await poolWithoutSSL.end();
  
  console.log('\nBenchmarking WITH SSL verification...');
  const poolWithSSL = new Pool(configWithSSL);
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      await poolWithSSL.query('SELECT 1');
      const end = performance.now();
      latenciesWithSSL.push(end - start);
    } catch (error) {
      console.error(`Error on iteration ${i + 1}:`, error.message);
    }
  }
  await poolWithSSL.end();
  
  const statsWithoutSSL = calculateStatistics(latenciesWithoutSSL);
  const statsWithSSL = calculateStatistics(latenciesWithSSL);
  
  printResults(statsWithoutSSL, 'DATABASE WITHOUT SSL');
  printResults(statsWithSSL, 'DATABASE WITH SSL');
  
  const overhead = statsWithSSL.mean - statsWithoutSSL.mean;
  const overheadPercent = (overhead / statsWithoutSSL.mean) * 100;
  
  console.log('\n' + '-'.repeat(50));
  console.log(`SSL Overhead: ${overhead.toFixed(2)} ms (${overheadPercent.toFixed(2)}%)`);
  
  const ACCEPTABLE_DB_OVERHEAD_MS = 10;
  if (overhead <= ACCEPTABLE_DB_OVERHEAD_MS) {
    console.log('✅ PASS: Database SSL overhead is acceptable');
    return true;
  } else {
    console.log('❌ FAIL: Database SSL overhead is too high');
    return false;
  }
}

/**
 * Benchmark for Redis connection latency
 */
async function benchmarkRedisConnection() {
  console.log('\n' + '='.repeat(50));
  console.log('Redis Connection mTLS Benchmark');
  console.log('='.repeat(50));
  
  const Redis = require('ioredis');
  
  // Configuration without TLS
  const redisWithoutTLS = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: 6372,
    password: process.env.REDIS_PASSWORD
  });
  
  // Configuration with TLS
  const redisWithTLS = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD,
    tls: {
      rejectUnauthorized: true,
      ca: fs.readFileSync('/etc/redis-certs/ca.crt'),
      cert: fs.readFileSync('/etc/redis-certs/tls.crt'),
      key: fs.readFileSync('/etc/redis-certs/tls.key')
    }
  });
  
  const latenciesWithoutTLS = [];
  const latenciesWithTLS = [];
  
  console.log('\nBenchmarking WITHOUT TLS...');
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      await redisWithoutTLS.ping();
      const end = performance.now();
      latenciesWithoutTLS.push(end - start);
    } catch (error) {
      console.error(`Error on iteration ${i + 1}:`, error.message);
    }
  }
  await redisWithoutTLS.quit();
  
  console.log('\nBenchmarking WITH TLS...');
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      await redisWithTLS.ping();
      const end = performance.now();
      latenciesWithTLS.push(end - start);
    } catch (error) {
      console.error(`Error on iteration ${i + 1}:`, error.message);
    }
  }
  await redisWithTLS.quit();
  
  const statsWithoutTLS = calculateStatistics(latenciesWithoutTLS);
  const statsWithTLS = calculateStatistics(latenciesWithTLS);
  
  printResults(statsWithoutTLS, 'REDIS WITHOUT TLS');
  printResults(statsWithTLS, 'REDIS WITH TLS');
  
  const overhead = statsWithTLS.mean - statsWithoutTLS.mean;
  const overheadPercent = (overhead / statsWithoutTLS.mean) * 100;
  
  console.log('\n' + '-'.repeat(50));
  console.log(`TLS Overhead: ${overhead.toFixed(2)} ms (${overheadPercent.toFixed(2)}%)`);
  
  const ACCEPTABLE_REDIS_OVERHEAD_MS = 5;
  if (overhead <= ACCEPTABLE_REDIS_OVERHEAD_MS) {
    console.log('✅ PASS: Redis TLS overhead is acceptable');
    return true;
  } else {
    console.log('❌ FAIL: Redis TLS overhead is too high');
    return false;
  }
}

// Run main benchmark if executed directly
if (require.main === module) {
  runMtlsLatencyBenchmark();
}

module.exports = {
  runMtlsLatencyBenchmark,
  benchmarkDatabaseConnection,
  benchmarkRedisConnection,
  calculateStatistics,
  measureLatency
};
