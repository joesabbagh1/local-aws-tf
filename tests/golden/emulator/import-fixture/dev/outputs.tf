# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "payments_key_kms_key_arn" {
  description = "ARN of the KMS Key (KMS: Payments Key)"
  value       = aws_kms_key.payments_key.arn
}

output "payments_fn_lambda_arn" {
  description = "ARN of the Lambda function (Lambda: Payments-fn)"
  value       = aws_lambda_function.payments_fn.arn
}

output "payments_fn_invoke_arn" {
  description = "Invoke ARN for API Gateway (Lambda: Payments-fn)"
  value       = aws_lambda_function.payments_fn.invoke_arn
}

output "jobs_queue_url" {
  description = "URL of the SQS queue (SQS: Jobs)"
  value       = aws_sqs_queue.jobs.url
}

output "jobs_queue_arn" {
  description = "ARN of the SQS queue (SQS: Jobs)"
  value       = aws_sqs_queue.jobs.arn
}

output "legacy_iam_role_arn" {
  description = "ARN of the IAM Role (IAM Role: Legacy)"
  value       = aws_iam_role.legacy.arn
}
