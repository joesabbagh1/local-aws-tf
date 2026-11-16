# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "vpc_vpc_id" {
  description = "The ID of the VPC (vpc)"
  value       = aws_vpc.vpc.id
}

output "vpc_vpc_cidr" {
  description = "The CIDR block of the VPC (vpc)"
  value       = aws_vpc.vpc.cidr_block
}

output "subnet_subnet_id" {
  description = "The ID of the Subnet (subnet)"
  value       = aws_subnet.subnet.id
}

output "internet_gateway_igw_id" {
  description = "The ID of the Internet Gateway (internet_gateway)"
  value       = aws_internet_gateway.internet_gateway.id
}

output "nat_gateway_nat_public_ip" {
  description = "Public IP address of NAT Gateway (nat_gateway)"
  value       = aws_nat_gateway.nat_gateway.public_ip
}

output "route_table_route_table_id" {
  description = "ID of the routing table (route_table)"
  value       = aws_route_table.route_table.id
}

output "security_group_security_group_id" {
  description = "ID of the Security Group (security_group)"
  value       = aws_security_group.security_group.id
}

output "lb_alb_dns_name" {
  description = "DNS name of the load balancer (lb)"
  value       = aws_lb.lb.dns_name
}

output "lb_alb_arn" {
  description = "ARN of the load balancer (lb)"
  value       = aws_lb.lb.arn
}

output "apigatewayv2_api_api_endpoint" {
  description = "URI of the API Gateway (apigatewayv2_api)"
  value       = aws_apigatewayv2_api.apigatewayv2_api.api_endpoint
}

output "cloudfront_distribution_cdn_domain_name" {
  description = "Domain name corresponding to the distribution (cloudfront_distribution)"
  value       = aws_cloudfront_distribution.cloudfront_distribution.domain_name
}

output "route53_zone_zone_id" {
  description = "Hosted Zone ID (route53_zone)"
  value       = aws_route53_zone.route53_zone.zone_id
}

output "instance_instance_id" {
  description = "EC2 Instance ID (instance)"
  value       = aws_instance.instance.id
}

output "instance_private_ip" {
  description = "Private IPv4 address (instance)"
  value       = aws_instance.instance.private_ip
}

output "lambda_function_lambda_arn" {
  description = "ARN of the Lambda function (lambda_function)"
  value       = aws_lambda_function.lambda_function.arn
}

output "lambda_function_invoke_arn" {
  description = "Invoke ARN for API Gateway (lambda_function)"
  value       = aws_lambda_function.lambda_function.invoke_arn
}

output "autoscaling_group_asg_arn" {
  description = "ARN of the Auto Scaling Group (autoscaling_group)"
  value       = aws_autoscaling_group.autoscaling_group.arn
}

output "ecs_service_ecs_cluster_arn" {
  description = "ECS Cluster ARN (ecs_service)"
  value       = aws_ecs_cluster.ecs_service_cluster.arn
}

output "ecs_service_ecs_service_name" {
  description = "ECS Service Name (ecs_service)"
  value       = aws_ecs_service.ecs_service.name
}

output "eks_cluster_eks_endpoint" {
  description = "EKS API Server Endpoint (eks_cluster)"
  value       = aws_eks_cluster.eks_cluster.endpoint
}

output "ecr_repository_repository_url" {
  description = "URL of the ECR repository (ecr_repository)"
  value       = aws_ecr_repository.ecr_repository.repository_url
}

output "s3_bucket_bucket_id" {
  description = "Name of the S3 bucket (s3_bucket)"
  value       = aws_s3_bucket.s3_bucket.id
}

output "s3_bucket_bucket_arn" {
  description = "ARN of the S3 bucket (s3_bucket)"
  value       = aws_s3_bucket.s3_bucket.arn
}

output "efs_file_system_efs_id" {
  description = "EFS File System ID (efs_file_system)"
  value       = aws_efs_file_system.efs_file_system.id
}

output "efs_file_system_efs_dns_name" {
  description = "EFS Mount DNS Name (efs_file_system)"
  value       = aws_efs_file_system.efs_file_system.dns_name
}

output "dynamodb_table_table_name" {
  description = "DynamoDB Table Name (dynamodb_table)"
  value       = aws_dynamodb_table.dynamodb_table.name
}

output "dynamodb_table_table_arn" {
  description = "DynamoDB Table ARN (dynamodb_table)"
  value       = aws_dynamodb_table.dynamodb_table.arn
}

output "db_instance_rds_endpoint" {
  description = "RDS connection endpoint (db_instance)"
  value       = aws_db_instance.db_instance.endpoint
}

output "elasticache_cluster_cache_nodes" {
  description = "ElastiCache node connection details (elasticache_cluster)"
  value       = aws_elasticache_cluster.elasticache_cluster.cache_nodes
}

output "sqs_queue_queue_url" {
  description = "URL of the SQS queue (sqs_queue)"
  value       = aws_sqs_queue.sqs_queue.url
}

output "sqs_queue_queue_arn" {
  description = "ARN of the SQS queue (sqs_queue)"
  value       = aws_sqs_queue.sqs_queue.arn
}

output "sns_topic_topic_arn" {
  description = "ARN of the SNS Topic (sns_topic)"
  value       = aws_sns_topic.sns_topic.arn
}

output "cloudwatch_event_bus_event_bus_arn" {
  description = "ARN of the EventBridge Bus (cloudwatch_event_bus)"
  value       = aws_cloudwatch_event_bus.cloudwatch_event_bus.arn
}

output "sfn_state_machine_state_machine_arn" {
  description = "State Machine ARN (sfn_state_machine)"
  value       = aws_sfn_state_machine.sfn_state_machine.arn
}

output "iam_role_iam_role_arn" {
  description = "ARN of the IAM Role (iam_role)"
  value       = aws_iam_role.iam_role.arn
}

output "kms_key_kms_key_arn" {
  description = "ARN of the KMS Key (kms_key)"
  value       = aws_kms_key.kms_key.arn
}

output "secretsmanager_secret_secret_arn" {
  description = "ARN of the Secret (secretsmanager_secret)"
  value       = aws_secretsmanager_secret.secretsmanager_secret.arn
}

output "cognito_user_pool_user_pool_id" {
  description = "Cognito User Pool ID (cognito_user_pool)"
  value       = aws_cognito_user_pool.cognito_user_pool.id
}

output "cognito_user_pool_user_pool_endpoint" {
  description = "Cognito Endpoint (cognito_user_pool)"
  value       = aws_cognito_user_pool.cognito_user_pool.endpoint
}

output "cloudwatch_log_group_log_group_arn" {
  description = "CloudWatch Log Group ARN (cloudwatch_log_group)"
  value       = aws_cloudwatch_log_group.cloudwatch_log_group.arn
}

output "ssm_parameter_ssm_param_arn" {
  description = "ARN of the SSM Parameter (ssm_parameter)"
  value       = aws_ssm_parameter.ssm_parameter.arn
}

output "kinesis_stream_kinesis_arn" {
  description = "Kinesis Stream ARN (kinesis_stream)"
  value       = aws_kinesis_stream.kinesis_stream.arn
}

output "opensearch_domain_opensearch_endpoint" {
  description = "Domain-specific endpoint (opensearch_domain)"
  value       = aws_opensearch_domain.opensearch_domain.endpoint
}

output "bedrock_agent_agent_id" {
  description = "Bedrock Agent Identifier (bedrock_agent)"
  value       = aws_bedrockagent_agent.bedrock_agent.id
}

output "lambda_function_2_lambda_arn" {
  description = "ARN of the Lambda function (lambda_function_2)"
  value       = aws_lambda_function.lambda_function_2.arn
}

output "lambda_function_2_invoke_arn" {
  description = "Invoke ARN for API Gateway (lambda_function_2)"
  value       = aws_lambda_function.lambda_function_2.invoke_arn
}

output "sfn_state_machine_2_state_machine_arn" {
  description = "State Machine ARN (sfn_state_machine_2)"
  value       = aws_sfn_state_machine.sfn_state_machine_2.arn
}

output "bedrock_agent_2_agent_id" {
  description = "Bedrock Agent Identifier (bedrock_agent_2)"
  value       = aws_bedrockagent_agent.bedrock_agent_2.id
}
