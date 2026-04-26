import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
export let errorRate = new Rate('errors');

// Test configuration
export const options = {
  stages: [
    { duration: '2m', target: 10 },   // Warm up
    { duration: '5m', target: 50 },   // Ramp up to moderate load
    { duration: '10m', target: 200 }, // Massive spike to trigger HPA
    { duration: '5m', target: 200 },  // Sustain high load
    { duration: '10m', target: 10 },  // Scale down
    { duration: '5m', target: 0 },    // Cool down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 95% of requests under 2s
    http_req_failed: ['rate<0.1'],     // Error rate under 10%
    errors: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // Test API endpoints that will generate CPU load
  let endpoints = [
    '/api/health',
    '/api/stats',
    '/api/users',
    '/api/videos',
  ];

  let endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  let url = `${BASE_URL}${endpoint}`;

  let params = {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'k6-load-test',
    },
  };

  let response = http.get(url, params);
  
  let success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 2000ms': (r) => r.timings.duration < 2000,
    'response body is not empty': (r) => r.body.length > 0,
  });

  errorRate.add(!success);

  // Random sleep between 100ms and 1s
  sleep(Math.random() * 0.9 + 0.1);
}

export function handleSummary(data) {
  return {
    'hpa-test-results.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, options) {
  const indent = options.indent || '';
  const enableColors = options.enableColors || false;
  
  let summary = `${indent}HPA Load Test Summary\n`;
  summary += `${indent}=====================\n`;
  summary += `${indent}Total Requests: ${data.metrics.http_reqs.count}\n`;
  summary += `${indent}Failed Requests: ${data.metrics.http_req_failed.count}\n`;
  summary += `${indent}Error Rate: ${(data.metrics.http_req_failed.rate * 100).toFixed(2)}%\n`;
  summary += `${indent}Average Response Time: ${data.metrics.http_req_duration.avg.toFixed(2)}ms\n`;
  summary += `${indent}95th Percentile: ${data.metrics.http_req_duration['p(95)'].toFixed(2)}ms\n`;
  summary += `${indent}Max Response Time: ${data.metrics.http_req_duration.max.toFixed(2)}ms\n`;
  
  return summary;
}
