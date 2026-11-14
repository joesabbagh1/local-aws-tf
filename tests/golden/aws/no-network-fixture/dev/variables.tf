variable "environment" {
  description = "Target deployment environment (dev, testing, staging, prod)"
  type        = string
  default     = "dev"
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
    Environment = "dev"
    ManagedBy = "LocalCloudStudio"
  }
}

variable "vpc_id" {
  description = "Existing VPC for resources that are not placed in a VPC on the canvas"
  type        = string
}

variable "subnet_ids" {
  description = "Existing subnets for resources that are not placed in a subnet on the canvas"
  type        = list(string)
}
