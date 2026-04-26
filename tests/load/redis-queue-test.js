import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

export let errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '2m', target: 5 },    // Warm up
    { duration: '3m', target: 20 },   // Moderate load
    { duration: '5m', target: 100 },  // High load to generate queue backlog
    { duration: '10m', target: 100 }, // Sustain to trigger worker scaling
    { duration: '5m', target: 5 },    // Scale down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.15'],
    errors: ['rate<0.15'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // Simulate Soroban event processing that creates queue backlog
  let payloads = [
    {
      method: 'POST',
      url: `${BASE_URL}/api/soroban/events`,
      body: JSON.stringify({
        contract_id: 'test_contract',
        event_type: 'transaction',
        data: { amount: Math.random() * 1000 }
      })
    },
    {
      method: 'POST', 
      url: `${BASE_URL}/api/soroban/index`,
      body: JSON.stringify({
        ledger: Math.floor(Math.random() * 1000000),
        transactions: Array.from({length: 10}, (_, i) => ({
          id: `tx_${Date.now()}_${i}`,
          operations: Math.floor(Math.random() * 5)
        }))
      })
    },
    {
      method: 'GET',
      url: `${BASE_URL}/api/soroban/queue/status`
    }
  ];

  let payload = payloads[Math.floor(Math.random() * payloads.length)];
  
  let params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.API_TOKEN || 'test-token'}`,
    },
  };

  let response;
  if (payload.method === 'POST') {
    response = http.post(payload.url, payload.body, params);
  } else {
    response = http.get(payload.url, params);
  }

  let success = check(response, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
    'response time < 3000ms': (r) => r.timings.duration < 3000,
  });

  errorRate.add(!success);
  
  // Shorter sleep to increase queue pressure
  sleep(Math.random() * 0.5 + 0.1);
}

export function handleSummary(data) {
  return {
    'redis-queue-test-results.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, options) {
  const indent = options.indent || '';
  
  let summary = `${indent}Redis Queue Scaling Test Summary\n`;
  summary += `${indent}===============================\n`;
  summary += `${indent}Total Requests: ${data.metrics.http_reqs.count}\n`;
  summary += `${indent}Failed Requests: ${data.metrics.http_req_failed.count}\n`;
  summary += `${indent}Error Rate: ${(data.metrics.http_req_failed.rate * 100).toFixed(2)}%\n`;
  summary += `${indent}Average Response Time: ${data.metrics.http_req_duration.avg.toFixed(2)}ms\n`;
  summary += `${indent}95th Percentile: ${data.metrics.http_req_duration['p(95)'].toFixed(2)}ms\n`;
  
  return summary;
}
