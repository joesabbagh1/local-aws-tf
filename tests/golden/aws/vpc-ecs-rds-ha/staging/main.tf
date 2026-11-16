# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (STAGING)
# Target Mode: AWS (us-west-2)
# Active Resources: 10 | Wired Connections: 4
# ============================================================================

locals {
  environment = var.environment
  name_prefix = "lc-${var.environment}"
  common_tags = merge(var.default_tags, {
    Environment = var.environment
    Region      = var.aws_region
    Compiler    = "LocalCloud-Studio-2D"
  })
}

resource "aws_vpc" "primary_vpc" {
  cidr_block                       = "10.30.0.0/16"
  instance_tenancy                 = "default"
  enable_dns_support               = true
  enable_dns_hostnames             = true
  assign_generated_ipv6_cidr_block = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-primary_vpc"
  })
}

resource "aws_subnet" "public_ingress_subnet" {
  vpc_id                  = aws_vpc.primary_vpc.id
  cidr_block              = "10.30.1.0/24"
  availability_zone       = "us-west-2a"
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public_ingress_subnet"
    Tier = "public"
  })
}

resource "aws_subnet" "private_app_subnet" {
  vpc_id                  = aws_vpc.primary_vpc.id
  cidr_block              = "10.30.10.0/24"
  availability_zone       = "us-west-2a"
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private_app_subnet"
    Tier = "private"
  })
}

resource "aws_subnet" "public_ingress_subnet_b" {
  vpc_id                  = aws_vpc.primary_vpc.id
  cidr_block              = "10.30.2.0/24"
  availability_zone       = "us-west-2b"
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public_ingress_subnet_b"
    Tier = "public"
  })
}

resource "aws_subnet" "private_app_subnet_b" {
  vpc_id                  = aws_vpc.primary_vpc.id
  cidr_block              = "10.30.11.0/24"
  availability_zone       = "us-west-2b"
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private_app_subnet_b"
    Tier = "private"
  })
}

resource "aws_lb" "public_ingress_alb" {
  name                       = trimsuffix(substr("${local.name_prefix}-public-ingress-alb", 0, 32), "-")
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = [aws_subnet.public_ingress_subnet.id, aws_subnet.public_ingress_subnet_b.id]
  security_groups            = []
  enable_deletion_protection = false
  idle_timeout               = 60

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public_ingress_alb"
  })
}

resource "aws_lb_target_group" "public_ingress_alb_tg" {
  name        = trimsuffix(substr("${local.name_prefix}-public-ingress-alb-tg", 0, 32), "-")
  port        = 443
  protocol    = "HTTP"
  vpc_id      = aws_vpc.primary_vpc.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener" "public_ingress_alb_listener" {
  load_balancer_arn = aws_lb.public_ingress_alb.arn
  port              = 443
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.public_ingress_alb_tg.arn
  }
}

resource "aws_ecs_cluster" "core_backend_fargate_cluster" {
  name = "${local.name_prefix}-core_backend_fargate-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.common_tags
}

# Execution role: lets ECS pull the image and write logs
resource "aws_iam_role" "core_backend_fargate_exec_role" {
  name = "${local.name_prefix}-core_backend_fargate-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "core_backend_fargate_exec_role" {
  role       = aws_iam_role.core_backend_fargate_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: what the containers themselves may call
resource "aws_iam_role" "core_backend_fargate_task_role" {
  name = "${local.name_prefix}-core_backend_fargate-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# ECS Exec needs the task to open SSM sessions
resource "aws_iam_role_policy" "core_backend_fargate_task_exec_command" {
  name = "ecs-exec"
  role = aws_iam_role.core_backend_fargate_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_ecs_task_definition" "core_backend_fargate_task" {
  family                   = "${local.name_prefix}-core_backend_fargate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.core_backend_fargate_exec_role.arn
  task_role_arn            = aws_iam_role.core_backend_fargate_task_role.arn

  container_definitions = jsonencode([
    {
      name      = "core_backend_fargate"
      image     = "111122223333.dkr.ecr.us-east-1.amazonaws.com/backend:latest"
      essential = true
      portMappings = [
        {
          containerPort = 8080
          hostPort      = 8080
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "ENVIRONMENT", value = var.environment },
        { name = "PRIMARY_POSTGRES_DB_HOST", value = tostring(aws_db_instance.primary_postgres_db.address) },
        { name = "PRIMARY_POSTGRES_DB_PORT", value = tostring(aws_db_instance.primary_postgres_db.port) },
        { name = "PRIMARY_POSTGRES_DB_NAME", value = tostring(aws_db_instance.primary_postgres_db.db_name) },
        { name = "PRIMARY_POSTGRES_DB_SECRET_ARN", value = tostring(try(aws_db_instance.primary_postgres_db.master_user_secret[0].secret_arn, "")) },
        { name = "SESSION_REDIS_CACHE_HOST", value = tostring(aws_elasticache_replication_group.session_redis_cache.primary_endpoint_address) },
        { name = "SESSION_REDIS_CACHE_PORT", value = tostring(aws_elasticache_replication_group.session_redis_cache.port) },
        { name = "DB_CREDENTIALS_SECRET_SECRET_ARN", value = tostring(aws_secretsmanager_secret.db_credentials_secret.arn) }
      ]
    }
  ])
}

resource "aws_ecs_service" "core_backend_fargate" {
  name                   = "${local.name_prefix}-core_backend_fargate"
  cluster                = aws_ecs_cluster.core_backend_fargate_cluster.id
  task_definition        = aws_ecs_task_definition.core_backend_fargate_task.arn
  desired_count          = 3
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets          = [aws_subnet.private_app_subnet.id]
    security_groups  = []
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.public_ingress_alb_tg.arn
    container_name   = "core_backend_fargate"
    container_port   = 8080
  }

  tags = local.common_tags
  depends_on = [aws_lb_listener.public_ingress_alb_listener]
}

resource "aws_db_subnet_group" "primary_postgres_db_subnets" {
  name       = trimsuffix(substr("${local.name_prefix}-primary-postgres-db-subnets", 0, 255), "-")
  subnet_ids = [aws_subnet.private_app_subnet.id, aws_subnet.private_app_subnet_b.id]

  tags = local.common_tags
}

resource "aws_db_instance" "primary_postgres_db" {
  identifier              = trimsuffix(substr("${local.name_prefix}-primary-postgres-db", 0, 63), "-")
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 50
  max_allocated_storage   = 100
  db_name                 = "core_platform"
  username                = "postgres_admin"
  manage_master_user_password = true
  multi_az                = true
  storage_encrypted       = true
  backup_retention_period = 7
  skip_final_snapshot     = true
  vpc_security_group_ids  = []
  db_subnet_group_name    = aws_db_subnet_group.primary_postgres_db_subnets.name

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-primary_postgres_db"
  })
}

resource "aws_elasticache_subnet_group" "session_redis_cache_subnets" {
  name       = trimsuffix(substr("${local.name_prefix}-session-redis-cache-subnets", 0, 255), "-")
  subnet_ids = [aws_subnet.private_app_subnet.id, aws_subnet.private_app_subnet_b.id]
}

# Redis with more than one node: a primary plus replicas with automatic failover
resource "aws_elasticache_replication_group" "session_redis_cache" {
  replication_group_id       = trimsuffix(substr("${local.name_prefix}-session-redis-cache", 0, 40), "-")
  description                = "session_redis_cache (2 nodes)"
  engine                     = "redis"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  port                       = 6379
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name    = aws_elasticache_subnet_group.session_redis_cache_subnets.name
  security_group_ids   = []

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-session_redis_cache"
  })
}

resource "aws_secretsmanager_secret" "db_credentials_secret" {
  name                    = "${local.name_prefix}/platform/rds/master"
  recovery_window_in_days = 0

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db_credentials_secret_val" {
  secret_id     = aws_secretsmanager_secret.db_credentials_secret.id
  secret_string = "{\"username\":\"postgres_admin\",\"password\":\"local_dev_password_9297\"}"
}

# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================

resource "aws_iam_role_policy" "core_backend_fargate_db_primary_postgres_db" {
  name = "core_backend_fargate-db-primary_postgres_db"
  role = aws_iam_role.core_backend_fargate_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.primary_postgres_db.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "core_backend_fargate_secret_db_credentials_secret" {
  name = "core_backend_fargate-secret-db_credentials_secret"
  role = aws_iam_role.core_backend_fargate_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.db_credentials_secret.arn]
    }]
  })
}
