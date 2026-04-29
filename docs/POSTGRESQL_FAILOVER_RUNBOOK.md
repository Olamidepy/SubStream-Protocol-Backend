# PostgreSQL Read-Replica Promotion Runbook

This runbook provides step-by-step instructions for promoting the PostgreSQL read-replica in the secondary region to a writable primary during a disaster recovery event.

## Prerequisites

- Secondary region Kubernetes cluster is operational
- PostgreSQL read-replica is running and receiving WAL logs
- Access to AWS CLI and kubectl configured for eu-west-1
- Database administrator credentials available
- Vault access for secret updates

## Pre-Failover Verification

### Step 1: Verify Primary Region Failure

```bash
# Check primary region status
aws ec2 describe-instance-status --region us-east-1 --instance-ids i-xxxxxxxxx
kubectl get nodes --region us-east-1
kubectl get pods -n substream --region us-east-1

# Verify primary database is unreachable
aws rds describe-db-instances --db-instance-identifier substream-postgresql-primary --region us-east-1
```

**Expected Result**: Primary region is confirmed down or database is unreachable.

### Step 2: Verify Secondary Region Health

```bash
# Check secondary region Kubernetes cluster
kubectl get nodes --region eu-west-1
kubectl get pods -n substream --region eu-west-1

# Verify PostgreSQL replica is receiving WAL logs
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;"

# Verify replication status
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"
```

**Expected Result**: Secondary region is healthy, replication lag is minimal (< 1 minute).

### Step 3: Verify Data Consistency

```bash
# Check for any pending transactions
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle';"

# Verify last checkpoint
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_last_xact_replay_timestamp();"
```

**Expected Result**: No pending transactions, checkpoint is recent.

## Promotion Procedure

### Step 4: Stop Application Writes

```bash
# Scale down applications to prevent new writes
kubectl scale deployment substream-backend --replicas=0 --region eu-west-1
kubectl scale deployment substream-worker --replicas=0 --region eu-west-1

# Verify no active connections
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'substream';"
```

**Expected Result**: No active application connections to the database.

### Step 5: Stop Replication and Promote Replica

```bash
# Option 1: Using pg_promote() (PostgreSQL 12+)
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_promote();"

# Option 2: Manual promotion (if pg_promote is not available)
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- bash -c "
  pg_ctl stop -D /var/lib/postgresql/data
  rm -f /var/lib/postgresql/data/recovery.signal
  rm -f /var/lib/postgresql/data/standby.signal
  pg_ctl start -D /var/lib/postgresql/data
"

# For RDS, use AWS CLI:
aws rds promote-read-replica \
  --db-instance-identifier substream-postgresql-eu-west-1 \
  --region eu-west-1
```

**Expected Result**: PostgreSQL is promoted to primary and accepts writes.

### Step 6: Verify Promotion Success

```bash
# Check if database is in recovery mode
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_is_in_recovery();"

# Expected: f (false)

# Verify database is writable
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "CREATE TABLE test_write (id SERIAL PRIMARY KEY); DROP TABLE test_write;"

# Check PostgreSQL logs
kubectl logs postgresql-0 -n substream --region eu-west-1 --tail=50
```

**Expected Result**: Database is not in recovery mode, writes succeed.

### Step 7: Update Application Configuration

```bash
# Update Vault with new database connection string
vault kv put secret/data/substream \
  DATABASE_URL="postgresql://postgres:password@postgresql-eu-west-1:5432/substream"

# Update Kubernetes ConfigMap
kubectl patch configmap substream-config -n substream --region eu-west-1 \
  --type=json \
  -p='{"data":{"database-host":"postgresql-eu-west-1","database-region":"eu-west-1"}}'

# Update environment variables in deployments
kubectl set env deployment/substream-backend -n substream --region eu-west-1 \
  DATABASE_HOST=postgresql-eu-west-1 \
  DATABASE_REGION=eu-west-1
```

**Expected Result**: Application configuration points to new primary database.

### Step 8: Clear Redis Cache

```bash
# Clear all Redis caches to prevent stale data
kubectl exec -it redis-0 -n substream --region eu-west-1 -- redis-cli FLUSHALL

# Verify cache is empty
kubectl exec -it redis-0 -n substream --region eu-west-1 -- redis-cli DBSIZE

# Expected: 0
```

**Expected Result**: Redis cache is empty.

### Step 9: Scale Up Applications

```bash
# Scale up backend
kubectl scale deployment substream-backend --replicas=10 --region eu-west-1

# Scale up workers
kubectl scale deployment substream-worker --replicas=5 --region eu-west-1

# Wait for pods to be ready
kubectl wait --for=condition=ready pod -l app=substream-backend -n substream --region eu-west-1 --timeout=300s
kubectl wait --for=condition=ready pod -l app=substream-worker -n substream --region eu-west-1 --timeout=300s
```

**Expected Result**: All pods are running and ready.

### Step 10: Verify Soroban Indexer

```bash
# Check Soroban indexer status
kubectl logs deployment/substream-worker -n substream --region eu-west-1 | grep "last_processed_ledger"

# Verify indexer resumes from last known ledger
kubectl exec -it substream-worker-xxx -n substream --region eu-west-1 -- node worker.js --soroban --health

# Expected output shows healthy status and last processed ledger
```

**Expected Result**: Soroban indexer is healthy and resumes from last known ledger.

### Step 11: Update DNS (if not automatic)

```bash
# If Route53 automatic failover didn't trigger, update manually
# Update health check to point to secondary
aws route53 update-health-check \
  --health-check-id <primary-health-check-id> \
  --disabled

# Wait for DNS propagation (up to 60 seconds)
# Verify DNS resolution
dig api.substream.app +short
```

**Expected Result**: DNS resolves to secondary region load balancer.

### Step 12: Monitor System Health

```bash
# Monitor application logs
kubectl logs -f deployment/substream-backend -n substream --region eu-west-1

# Monitor database performance
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT * FROM pg_stat_activity;"

# Check CloudWatch metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=substream-postgresql-eu-west-1 \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Average
```

**Expected Result**: System is healthy, no errors in logs.

## Post-Failover Tasks

### Step 13: Configure Backup for New Primary

```bash
# Enable automated backups
aws rds modify-db-instance \
  --db-instance-identifier substream-postgresql-eu-west-1 \
  --backup-retention-period 7 \
  --backup-window 03:00-04:00 \
  --region eu-west-1

# Configure WAL archiving to S3
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "
  ALTER SYSTEM SET archive_mode = on;
  ALTER SYSTEM SET archive_command = 'aws s3 cp %p s3://substream-backups-eu/wal/%f';
  SELECT pg_reload_conf();
"
```

**Expected Result**: Backups are configured for new primary.

### Step 14: Set Up Replication to New Secondary (if restoring primary region)

```bash
# This is for when the primary region is restored and becomes the new secondary
# Configure PostgreSQL in us-east-1 as read-replica

# Create replication slot on new primary (eu-west-1)
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_create_physical_replication_slot('replica_slot_us_east_1');"

# Configure us-east-1 as standby
# (This would be done after primary region is restored)
```

### Step 15: Notify Stakeholders

```bash
# Send notification via SNS
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:account-id:substream-dr-alerts \
  --subject "PostgreSQL Failover Completed" \
  --message "PostgreSQL has been successfully promoted in eu-west-1. All systems are operational."

# Update status page
# Send email to operations team
# Update incident management system
```

**Expected Result**: All stakeholders are notified.

## Rollback Procedure

If the promotion fails or causes issues:

### Rollback Step 1: Stop Applications

```bash
kubectl scale deployment substream-backend --replicas=0 --region eu-west-1
kubectl scale deployment substream-worker --replicas=0 --region eu-west-1
```

### Rollback Step 2: Revert Database (if possible)

```bash
# If primary region recovers, revert to primary
# This is complex and may require point-in-time recovery

# For RDS, you can restore from snapshot:
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier substream-postgresql-eu-west-1-restored \
  --db-snapshot-identifier substream-postgresql-eu-west-1-snapshot \
  --region eu-west-1
```

### Rollback Step 3: Update Configuration

```bash
# Revert configuration changes
kubectl patch configmap substream-config -n substream --region eu-west-1 \
  --type=json \
  -p='{"data":{"database-host":"postgresql-primary","database-region":"us-east-1"}}'
```

### Rollback Step 4: Escalate

```bash
# If rollback fails, escalate to senior DBA
# Contact AWS support for emergency assistance
# Initiate incident response protocol
```

## Verification Checklist

After completing the promotion, verify:

- [ ] PostgreSQL is promoted and accepting writes
- [ ] Application configuration updated
- [ ] Redis cache cleared
- [ ] Applications scaled up and healthy
- [ ] Soroban indexer resumed correctly
- [ ] DNS routing to secondary region
- [ ] Backups configured for new primary
- [ ] No replication lag (now primary)
- [ ] Application logs show no errors
- [ ] Database performance metrics normal
- [ ] Stakeholders notified
- [ ] Documentation updated

## Troubleshooting

### Issue: pg_promote() fails

**Symptoms**: `SELECT pg_promote()` returns error

**Solution**:
```bash
# Check recovery status
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_is_in_recovery();"

# Check for active replication connections
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# Try manual promotion
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- bash -c "
  pg_ctl stop -D /var/lib/postgresql/data -m fast
  rm -f /var/lib/postgresql/data/recovery.signal
  rm -f /var/lib/postgresql/data/standby.signal
  pg_ctl start -D /var/lib/postgresql/data
"
```

### Issue: Applications cannot connect

**Symptoms**: Connection refused or timeout errors

**Solution**:
```bash
# Check PostgreSQL is listening
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT inet_server_addr(), inet_server_port();"

# Check security groups
aws ec2 describe-security-groups --group-ids sg-xxxxxxxxx --region eu-west-1

# Verify database is accepting connections
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"
```

### Issue: Data inconsistency

**Symptoms**: Missing data or corrupted records

**Solution**:
```bash
# Check replication lag before promotion
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"

# If lag was significant, consider point-in-time recovery
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier substream-postgresql-eu-west-1 \
  --target-db-instance-identifier substream-postgresql-eu-west-1-restored \
  --restore-time 2024-04-26T10:00:00Z \
  --region eu-west-1
```

### Issue: Soroban indexer not resuming

**Symptoms**: Indexer fails to start or processes wrong ledger

**Solution**:
```bash
# Check last processed ledger in database
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT last_processed_ledger FROM soroban_indexer_state;"

# Manually set last processed ledger if needed
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "UPDATE soroban_indexer_state SET last_processed_ledger = <correct_ledger>;"

# Restart indexer
kubectl rollout restart deployment/substream-worker -n substream --region eu-west-1
```

## Performance Considerations

### After Promotion

- Database may have reduced performance initially
- Query plans may need to be re-analyzed
- Consider running `ANALYZE` on all tables
- Monitor CPU and memory usage closely
- Scale up database instance if needed

### Optimization Commands

```bash
# Update statistics
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "ANALYZE;"

# Reindex if needed
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "REINDEX DATABASE substream;"

# Check for bloat
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) FROM pg_tables WHERE schemaname = 'public';"
```

## Estimated Timeline

| Step | Duration | Notes |
|------|----------|-------|
| Pre-failover verification | 5 minutes | Health checks |
| Stop application writes | 2 minutes | Scale down |
| Promote replica | 2-3 minutes | pg_promote() or RDS promote |
| Verify promotion | 1 minute | Quick checks |
| Update configuration | 2 minutes | Vault, ConfigMap |
| Clear Redis cache | 1 minute | FLUSHALL |
| Scale up applications | 5-8 minutes | Pod startup |
| Verify Soroban indexer | 2 minutes | Health check |
| Update DNS | 1-2 minutes | If manual |
| Post-failover tasks | 5 minutes | Backups, notification |
| **Total** | **15-20 minutes** | Within RTO |

## Success Criteria

The promotion is considered successful if:

1. PostgreSQL is promoted and accepting writes
2. All applications can connect to the database
3. No data loss (RPO < 15 minutes)
4. Soroban indexer resumes from last known ledger
5. Redis cache is cleared
6. DNS routing updated (if manual)
7. Backups configured for new primary
8. System performance is acceptable
9. All stakeholders notified
10. Documentation updated

## Contact Information

**Primary Contacts**:
- Database Administrator: dba@substream.app
- Platform Operations: ops@substream.app
- Incident Commander: oncall@substream.app

**Escalation**:
- If promotion fails: Senior DBA + AWS Support
- If data loss occurs: CTO + Legal Team
- If performance degradation: Engineering Lead

## Related Documentation

- [Disaster Recovery Architecture](./DISASTER_RECOVERY_ARCHITECTURE.md)
- [Game Day Exercise Guide](./GAME_DAY_EXERCISE.md)
- [Soroban Indexer Failover](./SOROBAN_INDEXER_FAILOVER.md)
