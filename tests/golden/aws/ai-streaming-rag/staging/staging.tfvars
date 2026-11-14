# ============================================================================
# Environment Variable Values: Staging (staging.tfvars)
# Multi-Environment Matrix:
#   - dev      : region=us-east-1
#   - testing  : region=us-east-1
#   - staging  : region=us-west-2
#   - prod     : region=us-west-2
# ============================================================================

environment = "staging"
aws_region  = "us-west-2"

default_tags = {
  Environment = "staging"
  ManagedBy = "LocalCloudStudio"
}
