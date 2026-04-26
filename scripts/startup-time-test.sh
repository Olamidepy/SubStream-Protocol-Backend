#!/bin/bash

# Startup Time Test Script
# This script measures application startup time to ensure it's under 10 seconds

set -e

echo "🚀 Testing Application Startup Time"
echo "==================================="

# Configuration
NAMESPACE="substream"
MAX_STARTUP_TIME=10  # seconds

# Function to measure pod startup time
measure_startup_time() {
    local deployment_name=$1
    local container_name=$2
    
    echo "📊 Measuring startup time for $deployment_name..."
    
    # Scale down to 0, then up to 1 to measure cold start
    kubectl scale deployment $deployment_name --replicas=0 -n $NAMESPACE
    echo "⏳ Waiting for pods to terminate..."
    kubectl wait --for=delete pod -l app=$deployment_name -n $NAMESPACE --timeout=60s
    
    echo "🚀 Starting pod and measuring time..."
    local start_time=$(date +%s)
    
    kubectl scale deployment $deployment_name --replicas=1 -n $NAMESPACE
    
    # Wait for pod to be ready and capture startup time
    kubectl wait --for=condition=ready pod -l app=$deployment_name -n $NAMESPACE --timeout=120s
    
    local end_time=$(date +%s)
    local startup_time=$((end_time - start_time))
    
    echo "⏱️  Startup time: ${startup_time} seconds"
    
    if [ $startup_time -le $MAX_STARTUP_TIME ]; then
        echo "✅ Startup time is within acceptable limit (< ${MAX_STARTUP_TIME}s)"
    else
        echo "❌ Startup time exceeds acceptable limit (> ${MAX_STARTUP_TIME}s)"
        echo "This may impact HPA effectiveness during rapid scaling events"
        
        # Get pod logs for analysis
        local pod_name=$(kubectl get pods -n $NAMESPACE -l app=$deployment_name -o jsonpath='{.items[0].metadata.name}')
        echo "📋 Recent pod logs for analysis:"
        kubectl logs $pod_name -n $NAMESPACE --tail=50
    fi
    
    return $startup_time
}

# Function to check container readiness probes
check_readiness_probes() {
    local deployment_name=$1
    
    echo "🔍 Checking readiness probe configuration for $deployment_name..."
    kubectl get deployment $deployment_name -n $NAMESPACE -o yaml | \
        yq eval '.spec.template.spec.containers[0].readinessProbe' -
}

# Function to analyze startup bottlenecks
analyze_startup_bottlenecks() {
    local deployment_name=$1
    local pod_name=$(kubectl get pods -n $NAMESPACE -l app=$deployment_name -o jsonpath='{.items[0].metadata.name}')
    
    echo "🔍 Analyzing startup bottlenecks for $pod_name..."
    
    # Check resource constraints
    echo "📊 Resource requests and limits:"
    kubectl get pod $pod_name -n $NAMESPACE -o jsonpath='{.spec.containers[0].resources}' | jq .
    
    # Check events for the pod
    echo "📋 Pod events:"
    kubectl describe pod $pod_name -n $NAMESPACE | grep -A 20 "Events:"
    
    # Check if there are any image pull issues
    echo "🔍 Checking image pull status..."
    kubectl get pod $pod_name -n $NAMESPACE -o jsonpath='{.status.containerStatuses[0].image}' | xargs -I {} echo "Image: {}"
    kubectl get pod $pod_name -n $NAMESPACE -o jsonpath='{.status.containerStatuses[0].imageID}' | xargs -I {} echo "Image ID: {}"
}

# Pre-test checks
echo "🔍 Pre-test checks..."

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl is not installed or not in PATH"
    exit 1
fi

# Check if deployments exist
kubectl get deployment substream-backend -n $NAMESPACE || {
    echo "❌ substream-backend deployment not found"
    exit 1
}

kubectl get deployment substream-worker -n $NAMESPACE || {
    echo "❌ substream-worker deployment not found"
    exit 1
}

echo "✅ All required deployments found"

# Test main backend startup time
echo "🚀 Testing main backend startup..."
backend_startup_time=0
measure_startup_time "substream-backend" "substream-backend"
backend_startup_time=$?

echo ""
check_readiness_probes "substream-backend"
echo ""
analyze_startup_bottlenecks "substream-backend"

echo ""
echo "=========================================="

# Test worker startup time
echo "🚀 Testing worker startup..."
worker_startup_time=0
measure_startup_time "substream-worker" "substream-worker"
worker_startup_time=$?

echo ""
check_readiness_probes "substream-worker"
echo ""
analyze_startup_bottlenecks "substream-worker"

# Summary
echo ""
echo "📊 Startup Time Test Summary"
echo "============================"
echo "Backend startup time: ${backend_startup_time}s"
echo "Worker startup time: ${worker_startup_time}s"

if [ $backend_startup_time -le $MAX_STARTUP_TIME ] && [ $worker_startup_time -le $MAX_STARTUP_TIME ]; then
    echo "✅ All components start within acceptable time limits"
    echo "🎉 HPA can effectively scale the application during traffic spikes"
else
    echo "❌ Some components exceed startup time limits"
    echo "⚠️  This may impact HPA effectiveness during rapid scaling events"
    echo ""
    echo "Recommendations:"
    echo "- Optimize database connection initialization"
    echo "- Consider connection pooling for external services"
    echo "- Reduce initial dependency loading time"
    echo "- Implement lazy loading for non-critical services"
fi

# Restore original replica counts
echo ""
echo "🔄 Restoring original replica counts..."
kubectl scale deployment substream-backend --replicas=3 -n $NAMESPACE
kubectl scale deployment substream-worker --replicas=2 -n $NAMESPACE

echo "🎉 Startup time testing completed!"
