# ============================================================================
# AWS Emulator Provider Configuration (https://github.com/aws/aws-emulator)
# Environment: Development (dev) -> HTTPS Endpoint 127.0.0.1:9297
# ============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Point all AWS API operations to local aws-emulator router instance for [dev]
  endpoints {
    apigateway     = var.emulator_endpoint
    apigatewayv2   = var.emulator_endpoint
    autoscaling    = var.emulator_endpoint
    bedrock        = var.emulator_endpoint
    bedrockagent   = var.emulator_endpoint
    cloudfront     = var.emulator_endpoint
    cloudwatch     = var.emulator_endpoint
    cognitoidp     = var.emulator_endpoint
    dynamodb       = var.emulator_endpoint
    ec2            = var.emulator_endpoint
    ecr            = var.emulator_endpoint
    ecs            = var.emulator_endpoint
    efs            = var.emulator_endpoint
    eks            = var.emulator_endpoint
    elasticache    = var.emulator_endpoint
    elbv2          = var.emulator_endpoint
    events         = var.emulator_endpoint
    iam            = var.emulator_endpoint
    kinesis        = var.emulator_endpoint
    kms            = var.emulator_endpoint
    lambda         = var.emulator_endpoint
    logs           = var.emulator_endpoint
    opensearch     = var.emulator_endpoint
    rds            = var.emulator_endpoint
    route53        = var.emulator_endpoint
    s3             = var.emulator_endpoint
    secretsmanager = var.emulator_endpoint
    sfn            = var.emulator_endpoint
    sns            = var.emulator_endpoint
    sqs            = var.emulator_endpoint
    ssm            = var.emulator_endpoint
    sts            = var.emulator_endpoint
  }

  # AWS Emulator local credentials & self-signed CA bundle (~/.aws/emulator/9297/)
  shared_credentials_files = [pathexpand("~/.aws/emulator/${var.emulator_port}/emulator_credentials")]
  shared_config_files      = [pathexpand("~/.aws/emulator/${var.emulator_port}/config")]
  custom_ca_bundle         = pathexpand("~/.aws/emulator/${var.emulator_port}/ca.pem")

  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  default_tags {
    tags = var.default_tags
  }
}
