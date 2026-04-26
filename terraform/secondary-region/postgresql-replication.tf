# PostgreSQL Replication Configuration for Secondary Region
# This module configures asynchronous streaming replication from primary to secondary

# Primary Region PostgreSQL Configuration (Reference)
# This should be applied in the primary region (us-east-1)

resource "aws_db_parameter_group" "postgresql_primary" {
  name        = "substream-postgresql-primary-params"
  family      = "postgres15"
  description = "PostgreSQL primary parameter group for replication"

  parameter {
    name  = "wal_level"
    value = "replica"
  }

  parameter {
    name  = "max_wal_senders"
    value = "5"
  }

  parameter {
    name  = "max_replication_slots"
    value = "3"
  }

  parameter {
    name  = "wal_keep_size"
    value = "1024"  # 1GB
  }

  parameter {
    name  = "archive_mode"
    value = "on"
  }

  parameter {
    name  = "archive_command"
    value = "aws s3 cp %p s3://substream-backups/wal/%f"
  }

  parameter {
    name  = "archive_timeout"
    value = "300"
  }

  parameter {
    name  = "hot_standby_feedback"
    value = "on"
  }

  parameter {
    name  = "synchronous_commit"
    value = "off"  # Asynchronous replication for better performance
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  tags = {
    Environment = "production"
    Role        = "PrimaryRegion"
    Service     = "PostgreSQL"
  }
}

# Secondary Region PostgreSQL Configuration
resource "aws_db_parameter_group" "postgresql_replica" {
  name        = "substream-postgresql-replica-params"
  family      = "postgres15"
  description = "PostgreSQL replica parameter group"

  parameter {
    name  = "hot_standby"
    value = "on"
  }

  parameter {
    name  = "max_standby_streaming_delay"
    value = "30"  # 30 seconds
  }

  parameter {
    name  = "wal_receiver_status_interval"
    value = "10"
  }

  parameter {
    name  = "hot_standby_feedback"
    value = "on"
  }

  parameter {
    name  = "max_replication_slots"
    value = "3"
  }

  parameter {
    name  = "max_connections"
    value = "200"
  }

  parameter {
    name  = "shared_buffers"
    value = "{DBInstanceClassMemory/32768}"  # 25% of memory
  }

  parameter {
    name  = "effective_cache_size"
    value = "{DBInstanceClassMemory/16384}"  # 50% of memory
  }

  parameter {
    name  = "maintenance_work_mem"
    value = "{DBInstanceClassMemory/64}"  # 64MB
  }

  parameter {
    name  = "checkpoint_completion_target"
    value = "0.9"
  }

  parameter {
    name  = "wal_buffers"
    value = "16MB"
  }

  parameter {
    name  = "default_statistics_target"
    value = "100"
  }

  parameter {
    name  = "random_page_cost"
    value = "1.1"
  }

  parameter {
    name  = "effective_io_concurrency"
    value = "200"
  }

  parameter {
    name  = "work_mem"
    value = "{DBInstanceClassMemory/65536}"  # 4MB per connection
  }

  parameter {
    name  = "min_wal_size"
    value = "1GB"
  }

  parameter {
    name  = "max_wal_size"
    value = "4GB"
  }

  tags = {
    Environment = "production"
    Role        = "SecondaryRegion"
    Service     = "PostgreSQL"
  }
}

# PostgreSQL Option Group for Logical Replication (if needed)
resource "aws_db_option_group" "postgresql_logical" {
  name                 = "substream-postgresql-logical"
  option_group_description = "PostgreSQL option group with logical replication"
  engine_name          = "postgres"
  major_engine_version = "15"

  option {
    option_name = "pg_stat_statements"
    
    option_settings {
      name  = "pg_stat_statements.track"
      value = "ALL"
    }

    option_settings {
      name  = "pg_stat_statements.max"
      value = "10000"
    }
  }

  tags = {
    Environment = "production"
    Service     = "PostgreSQL"
  }
}

# CloudWatch Alarm for Replication Lag
resource "aws_cloudwatch_metric_alarm" "replication_lag" {
  alarm_name          = "substream-postgresql-replication-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "RDSToAuroraPostgreSQLReplicationLag"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "30"
  alarm_description   = "PostgreSQL replication lag exceeds 30 seconds"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgresql_replica.identifier
  }

  tags = {
    Environment = "production"
    Role        = "SecondaryRegion"
    Service     = "PostgreSQL"
  }
}

# SNS Topic for Alerts
resource "aws_sns_topic" "alerts" {
  name = "substream-dr-alerts"

  tags = {
    Environment = "production"
    Service     = "Monitoring"
  }
}

resource "aws_sns_topic_subscription" "email_alerts" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Variable for alert email
variable "alert_email" {
  description = "Email address for DR alerts"
  type        = string
  default     = "ops@substream.app"
}

# Replication Slot Management (Custom Resource)
# This would typically be managed by a Lambda function or custom script
# Here we document the required SQL commands

# Create replication slot on primary
# SELECT pg_create_physical_replication_slot('replica_slot_1');
# SELECT pg_create_physical_replication_slot('replica_slot_2');

# Monitor replication slots
# SELECT slot_name, slot_type, active, restart_lsn FROM pg_replication_slots;

# Drop replication slot (if needed)
# SELECT pg_drop_replication_slot('replica_slot_1');

# Manual Replication Setup Commands
# These should be executed during initial setup:

# On Primary (us-east-1):
# CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'secure_password';
# ALTER ROLE replicator WITH PASSWORD 'secure_password';
# GRANT CONNECT ON DATABASE substream TO replicator;
# GRANT USAGE ON SCHEMA public TO replicator;
# GRANT SELECT ON ALL TABLES IN SCHEMA public TO replicator;
# ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO replicator;

# pg_hba.conf configuration (managed by RDS parameter group):
# host    replication     replicator        10.1.0.0/16          scram-sha-256
# host    replication     replicator        10.0.0.0/16          scram-sha-256

# On Secondary (eu-west-1) - after replica is created:
# Verify replication status:
# SELECT * FROM pg_stat_replication;
# SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;

# Check recovery status:
# SELECT pg_is_in_recovery();
# SELECT pg_last_xlog_receive_location();
# SELECT pg_last_xlog_replay_location();

# Output replication configuration details
output "postgresql_replication_config" {
  description = "PostgreSQL replication configuration"
  value = {
    primary_parameter_group = aws_db_parameter_group.postgresql_primary.name
    replica_parameter_group = aws_db_parameter_group.postgresql_replica.name
    replication_lag_alarm   = aws_cloudwatch_metric_alarm.replication_lag.name
    sns_topic               = aws_sns_topic.alerts.arn
  }
}
