variable "environment" {
  description = "Target deployment environment (dev, testing, staging, prod)"
  type        = string
  default     = "testing"
}

variable "aws_region" {
  description = "AWS Region for this environment"
  type        = string
  default     = "us-east-1"
}

variable "default_tags" {
  description = "Default resource tags applied across the environment"
  type        = map(string)
  default     = {
    Environment = "testing"
    ManagedBy = "LocalCloudStudio"
  }
}
