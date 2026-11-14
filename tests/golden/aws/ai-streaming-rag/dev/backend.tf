# Remote state in S3. The settings live in backend.tfbackend so each environment
# can point at its own bucket or account:
#   terraform init -backend-config=backend.tfbackend
#
# Using Terraform Cloud or another backend instead? Replace this block.

terraform {
  backend "s3" {}
}
