# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (STAGING)
# Target Mode: AWS Emulator (https://127.0.0.1:9299)
# Active Resources: 8 | Wired Connections: 4
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

resource "aws_lb" "public_ingress_alb" {
  name                       = substr("${local.name_prefix}-public_ingress_alb", 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = [aws_subnet.public_ingress_subnet.id]
  security_groups            = []
  enable_deletion_protection = false
  idle_timeout               = 60

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public_ingress_alb"
  })
}

resource "aws_lb_target_group" "public_ingress_alb_tg" {
  name        = substr("${local.name_prefix}-public_ingress_alb-tg", 0, 32)
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

resource "aws_ecs_task_definition" "core_backend_fargate_task" {
  family                   = "${local.name_prefix}-core_backend_fargate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"

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
        { name = "ENVIRONMENT", value = var.environment }
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

  tags = local.common_tags
}

resource "aws_db_instance" "primary_postgres_db" {
  identifier              = "${local.name_prefix}-primary_postgres_db"
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

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-primary_postgres_db"
  })
}

resource "aws_elasticache_cluster" "session_redis_cache" {
  cluster_id           = "${local.name_prefix}-session_redis_cache"
  engine               = "redis"
  node_type            = "cache.t4g.small"
  num_cache_nodes      = 2
  port                 = 6379

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
