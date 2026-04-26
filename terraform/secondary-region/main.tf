# Secondary Region (eu-west-1) Terraform Configuration
# This script deploys a passive, scaled-down version of the Kubernetes cluster

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.11"
    }
  }
  
  backend "s3" {
    bucket         = "substream-terraform-state"
    key            = "secondary-region/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Environment = var.environment
      ManagedBy   = "Terraform"
      Role        = "SecondaryRegion"
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
    }
  }
}

# Variables
variable "aws_region" {
  description = "AWS region for secondary cluster"
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "substream-secondary"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.1.0.0/16"
}

variable "primary_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-1"
}

variable "primary_vpc_cidr" {
  description = "Primary VPC CIDR for VPN/VPC peering"
  type        = string
  default     = "10.0.0.0/16"
}

# VPC Module
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs              = ["${var.aws_region}a", "${var.aws_region}b"]
  private_subnets  = ["10.1.1.0/24", "10.1.2.0/24"]
  public_subnets   = ["10.1.101.0/24", "10.1.102.0/24"]
  database_subnets = ["10.1.201.0/24", "10.1.202.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway    = true
  enable_vpn_gateway    = false
  enable_dns_hostnames  = true
  enable_dns_support    = true

  # VPC Peering with primary region
  enable_vpn_peering              = true
  vpn_peering_primary_region     = var.primary_region
  vpn_peering_primary_vpc_cidr   = var.primary_vpc_cidr

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# EKS Module
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.28"

  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  # Cluster endpoint configuration
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  # Addons
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    aws-ebs-csi-driver = {
      most_recent = true
    }
  }

  # EKS Managed Node Groups (scaled down for standby)
  eks_managed_node_groups = {
    # Primary node group (scaled down)
    primary = {
      name           = "primary-nodegroup"
      instance_types = ["m5.large"]
      min_size       = 1
      max_size       = 5
      desired_size   = 2

      labels = {
        role = "primary"
      }

      taints = []
    }

    # Worker node group (scaled down)
    workers = {
      name           = "worker-nodegroup"
      instance_types = ["m5.large"]
      min_size       = 1
      max_size       = 3
      desired_size   = 1

      labels = {
        role = "worker"
      }

      taints = []
    }
  }

  # Cluster access
  manage_aws_auth_configmap = true
  create_aws_auth_configmap  = true

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# PostgreSQL Read-Replica (RDS)
resource "aws_db_instance" "postgresql_replica" {
  identifier              = "${var.cluster_name}-postgresql"
  instance_class          = "db.t3.medium"
  engine                  = "postgres"
  engine_version          = "15.4"
  allocated_storage       = 100
  storage_type            = "gp3"
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.database.arn

  # Replication configuration
  replicate_source_db     = "substream-postgresql-primary"
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window     = "Mon:04:00-Mon:05:00"

  # Network configuration
  db_subnet_group_name    = aws_db_subnet_group.secondary.name
  vpc_security_group_ids  = [aws_security_group.database.id]
  publicly_accessible     = false

  # Performance and monitoring
  performance_insights_enabled = true
  monitoring_interval         = 60
  monitoring_role_arn        = aws_iam_role.rds_monitoring.arn

  # Tags
  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Type        = "ReadReplica"
  }

  # Don't create final snapshot (it's a replica)
  skip_final_snapshot = true

  # Ensure replica is in the same region as the module
  depends_on = [
    aws_kms_key.database,
    aws_db_subnet_group.secondary,
    aws_security_group.database
  ]
}

# Redis Cluster (ElastiCache) - Warm Standby
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id          = "${var.cluster_name}-redis"
  replication_group_description = "SubStream Redis Cluster - Secondary Region"
  node_type                     = "cache.m5.large"
  number_cache_clusters         = 3
  engine                        = "redis"
  engine_version                = "7.0"
  parameter_group_name          = "default.redis7"
  port                          = 6379
  automatic_failover_enabled    = true
  multi_az_enabled              = true
  
  # Security
  security_group_ids            = [aws_security_group.redis.id]
  subnet_group_name             = aws_elasticache_subnet_group.redis.name
  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true
  auth_token                    = var.redis_auth_token

  # Maintenance
  maintenance_window            = "sun:05:00-sun:06:00"
  snapshot_window               = "05:00-06:00"
  snapshot_retention_limit      = 5

  # Tags
  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# S3 Buckets (Replicas)
resource "aws_s3_bucket" "pdf_receipts" {
  bucket = "substream-pdf-receipts-${var.aws_region}"

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Type        = "Replica"
  }
}

resource "aws_s3_bucket_versioning" "pdf_receipts" {
  bucket = aws_s3_bucket.pdf_receipts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pdf_receipts" {
  bucket = aws_s3_bucket.pdf_receipts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "pdf_receipts" {
  bucket = aws_s3_bucket.pdf_receipts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 Bucket for Merchant Data
resource "aws_s3_bucket" "merchant_data" {
  bucket = "substream-merchant-data-${var.aws_region}"

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Type        = "Replica"
  }
}

resource "aws_s3_bucket_versioning" "merchant_data" {
  bucket = aws_s3_bucket.merchant_data.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "merchant_data" {
  bucket = aws_s3_bucket.merchant_data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "merchant_data" {
  bucket = aws_s3_bucket.merchant_data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 Bucket for Video Storage
resource "aws_s3_bucket" "video_storage" {
  bucket = "substream-video-storage-${var.aws_region}"

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Type        = "Replica"
  }
}

resource "aws_s3_bucket_versioning" "video_storage" {
  bucket = aws_s3_bucket.video_storage.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "video_storage" {
  bucket = aws_s3_bucket.video_storage.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "video_storage" {
  bucket = aws_s3_bucket.video_storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# KMS Keys for encryption
resource "aws_kms_key" "database" {
  description             = "KMS key for PostgreSQL encryption in secondary region"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
    Service     = "PostgreSQL"
  }
}

resource "aws_kms_alias" "database" {
  name          = "alias/substream-db-secondary"
  target_key_id = aws_kms_key.database.id
}

# Security Groups
resource "aws_security_group" "database" {
  name_prefix = "${var.cluster_name}-db-"
  description = "Security group for PostgreSQL replica"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr, var.primary_vpc_cidr]
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
    Service     = "PostgreSQL"
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.cluster_name}-redis-"
  description = "Security group for Redis cluster"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
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
    Service     = "Redis"
  }
}

# DB Subnet Group
resource "aws_db_subnet_group" "secondary" {
  name       = "${var.cluster_name}-db-subnet-group"
  subnet_ids = module.vpc.database_subnets

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# ElastiCache Subnet Group
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.cluster_name}-redis-subnet-group"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# IAM Roles
resource "aws_iam_role" "rds_monitoring" {
  name = "${var.cluster_name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Environment = var.environment
    Role        = "SecondaryRegion"
  }
}

# Helm Release for SubStream Backend (Scaled Down)
resource "helm_release" "substream_backend" {
  name       = "substream-backend"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "node"
  namespace  = "substream"
  create_namespace = true

  set {
    name  = "image.repository"
    value = "substream/backend"
  }

  set {
    name  = "image.tag"
    value = "latest"
  }

  set {
    name  = "replicaCount"
    value = "1"  # Scaled down for standby
  }

  set {
    name  = "resources.requests.memory"
    value = "128Mi"
  }

  set {
    name  = "resources.requests.cpu"
    value = "100m"
  }

  set {
    name  = "resources.limits.memory"
    value = "256Mi"
  }

  set {
    name  = "resources.limits.cpu"
    value = "200m"
  }

  # Vault configuration (disabled in standby)
  set {
    name  = "vault.enabled"
    value = "true"
  }

  set {
    name  = "vault.addr"
    value = "http://vault-secondary:8200"
  }

  set {
    name  = "vault.role"
    value = "substream-backend-secondary"
  }

  # Environment variables
  set {
    name  = "env.NODE_ENV"
    value = "production"
  }

  set {
    name  = "env.REGION"
    value = var.aws_region
  }

  set {
    name  = "env.STANDBY_MODE"
    value = "true"
  }

  depends_on = [
    module.eks
  ]
}

# Helm Release for Worker (Scaled Down)
resource "helm_release" "substream_worker" {
  name       = "substream-worker"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "node"
  namespace  = "substream"

  set {
    name  = "image.repository"
    value = "substream/backend"
  }

  set {
    name  = "image.tag"
    value = "latest"
  }

  set {
    name  = "replicaCount"
    value = "1"  # Scaled down for standby
  }

  set {
    name  = "command"
    value = "[\"node\", \"worker.js\", \"--soroban\"]"
  }

  set {
    name  = "resources.requests.memory"
    value = "128Mi"
  }

  set {
    name  = "resources.requests.cpu"
    value = "100m"
  }

  set {
    name  = "resources.limits.memory"
    value = "256Mi"
  }

  set {
    name  = "resources.limits.cpu"
    value = "200m"
  }

  # Vault configuration
  set {
    name  = "vault.enabled"
    value = "true"
  }

  set {
    name  = "vault.addr"
    value = "http://vault-secondary:8200"
  }

  set {
    name  = "vault.role"
    value = "substream-worker-secondary"
  }

  # Environment variables
  set {
    name  = "env.NODE_ENV"
    value = "production"
  }

  set {
    name  = "env.REGION"
    value = var.aws_region
  }

  set {
    name  = "env.STANDBY_MODE"
    value = "true"
  }

  depends_on = [
    module.eks,
    helm_release.substream_backend
  ]
}

# Outputs
output "cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_security_group_id" {
  description = "Security group ID attached to the EKS cluster"
  value       = module.eks.cluster_security_group_id
}

output "postgresql_endpoint" {
  description = "PostgreSQL replica endpoint"
  value       = aws_db_instance.postgresql_replica.endpoint
}

output "redis_endpoint" {
  description = "Redis cluster endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "s3_buckets" {
  description = "S3 bucket names in secondary region"
  value = {
    pdf_receipts  = aws_s3_bucket.pdf_receipts.id
    merchant_data = aws_s3_bucket.merchant_data.id
    video_storage = aws_s3_bucket.video_storage.id
  }
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "region" {
  description = "AWS region"
  value       = var.aws_region
}

# Variable for Redis auth token (should be passed securely)
variable "redis_auth_token" {
  description = "Auth token for Redis cluster"
  type        = string
  sensitive   = true
}
