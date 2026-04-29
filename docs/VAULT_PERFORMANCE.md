# Vault Integration Performance Impact Verification

This document provides guidelines for verifying that the Vault integration does not significantly impact pod startup time, which could affect autoscaling performance.

## Performance Benchmarks

### Expected Startup Time Impact

The Vault integration adds the following overhead to pod startup:

| Operation | Expected Time | Notes |
|-----------|---------------|-------|
| Vault Authentication | 100-200ms | One-time, cached by sidecar |
| Secret Retrieval | 50-100ms | One-time, cached by sidecar |
| Database Credential Generation | 200-300ms | Only on initial startup |
| **Total Additional Startup Time** | **< 500ms** | Acceptable threshold |

### Baseline Comparison

- **Without Vault**: ~2-3 seconds typical startup time
- **With Vault**: ~2.5-3.5 seconds typical startup time
- **Acceptable Increase**: < 20% of baseline

## Verification Methods

### Method 1: Kubernetes Pod Startup Time Measurement

Measure pod startup time using Kubernetes events:

```bash
# Measure startup time for a new pod
kubectl get pod -l app=substream-backend -o jsonpath='{.items[0].metadata.creationTimestamp}'

# Wait for pod to be ready
kubectl wait --for=condition=ready pod -l app=substream-backend --timeout=60s

# Check when pod became ready
kubectl get pod -l app=substream-backend -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].lastTransitionTime}'
```

### Method 2: Application-Level Timing

The application logs Vault initialization times. Check logs:

```bash
# Extract Vault initialization timing
kubectl logs deployment/substream-backend | grep Vault
```

Expected output:
```
[Vault] Vault integration enabled
[Vault] Vault service initialized successfully
```

### Method 3: Vault Sidecar Metrics

The Vault sidecar injector provides metrics on secret injection:

```bash
# Check sidecar logs for timing information
kubectl logs <pod-name> -c vault-agent-init
```

### Method 4: Continuous Monitoring with Prometheus

Add the following Prometheus queries to monitor startup times:

```promql
# Average pod startup time over last hour
avg(kube_pod_container_status_ready_time_seconds{container="substream-backend"} > 0)

# 95th percentile startup time
histogram_quantile(0.95, kube_pod_container_status_ready_time_seconds{container="substream-backend"})

# Compare with baseline (without Vault)
avg(kube_pod_container_status_ready_time_seconds{container="substream-backend"}) 
/ 
avg(kube_pod_container_status_ready_time_seconds{container="substream-backend-legacy"})
```

## Performance Testing Procedure

### Test 1: Cold Start Performance

1. Scale down the deployment to 0 replicas:
```bash
kubectl scale deployment substream-backend --replicas=0
```

2. Scale up to 3 replicas:
```bash
kubectl scale deployment substream-backend --replicas=3
```

3. Measure time for all pods to become ready:
```bash
time kubectl wait --for=condition=ready pod -l app=substream-backend --timeout=120s
```

4. Record the startup time for each pod:
```bash
kubectl get pods -l app=substream-backend -o custom-columns=NAME:.metadata.name,START:.metadata.creationTimestamp,READY:.status.startTime
```

**Acceptance Criteria**: All pods should be ready within 60 seconds.

### Test 2: Warm Start Performance (With Vault Cache)

1. Delete a single pod (triggers replacement with cached secrets):
```bash
kubectl delete pod -l app=substream-backend --field-selector=status.phase=Running
```

2. Measure replacement pod startup time:
```bash
kubectl wait --for=condition=ready pod -l app=substream-backend --timeout=30s
```

**Acceptance Criteria**: Replacement pod should be ready within 30 seconds (faster due to caching).

### Test 3: Vault Unavailability Impact

1. Temporarily block Vault access:
```bash
kubectl exec -it <pod-name> -- iptables -A INPUT -p tcp --dport 8200 -j DROP
```

2. Scale deployment to test fallback behavior:
```bash
kubectl scale deployment substream-backend --replicas=4
```

3. Verify pods start using environment variable fallback:
```bash
kubectl logs deployment/substream-backend | grep -i vault
```

Expected output:
```
[Vault] Vault initialization failed, continuing with environment variables: <error message>
```

4. Restore Vault access:
```bash
kubectl exec -it <pod-name> -- iptables -D INPUT -p tcp --dport 8200 -j DROP
```

**Acceptance Criteria**: Pods should start successfully even when Vault is unavailable, using environment variable fallback.

### Test 4: Autoscaling Impact

1. Configure HPA with aggressive scaling:
```bash
kubectl autoscale deployment substream-backend --min=3 --max=10 --cpu-percent=50
```

2. Generate load to trigger scale-up:
```bash
# Use a load testing tool
hey -n 10000 -c 100 http://substream-backend-service
```

3. Monitor scale-up time:
```bash
watch kubectl get hpa substream-backend
watch kubectl get pods -l app=substream-backend
```

**Acceptance Criteria**: New pods should become ready within 60 seconds during scale-up events.

## Performance Optimization Tips

### 1. Enable Vault Sidecar Caching

The Vault sidecar injector caches secrets locally. Ensure caching is enabled in annotations:

```yaml
vault.hashicorp.com/agent-cache-use-auto-auth-token: "force"
```

### 2. Use Vault Agent Pre-Population

Pre-populate secrets during pod initialization:

```yaml
vault.hashicorp.com/agent-pre-populate-only: "false"
```

### 3. Optimize Database Credential Generation

Reduce database credential generation time by:
- Using a high-performance database connection
- Reducing the number of GRANT statements
- Using connection pooling

### 4. Adjust Vault Request Timeouts

If Vault is slow, adjust timeouts in the VaultService:

```javascript
timeout: 5000 // 5 seconds instead of default 10 seconds
```

### 5. Use Kubernetes Readiness Gates

Configure readiness gates to ensure pods are not marked ready until Vault secrets are loaded:

```yaml
readinessGates:
- conditionType: vault.hashicorp.com/agent-inject-ready
```

## Monitoring and Alerting

### Prometheus Metrics

Add these metrics to your monitoring:

```yaml
# Vault authentication duration
vault_auth_duration_seconds

# Secret retrieval duration
vault_secret_retrieval_duration_seconds

# Pod startup time
kube_pod_container_status_ready_time_seconds{container="substream-backend"}
```

### Alerting Rules

Create alerts for performance degradation:

```yaml
groups:
- name: vault_performance
  rules:
  - alert: VaultSlowStartup
    expr: histogram_quantile(0.95, kube_pod_container_status_ready_time_seconds{container="substream-backend"}) > 60
    for: 5m
    annotations:
      summary: "Vault integration causing slow pod startup"
      description: "95th percentile pod startup time exceeds 60 seconds"
      
  - alert: VaultAuthenticationFailure
    expr: rate(vault_auth_failures_total[5m]) > 0.1
    for: 2m
    annotations:
      summary: "High Vault authentication failure rate"
      description: "Vault authentication failing at {{ $value }} req/sec"
```

## Troubleshooting Performance Issues

### Issue: Pods Taking Too Long to Start

**Symptoms**: Pod startup time > 60 seconds

**Investigation Steps**:
1. Check Vault service health:
```bash
kubectl exec -it vault-0 -- vault status
```

2. Check Vault sidecar logs:
```bash
kubectl logs <pod-name> -c vault-agent-init
```

3. Check network latency to Vault:
```bash
kubectl run ping-test --image=busybox --rm -it -- ping -c 5 vault
```

**Solutions**:
- Ensure Vault is in the same Kubernetes cluster
- Use a Vault service with low latency
- Enable Vault caching
- Increase Vault resource limits

### Issue: Vault Authentication Timeout

**Symptoms**: Logs show "Vault authentication failed" with timeout errors

**Investigation Steps**:
1. Check Kubernetes service account:
```bash
kubectl get sa substream-backend -n substream
```

2. Check Vault role configuration:
```bash
vault read auth/kubernetes/role/substream-backend
```

**Solutions**:
- Increase timeout in VaultService
- Check network policies between pod and Vault
- Verify Kubernetes API server is accessible

### Issue: Database Credential Generation Slow

**Symptoms**: Pod logs show slow database credential generation

**Investigation Steps**:
1. Test Vault database secrets engine:
```bash
vault read database/creds/substream-role
```

2. Check database performance:
```bash
kubectl exec -it postgresql-0 -- psql -c "SELECT version();"
```

**Solutions**:
- Optimize database connection string
- Reduce number of GRANT statements
- Use database connection pooling
- Increase database resources

## Baseline Measurements

### Pre-Vault Integration Baseline

Before implementing Vault, measure baseline startup time:

```bash
# Measure without Vault (using environment variables)
kubectl scale deployment substream-backend-legacy --replicas=0
kubectl scale deployment substream-backend-legacy --replicas=3
time kubectl wait --for=condition=ready pod -l app=substream-backend-legacy --timeout=60s
```

### Post-Vault Integration Comparison

After implementing Vault, compare startup times:

```bash
# Measure with Vault
kubectl scale deployment substream-backend --replicas=0
kubectl scale deployment substream-backend --replicas=3
time kubectl wait --for=condition=ready pod -l app=substream-backend --timeout=60s
```

### Acceptance Criteria

The Vault integration is considered performant if:

1. **Startup Time Increase**: < 20% compared to baseline
2. **Absolute Startup Time**: < 60 seconds for cold start
3. **Warm Startup Time**: < 30 seconds (with caching)
4. **Scale-Up Time**: New pods ready within 60 seconds during HPA events
5. **Vault Unavailability**: No impact on pod startup (graceful fallback)

## Conclusion

The Vault integration is designed to have minimal impact on pod startup time through:

- Efficient caching by the Vault sidecar
- Asynchronous secret loading
- Graceful fallback to environment variables
- Optimized database credential generation

Regular performance monitoring and testing should be conducted to ensure these performance characteristics are maintained as the application evolves.
