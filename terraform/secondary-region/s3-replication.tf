# S3 Cross-Region Replication (CRR) Configuration
# This module configures cross-region replication from primary (us-east-1) to secondary (eu-west-1)

# IAM Role for S3 Replication
resource "aws_iam_role" "s3_replication" {
  name = "substream-s3-replication-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "s3.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Environment = "production"
    Service     = "S3"
    Role        = "Replication"
  }
}

# IAM Policy for S3 Replication
resource "aws_iam_policy" "s3_replication" {
  name        = "substream-s3-replication-policy"
  description = "Policy for S3 cross-region replication"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetReplicationConfiguration",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning"
        ]
        Resource = [
          "arn:aws:s3:::substream-pdf-receipts-us-east-1",
          "arn:aws:s3:::substream-merchant-data-us-east-1",
          "arn:aws:s3:::substream-video-storage-us-east-1"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:List*",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning"
        ]
        Resource = [
          "arn:aws:s3:::substream-pdf-receipts-eu-west-1",
          "arn:aws:s3:::substream-merchant-data-eu-west-1",
          "arn:aws:s3:::substream-video-storage-eu-west-1"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
          "s3:GetObjectRetention",
          "s3:GetObjectVersionTagging",
          "s3:PutObjectRetention"
        ]
        Resource = [
          "arn:aws:s3:::substream-pdf-receipts-eu-west-1/*",
          "arn:aws:s3:::substream-merchant-data-eu-west-1/*",
          "arn:aws:s3:::substream-video-storage-eu-west-1/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectVersionTagging"
        ]
        Resource = [
          "arn:aws:s3:::substream-pdf-receipts-us-east-1/*",
          "arn:aws:s3:::substream-merchant-data-us-east-1/*",
          "arn:aws:s3:::substream-video-storage-us-east-1/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "s3_replication" {
  role       = aws_iam_role.s3_replication.name
  policy_arn = aws_iam_policy.s3_replication.arn
}

# PDF Receipts Bucket Replication (Primary to Secondary)
# Note: This is configured on the PRIMARY region bucket
# Here we document the configuration that should be applied in us-east-1

# PDF Receipts Bucket (Primary Region - Reference)
# This would be configured in the primary region Terraform

# PDF Receipts Bucket Replication Configuration
resource "aws_s3_bucket_replication_configuration" "pdf_receipts" {
  # This should be applied to the primary bucket in us-east-1
  # bucket = aws_s3_bucket.pdf_receipts_primary.id
  
  role = aws_iam_role.s3_replication.arn

  rule {
    id     = "pdf-receipts-replication"
    status = "Enabled"

    destination {
      bucket        = "arn:aws:s3:::substream-pdf-receipts-eu-west-1"
      storage_class = "STANDARD"
      account_id    = data.aws_caller_identity.current.account_id
      access_control_translation = {
        owner = "Destination"
      }
      metrics {
        minutes = 15
        status  = "Enabled"
      }
      replication_time {
        minutes = 15
        status  = "Enabled"
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      status = "Enabled"
    }

    filter {
      prefix = ""
    }
  }
}

# Merchant Data Bucket Replication Configuration
resource "aws_s3_bucket_replication_configuration" "merchant_data" {
  # This should be applied to the primary bucket in us-east-1
  # bucket = aws_s3_bucket.merchant_data_primary.id
  
  role = aws_iam_role.s3_replication.arn

  rule {
    id     = "merchant-data-replication"
    status = "Enabled"

    destination {
      bucket        = "arn:aws:s3:::substream-merchant-data-eu-west-1"
      storage_class = "STANDARD_IA"  # Use Infrequent Access for cost optimization
      account_id    = data.aws_caller_identity.current.account_id
      access_control_translation = {
        owner = "Destination"
      }
      metrics {
        minutes = 15
        status  = "Enabled"
      }
      replication_time {
        minutes = 15
        status  = "Enabled"
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      status = "Enabled"
    }

    filter {
      prefix = ""
    }
  }
}

# Video Storage Bucket Replication Configuration
resource "aws_s3_bucket_replication_configuration" "video_storage" {
  # This should be applied to the primary bucket in us-east-1
  # bucket = aws_s3_bucket.video_storage_primary.id
  
  role = aws_iam_role.s3_replication.arn

  rule {
    id     = "video-storage-replication"
    status = "Enabled"

    destination {
      bucket        = "arn:aws:s3:::substream-video-storage-eu-west-1"
      storage_class = "GLACIER"  # Use Glacier for video archival
      account_id    = data.aws_caller_identity.current.account_id
      access_control_translation = {
        owner = "Destination"
      }
      metrics {
        minutes = 15
        status  = "Enabled"
      }
      replication_time {
        minutes = 60  # Video files can take longer to replicate
        status  = "Enabled"
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      status = "Enabled"
    }

    filter {
      prefix = ""
    }
  }
}

# CloudWatch Metrics for Replication
resource "aws_cloudwatch_metric_alarm" "replication_latency" {
  for_each = toset(["pdf-receipts", "merchant-data", "video-storage"])

  alarm_name          = "substream-s3-replication-latency-${each.value}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "3"
  metric_name         = "ReplicationLatency"
  namespace           = "AWS/S3"
  period              = 300
  statistic           = "Average"
  threshold           = 1800  # 30 minutes
  alarm_description   = "S3 replication latency exceeds 30 minutes for ${each.value}"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    BucketName = "substream-${each.value}-us-east-1"
  }

  tags = {
    Environment = "production"
    Service     = "S3"
    Bucket      = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "replication_errors" {
  for_each = toset(["pdf-receipts", "merchant-data", "video-storage"])

  alarm_name          = "substream-s3-replication-errors-${each.value}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ReplicationBytesFailed"
  namespace           = "AWS/S3"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "S3 replication errors detected for ${each.value}"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    BucketName = "substream-${each.value}-us-east-1"
  }

  tags = {
    Environment = "production"
    Service     = "S3"
    Bucket      = each.value
  }
}

# Lifecycle Policies for Secondary Region Buckets
resource "aws_s3_bucket_lifecycle_configuration" "pdf_receipts_secondary" {
  bucket = aws_s3_bucket.pdf_receipts.id

  rule {
    id     = "pdf-receipts-lifecycle"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 180
      storage_class = "GLACIER"
    }

    expiration {
      days = 365  # Retain for 1 year
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "merchant_data_secondary" {
  bucket = aws_s3_bucket.merchant_data.id

  rule {
    id     = "merchant-data-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 2555  # Retain for 7 years (compliance)
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "video_storage_secondary" {
  bucket = aws_s3_bucket.video_storage.id

  rule {
    id     = "video-storage-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    transition {
      days          = 365
      storage_class = "DEEP_ARCHIVE"
    }

    expiration {
      days = 730  # Retain for 2 years
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# S3 Event Notifications for Replication Status
resource "aws_s3_bucket_notification" "replication_events" {
  bucket = aws_s3_bucket.pdf_receipts.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.replication_monitor.arn
    events              = ["s3:Replication:OperationFailedReplication"]
    filter_prefix       = ""
    filter_suffix       = ""
  }

  depends_on = [
    aws_lambda_permission.replication_monitor
  ]
}

# Lambda Function for Replication Monitoring
resource "aws_lambda_function" "replication_monitor" {
  filename      = "replication_monitor.zip"
  function_name = "s3-replication-monitor"
  role          = aws_iam_role.lambda_replication.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"

  environment {
    variables = {
      ALERT_SNS_TOPIC = aws_sns_topic.alerts.arn
    }
  }

  tags = {
    Environment = "production"
    Service     = "S3"
    Function    = "ReplicationMonitor"
  }
}

resource "aws_iam_role" "lambda_replication" {
  name = "lambda-replication-monitor-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_replication.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_s3" {
  name = "lambda-s3-access"
  role = aws_iam_role.lambda_replication.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::substream-pdf-receipts-eu-west-1",
          "arn:aws:s3:::substream-pdf-receipts-eu-west-1/*"
        ]
      },
      {
        Effect = "Allow"
        Action = "sns:Publish"
        Resource = aws_sns_topic.alerts.arn
      }
    ]
  })
}

resource "aws_lambda_permission" "replication_monitor" {
  statement_id  = "AllowS3Invocation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.replication_monitor.function_name
  principal     = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.pdf_receipts.arn
}

# Data source for current account
data "aws_caller_identity" "current" {}

# Outputs
output "s3_replication_role_arn" {
  description = "IAM role ARN for S3 replication"
  value       = aws_iam_role.s3_replication.arn
}

output "secondary_bucket_arns" {
  description = "ARNs of secondary region S3 buckets"
  value = {
    pdf_receipts  = aws_s3_bucket.pdf_receipts.arn
    merchant_data = aws_s3_bucket.merchant_data.arn
    video_storage = aws_s3_bucket.video_storage.arn
  }
}

output "replication_configuration" {
  description = "S3 replication configuration status"
  value = {
    pdf_receipts_replication  = aws_s3_bucket_replication_configuration.pdf_receipts.id
    merchant_data_replication = aws_s3_bucket_replication_configuration.merchant_data.id
    video_storage_replication  = aws_s3_bucket_replication_configuration.video_storage.id
  }
}
