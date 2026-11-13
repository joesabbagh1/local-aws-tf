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

variable "emulator_port" {
  description = "Local AWS Emulator port for isolated environment state"
  type        = number
  default     = 9300
}

variable "emulator_endpoint" {
  description = "Local AWS Emulator HTTPS endpoint URL"
  type        = string
  default     = "https://127.0.0.1:9300"
}

variable "default_tags" {
  description = "Default resource tags applied across the environment"
  type        = map(string)
  default     = {
    Environment = "prod"
    ManagedBy = "LocalCloudStudio"
    Criticality = "High"
    EmulatorPort = "9300"
  }
}
