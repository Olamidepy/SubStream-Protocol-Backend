# Route53 Failover Configuration
# This module configures DNS failover routing with health checks

# Health Check for Primary Region (us-east-1)
resource "aws_route53_health_check" "primary" {
  fqdn              = "api.substream.app"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
  success_threshold = 2

  tags = {
    Environment = "production"
    Region     = "us-east-1"
    Role       = "Primary"
  }
}

# Health Check for Secondary Region (eu-west-1)
resource "aws_route53_health_check" "secondary" {
  fqdn              = "api-eu.substream.app"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3
  success_threshold = 2

  tags = {
    Environment = "production"
    Region     = "eu-west-1"
    Role       = "Secondary"
  }
}

# Get hosted zone
data "aws_route53_zone" "main" {
  name = "substream.app"
}

# Primary Region Record Set
resource "aws_route53_record" "primary" {
  zone_id = data.aws_route53_zone.main.id
  name    = "api.substream.app"
  type    = "A"

  alias {
    name                   = aws_lb.primary.dns_name
    zone_id                = aws_lb.primary.zone_id
    evaluate_target_health = true
  }

  failover_routing_policy {
    type = "PRIMARY"
  }

  set_identifier = "primary-us-east-1"

  health_check_id = aws_route53_health_check.primary.id

  depends_on = [
    aws_lb.primary
  ]
}

# Secondary Region Record Set
resource "aws_route53_record" "secondary" {
  zone_id = data.aws_route53_zone.main.id
  name    = "api.substream.app"
  type    = "A"

  alias {
    name                   = aws_lb.secondary.dns_name
    zone_id                = aws_lb.secondary.zone_id
    evaluate_target_health = true
  }

  failover_routing_policy {
    type = "SECONDARY"
  }

  set_identifier = "secondary-eu-west-1"

  health_check_id = aws_route53_health_check.secondary.id

  depends_on = [
    aws_lb.secondary
  ]
}

# Load Balancer for Primary Region (Reference - deployed in primary region)
# This is a reference to the primary region's load balancer
# In production, this would be imported or referenced via data sources

# Load Balancer for Secondary Region
resource "aws_lb" "secondary" {
  name               = "substream-secondary-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets

  enable_deletion_protection = true
  enable_http2               = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb-logs"
    enabled = true
  }

  tags = {
    Environment = "production"
    Region     = "eu-west-1"
    Role       = "Secondary"
  }
}

# Load Balancer Target Group
resource "aws_lb_target_group" "backend" {
  name        = "substream-backend-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher {
      status_codes = ["200"]
    }
  }

  tags = {
    Environment = "production"
    Role        = "Secondary"
  }
}

# Load Balancer Listener
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.secondary.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.secondary.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# ACM Certificate
resource "aws_acm_certificate" "main" {
  domain_name       = "*.substream.app"
  validation_method = "DNS"

  subject_alternative_names = [
    "api.substream.app",
    "api-eu.substream.app"
  ]

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Environment = "production"
    Role        = "Secondary"
  }
}

# DNS Validation for ACM Certificate
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.id
}

# Wait for certificate validation
resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# Security Group for ALB
resource "aws_security_group" "alb" {
  name_prefix = "${var.cluster_name}-alb-"
  description = "Security group for Application Load Balancer"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Service     = "ALB"
  }
}

# S3 Bucket for ALB Logs
resource "aws_s3_bucket" "alb_logs" {
  bucket = "substream-alb-logs-${var.aws_region}"

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Service     = "ALB"
  }
}

resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "log-expiration"
    status = "Enabled"

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# CloudWatch Alarm for Health Check Failures
resource "aws_cloudwatch_metric_alarm" "primary_health_check" {
  alarm_name          = "substream-primary-health-check-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = "60"
  statistic           = "Minimum"
  threshold           = "0"
  alarm_description   = "Primary region health check failed"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    HealthCheckId = aws_route53_health_check.primary.id
  }

  tags = {
    Environment = "production"
    Region     = "us-east-1"
    Role       = "Primary"
  }
}

resource "aws_cloudwatch_metric_alarm" "secondary_health_check" {
  alarm_name          = "substream-secondary-health-check-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = "60"
  statistic           = "Minimum"
  threshold           = "0"
  alarm_description   = "Secondary region health check failed"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    HealthCheckId = aws_route53_health_check.secondary.id
  }

  tags = {
    Environment = "production"
    Region     = "eu-west-1"
    Role       = "Secondary"
  }
}

# DNS Failover Dashboard (CloudWatch)
resource "aws_cloudwatch_dashboard" "failover" {
  dashboard_name = "substream-dns-failover"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 2
        properties = {
          markdown = "# SubStream DNS Failover Dashboard"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 2
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/Route53", "HealthCheckStatus", "HealthCheckId", aws_route53_health_check.primary.id]
          ]
          period = 300
          stat   = "Minimum"
          region = "us-east-1"
          title  = "Primary Region Health Check"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 2
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/Route53", "HealthCheckStatus", "HealthCheckId", aws_route53_health_check.secondary.id]
          ]
          period = 300
          stat   = "Minimum"
          region = "eu-west-1"
          title  = "Secondary Region Health Check"
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 8
        width  = 24
        height = 6
        properties = {
          logGroupName = "/aws/route53/healthchecks"
          region       = "us-east-1"
          title        = "Route53 Health Check Logs"
          view         = "table"
        }
      }
    ]
  })
}

# Outputs
output "primary_health_check_id" {
  description = "Primary region health check ID"
  value       = aws_route53_health_check.primary.id
}

output "secondary_health_check_id" {
  description = "Secondary region health check ID"
  value       = aws_route53_health_check.secondary.id
}

output "primary_dns_record" {
  description = "Primary region DNS record"
  value       = aws_route53_record.primary.fqdn
}

output "secondary_dns_record" {
  description = "Secondary region DNS record"
  value       = aws_route53_record.secondary.fqdn
}

output "secondary_alb_dns" {
  description = "Secondary region ALB DNS name"
  value       = aws_lb.secondary.dns_name
}

output "secondary_alb_zone_id" {
  description = "Secondary region ALB zone ID"
  value       = aws_lb.secondary.zone_id
}

output "failover_dashboard" {
  description = "CloudWatch dashboard URL"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.failover.dashboard_name}"
}
