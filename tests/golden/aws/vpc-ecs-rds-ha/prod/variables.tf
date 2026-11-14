variable "environment" {
  description = "Target deployment environment (dev, testing, staging, prod)"
  type        = string
  default     = "prod"
}

variable "aws_region" {
  description = "AWS Region for this environment"
  type        = string
  default     = "us-west-2"
}

variable "default_tags" {
  description = "Default resource tags applied across the environment"
  type        = map(string)
  default     = {
    Environment = "prod"
    ManagedBy = "LocalCloudStudio"
    Criticality = "High"
  }
}
