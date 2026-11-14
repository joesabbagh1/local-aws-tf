# ============================================================================
# Environment Variable Values: Testing / QA (testing.tfvars)
# Multi-Environment Matrix:
#   - dev      : region=us-east-1
#   - testing  : region=us-east-1
#   - staging  : region=us-west-2
#   - prod     : region=us-west-2
# ============================================================================

environment = "testing"
aws_region  = "us-east-1"

default_tags = {
  Environment = "testing"
  ManagedBy = "LocalCloudStudio"
}
