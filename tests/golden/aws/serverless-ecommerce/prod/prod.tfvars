# ============================================================================
# Environment Variable Values: Production (prod.tfvars)
# Multi-Environment Matrix:
#   - dev      : region=us-east-1
#   - testing  : region=us-east-1
#   - staging  : region=us-west-2
#   - prod     : region=us-west-2
# ============================================================================

environment = "prod"
aws_region  = "us-west-2"

default_tags = {
  Environment = "prod"
  ManagedBy = "LocalCloudStudio"
  Criticality = "High"
}
