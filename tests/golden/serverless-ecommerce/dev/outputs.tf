# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "global_edge_cdn_cdn_domain_name" {
  description = "Domain name corresponding to the distribution (Global Edge CDN)"
  value       = aws_cloudfront_distribution.global_edge_cdn.domain_name
}

output "customer_identity_pool_user_pool_id" {
  description = "Cognito User Pool ID (Customer Identity Pool)"
  value       = aws_cognito_user_pool.customer_identity_pool.id
}

output "customer_identity_pool_user_pool_endpoint" {
  description = "Cognito Endpoint (Customer Identity Pool)"
  value       = aws_cognito_user_pool.customer_identity_pool.endpoint
}

output "core_commerce_api_api_endpoint" {
  description = "URI of the API Gateway (Core Commerce HTTP API)"
  value       = aws_apigatewayv2_api.core_commerce_api.api_endpoint
}

output "orders_api_handler_lambda_arn" {
  description = "ARN of the Lambda function (Orders API Handler)"
  value       = aws_lambda_function.orders_api_handler.arn
}

output "orders_api_handler_invoke_arn" {
  description = "Invoke ARN for API Gateway (Orders API Handler)"
  value       = aws_lambda_function.orders_api_handler.invoke_arn
}

output "fulfillment_worker_lambda_arn" {
  description = "ARN of the Lambda function (Fulfillment Worker)"
  value       = aws_lambda_function.fulfillment_worker.arn
}

output "fulfillment_worker_invoke_arn" {
  description = "Invoke ARN for API Gateway (Fulfillment Worker)"
  value       = aws_lambda_function.fulfillment_worker.invoke_arn
}

output "orders_table_table_name" {
  description = "DynamoDB Table Name (Orders Single-Table)"
  value       = aws_dynamodb_table.orders_table.name
}

output "orders_table_table_arn" {
  description = "DynamoDB Table ARN (Orders Single-Table)"
  value       = aws_dynamodb_table.orders_table.arn
}

output "order_fulfillment_queue_queue_url" {
  description = "URL of the SQS queue (Order Fulfillment Queue)"
  value       = aws_sqs_queue.order_fulfillment_queue.url
}

output "order_fulfillment_queue_queue_arn" {
  description = "ARN of the SQS queue (Order Fulfillment Queue)"
  value       = aws_sqs_queue.order_fulfillment_queue.arn
}

output "invoices_media_bucket_bucket_id" {
  description = "Name of the S3 bucket (Invoices & Media Bucket)"
  value       = aws_s3_bucket.invoices_media_bucket.id
}

output "invoices_media_bucket_bucket_arn" {
  description = "ARN of the S3 bucket (Invoices & Media Bucket)"
  value       = aws_s3_bucket.invoices_media_bucket.arn
}
