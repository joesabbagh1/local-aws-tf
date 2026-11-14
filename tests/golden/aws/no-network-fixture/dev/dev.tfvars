# ============================================================================
# Environment Variable Values: Development (dev.tfvars)
# Multi-Environment Matrix:
#   - dev      : region=us-east-1
#   - testing  : region=us-east-1
#   - staging  : region=us-west-2
#   - prod     : region=us-west-2
# ============================================================================

environment = "dev"
aws_region  = "us-east-1"

default_tags = {
  Environment = "dev"
  ManagedBy = "LocalCloudStudio"
}

# Required: some resources need a network, and the canvas has no VPC or Subnet for them in dev.
# Either place them in a VPC / Subnet on the canvas, or point them at existing ones here.
vpc_id     = "CHANGE-ME"  # e.g. "vpc-0123456789abcdef0"
subnet_ids = ["CHANGE-ME"] # e.g. ["subnet-0aaa...", "subnet-0bbb..."]
