# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (TESTING / QA)
# Target Mode: AWS (us-east-1)
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
  cidr_block                       = "10.20.0.0/16"
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
  cidr_block              = "10.20.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public_ingress_subnet"
    Tier = "public"
  })
}

resource "aws_subnet" "private_app_subnet" {
  vpc_id                  = aws_vpc.primary_vpc.id
  cidr_block              = "10.20.10.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private_app_subnet"
    Tier = "private"
  })
}

resource "aws_lb" "public_ingress_alb" {
  name                       = trimsuffix(substr("${local.name_prefix}-public-ingress-alb", 0, 32), "-")
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
    value = "disabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "core_backend_fargate_task" {
  family                   = "${local.name_prefix}-core_backend_fargate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"

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
  desired_count          = 2
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
  identifier              = trimsuffix(substr("${local.name_prefix}-primary-postgres-db", 0, 63), "-")
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  max_allocated_storage   = 100
  db_name                 = "core_platform"
  username                = "postgres_admin"
  manage_master_user_password = true
  multi_az                = false
  storage_encrypted       = true
  backup_retention_period = 1
  skip_final_snapshot     = true
  vpc_security_group_ids  = []

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-primary_postgres_db"
  })
}

resource "aws_elasticache_cluster" "session_redis_cache" {
  cluster_id           = trimsuffix(substr("${local.name_prefix}-session-redis-cache", 0, 50), "-")
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
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
