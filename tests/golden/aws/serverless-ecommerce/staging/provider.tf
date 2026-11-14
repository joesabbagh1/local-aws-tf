# ============================================================================
# AWS Provider: Staging (staging), us-west-2
# Credentials come from your usual AWS setup (profile, SSO, CI role).
# Remote state is configured in backend.tf.
# ============================================================================

terraform {
  # 1.10+ for S3 native state locking (use_lockfile in backend.tfbackend)
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.default_tags
  }
}
