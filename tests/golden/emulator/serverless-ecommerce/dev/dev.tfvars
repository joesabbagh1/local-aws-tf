# ============================================================================
# Environment Variable Values: Development (dev.tfvars)
# Multi-Environment Matrix:
#   - dev      : region=us-east-1, port=9297, endpoint=https://127.0.0.1:9297
#   - testing  : region=us-east-1, port=9298, endpoint=https://127.0.0.1:9298
#   - staging  : region=us-west-2, port=9299, endpoint=https://127.0.0.1:9299
#   - prod     : region=us-west-2, port=9300, endpoint=https://127.0.0.1:9300
# ============================================================================

environment       = "dev"
aws_region        = "us-east-1"
emulator_port     = 9297
emulator_endpoint = "https://127.0.0.1:9297"

default_tags = {
  Environment = "dev"
  ManagedBy = "LocalCloudStudio"
  EmulatorPort = "9297"
}
