#!/bin/bash

# HPA Scaling Test Script
# This script runs load tests and monitors HPA behavior

set -e

echo "🚀 Starting HPA Scaling Verification Tests"
echo "=========================================="

# Configuration
NAMESPACE="substream"
BASE_URL="${BASE_URL:-http://substream-backend-service.substream.svc.cluster.local}"
API_TOKEN="${API_TOKEN:-test-token}"

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl is not installed or not in PATH"
    exit 1
fi

# Check if k6 is available
if ! command -v k6 &> /dev/null; then
    echo "❌ k6 is not installed or not in PATH"
    echo "Please install k6: https://k6.io/docs/getting-started/installation/"
    exit 1
fi

# Function to monitor HPA status
monitor_hpa() {
    local hpa_name=$1
    local duration=$2
    echo "📊 Monitoring HPA: $hpa_name for ${duration}s"
    
    for i in $(seq 1 $((duration / 10))); do
        echo "--- $(date) ---"
        kubectl get hpa $hpa_name -n $NAMESPACE -o yaml | \
            yq eval '.status.currentReplicas, .status.desiredReplicas, .status.currentMetrics' -
        echo ""
        sleep 10
    done
}

# Function to monitor pod count
monitor_pods() {
    local app_label=$1
    local duration=$2
    echo "📈 Monitoring pods for $app_label for ${duration}s"
    
    for i in $(seq 1 $((duration / 10))); do
        echo "--- $(date) ---"
        kubectl get pods -n $NAMESPACE -l app=$app_label --no-headers | wc -l
        kubectl get pods -n $NAMESPACE -l app=$app_label -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,CPU:.status.containerStatuses[0].resources.requests.cpu
        echo ""
        sleep 10
    done
}

# Function to check Redis queue length
check_redis_queue() {
    echo "📋 Checking Redis queue length"
    kubectl exec -n $NAMESPACE deployment/redis -- redis-cli llen soroban_events_queue || echo "Redis queue check failed"
}

# Pre-test checks
echo "🔍 Pre-test checks..."

# Check if deployments exist
kubectl get deployment substream-backend -n $NAMESPACE || {
    echo "❌ substream-backend deployment not found"
    exit 1
}

kubectl get deployment substream-worker -n $NAMESPACE || {
    echo "❌ substream-worker deployment not found"
    exit 1
}

# Check if HPAs exist
kubectl get hpa substream-backend-hpa -n $NAMESPACE || {
    echo "❌ substream-backend-hpa not found"
    exit 1
}

kubectl get hpa substream-worker-hpa -n $NAMESPACE || {
    echo "❌ substream-worker-hpa not found"
    exit 1
}

echo "✅ All required resources found"

# Record initial state
echo "📊 Initial state:"
echo "Backend pods:"
kubectl get pods -n $NAMESPACE -l app=substream-backend --no-headers | wc -l
echo "Worker pods:"
kubectl get pods -n $NAMESPACE -l app=substream-worker --no-headers | wc -l
echo "Redis queue length:"
check_redis_queue

# Start background monitoring
echo "🔍 Starting background monitoring..."
monitor_hpa substream-backend-hpa 1800 &
HPA_MONITOR_PID=$!

monitor_pods substream-backend 1800 &
POD_MONITOR_PID=$!

# Run CPU-based load test
echo "💪 Running CPU-based load test..."
BASE_URL=$BASE_URL API_TOKEN=$API_TOKEN k6 run tests/load/hpa-verification-test.js &
CPU_TEST_PID=$!

# Wait for CPU test to complete
wait $CPU_TEST_PID
echo "✅ CPU-based load test completed"

# Run Redis queue load test
echo "📦 Running Redis queue load test..."
BASE_URL=$BASE_URL API_TOKEN=$API_TOKEN k6 run tests/load/redis-queue-test.js &
QUEUE_TEST_PID=$!

# Monitor Redis queue during test
for i in {1..60}; do
    echo "--- Queue Check $(date) ---"
    check_redis_queue
    sleep 30
done &

QUEUE_MONITOR_PID=$!

# Wait for queue test to complete
wait $QUEUE_TEST_PID
echo "✅ Redis queue load test completed"

# Stop background monitoring
kill $HPA_MONITOR_PID $POD_MONITOR_PID $QUEUE_MONITOR_PID 2>/dev/null || true

# Post-test analysis
echo "📊 Post-test analysis:"
echo "Final pod counts:"
echo "Backend pods:"
kubectl get pods -n $NAMESPACE -l app=substream-backend --no-headers | wc -l
echo "Worker pods:"
kubectl get pods -n $NAMESPACE -l app=substream-worker --no-headers | wc -l

echo "Final HPA status:"
kubectl get hpa -n $NAMESPACE -o yaml

echo "Final Redis queue length:"
check_redis_queue

echo "🎉 HPA Scaling Verification Tests Completed!"
echo "============================================"
echo "Check the generated JSON files for detailed metrics:"
echo "- hpa-test-results.json"
echo "- redis-queue-test-results.json"
