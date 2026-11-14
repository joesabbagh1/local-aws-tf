# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "primary_vpc_vpc_id" {
  description = "The ID of the VPC (Primary Cloud VPC)"
  value       = aws_vpc.primary_vpc.id
}

output "primary_vpc_vpc_cidr" {
  description = "The CIDR block of the VPC (Primary Cloud VPC)"
  value       = aws_vpc.primary_vpc.cidr_block
}

output "public_ingress_subnet_subnet_id" {
  description = "The ID of the Subnet (Public Ingress Subnet)"
  value       = aws_subnet.public_ingress_subnet.id
}

output "private_app_subnet_subnet_id" {
  description = "The ID of the Subnet (Private App Subnet)"
  value       = aws_subnet.private_app_subnet.id
}

output "public_ingress_subnet_b_subnet_id" {
  description = "The ID of the Subnet (Public Ingress Subnet B)"
  value       = aws_subnet.public_ingress_subnet_b.id
}

output "private_app_subnet_b_subnet_id" {
  description = "The ID of the Subnet (Private App Subnet B)"
  value       = aws_subnet.private_app_subnet_b.id
}

output "public_ingress_alb_alb_dns_name" {
  description = "DNS name of the load balancer (Public Ingress ALB)"
  value       = aws_lb.public_ingress_alb.dns_name
}

output "public_ingress_alb_alb_arn" {
  description = "ARN of the load balancer (Public Ingress ALB)"
  value       = aws_lb.public_ingress_alb.arn
}

output "core_backend_fargate_ecs_cluster_arn" {
  description = "ECS Cluster ARN (Core Backend Fargate Service)"
  value       = aws_ecs_cluster.core_backend_fargate_cluster.arn
}

output "core_backend_fargate_ecs_service_name" {
  description = "ECS Service Name (Core Backend Fargate Service)"
  value       = aws_ecs_service.core_backend_fargate.name
}

output "primary_postgres_db_rds_endpoint" {
  description = "RDS connection endpoint (Primary PostgreSQL DB)"
  value       = aws_db_instance.primary_postgres_db.endpoint
}

output "session_redis_cache_primary_endpoint" {
  description = "Redis primary endpoint (Session & Query Cache)"
  value       = aws_elasticache_replication_group.session_redis_cache.primary_endpoint_address
}

output "db_credentials_secret_secret_arn" {
  description = "ARN of the Secret (Database Credentials Vault)"
  value       = aws_secretsmanager_secret.db_credentials_secret.arn
}
