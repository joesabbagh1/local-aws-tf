# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (DEVELOPMENT)
# Target Mode: AWS Emulator (https://127.0.0.1:9297)
# Active Resources: 37 | Wired Connections: 183
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

# Latest Amazon Linux 2023 image for this region (set an AMI on the node to pin one)
data "aws_ssm_parameter" "al2023_ami_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_vpc" "vpc" {
  cidr_block                       = "10.0.0.0/16"
  instance_tenancy                 = "default"
  enable_dns_support               = true
  enable_dns_hostnames             = true
  assign_generated_ipv6_cidr_block = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-vpc"
  })
}

resource "aws_subnet" "subnet" {
  vpc_id                  = aws_vpc.vpc.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-subnet"
    Tier = "public"
  })
}

resource "aws_internet_gateway" "internet_gateway" {
  vpc_id = aws_vpc.vpc.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-internet_gateway"
  })
}

resource "aws_eip" "nat_gateway_eip" {
  domain = "vpc"
  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat_gateway-eip"
  })
}

resource "aws_nat_gateway" "nat_gateway" {
  allocation_id     = aws_eip.nat_gateway_eip.id
  subnet_id         = aws_subnet.subnet.id
  connectivity_type = "public"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nat_gateway"
  })
}

resource "aws_route_table" "route_table" {
  vpc_id = aws_vpc.vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.internet_gateway.id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-route_table"
  })
}

resource "aws_route_table_association" "route_table_subnet" {
  subnet_id      = aws_subnet.subnet.id
  route_table_id = aws_route_table.route_table.id
}

resource "aws_security_group" "security_group" {
  name        = "${local.name_prefix}-security_group"
  description = "Managed by LocalCloud Studio"
  vpc_id      = aws_vpc.vpc.id

  ingress {
    description = "Primary Ingress Rule"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-security_group"
  })
}

resource "aws_lb" "lb" {
  name                       = trimsuffix(substr("${local.name_prefix}-lb", 0, 32), "-")
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = [aws_subnet.subnet.id]
  security_groups            = [aws_security_group.security_group.id]
  enable_deletion_protection = false
  idle_timeout               = 60

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-lb"
  })
}

resource "aws_lb_target_group" "lb_tg" {
  name        = trimsuffix(substr("${local.name_prefix}-lb-tg", 0, 32), "-")
  port        = 80
  protocol    = "HTTP"
  vpc_id      = aws_vpc.vpc.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

# EC2 instances and Auto Scaling groups register by instance ID
resource "aws_lb_target_group" "lb_instances_tg" {
  name        = trimsuffix(substr("${local.name_prefix}-lb-inst", 0, 32), "-")
  port        = 80
  protocol    = "HTTP"
  vpc_id      = aws_vpc.vpc.id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_target_group" "lb_lambda_function_tg" {
  target_type = "lambda"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-lb-lambda_function"
  })
}

resource "aws_lb_listener" "lb_listener" {
  load_balancer_arn = aws_lb.lb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.lb_tg.arn
  }
}

resource "aws_lb_listener_rule" "lb_to_instances" {
  listener_arn = aws_lb_listener.lb_listener.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.lb_instances_tg.arn
  }

  condition {
    path_pattern {
      values = ["/instances/*"]
    }
  }
}

resource "aws_lb_listener_rule" "lb_to_lambda_function" {
  listener_arn = aws_lb_listener.lb_listener.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.lb_lambda_function_tg.arn
  }

  condition {
    path_pattern {
      values = ["/lambda-function/*"]
    }
  }
}

resource "aws_apigatewayv2_api" "apigatewayv2_api" {
  name          = "${local.name_prefix}-apigatewayv2_api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "x-amz-date"]
    max_age       = 300
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-apigatewayv2_api"
  })
}

resource "aws_apigatewayv2_stage" "apigatewayv2_api_stage" {
  api_id      = aws_apigatewayv2_api.apigatewayv2_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 5000
    throttling_rate_limit  = 10000
  }
}

resource "aws_cloudfront_distribution" "cloudfront_distribution" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name = aws_lb.lb.dns_name
    origin_id   = "cloudfront_distribution-primary-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.apigatewayv2_api.api_endpoint, "https://", "")
    origin_id   = "cloudfront_distribution-apigatewayv2_api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name = trimsuffix(trimprefix(aws_lambda_function_url.lambda_function_url.function_url, "https://"), "/")
    origin_id   = "cloudfront_distribution-lambda_function"

    origin_access_control_id = aws_cloudfront_origin_access_control.cloudfront_distribution_lambda_function_oac.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name = aws_s3_bucket.s3_bucket.bucket_regional_domain_name
    origin_id   = "cloudfront_distribution-s3_bucket"

    origin_access_control_id = aws_cloudfront_origin_access_control.cloudfront_distribution_s3_bucket_oac.id
  }

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "cloudfront_distribution-primary-origin"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/apigatewayv2-api/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "cloudfront_distribution-apigatewayv2_api"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/lambda-function/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "cloudfront_distribution-lambda_function"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/s3-bucket/*"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "cloudfront_distribution-s3_bucket"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-cloudfront_distribution"
  })
}

resource "aws_route53_zone" "route53_zone" {
  name = "internal.localcloud.dev"

  vpc {
    vpc_id = aws_vpc.vpc.id
  }
  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-route53_zone"
  })
}

resource "aws_iam_role" "instance_instance_role" {
  name = "${local.name_prefix}-instance-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_instance_profile" "instance_profile" {
  name = "${local.name_prefix}-instance-profile"
  role = aws_iam_role.instance_instance_role.name
}

resource "aws_instance" "instance" {
  ami                         = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value
  # Emulator only: t3.micro runs as m6i.large, since the emulator can't read burstable instances' CPU credits (https://github.com/aws/aws-emulator/issues/422). The AWS export keeps the designed value.
  instance_type               = "m6i.large"
  iam_instance_profile        = aws_iam_instance_profile.instance_profile.name
  subnet_id                   = aws_subnet.subnet.id
  availability_zone           = aws_subnet.subnet.availability_zone
  vpc_security_group_ids      = [aws_security_group.security_group.id]
  associate_public_ip_address = false
  monitoring                  = false

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOF
#!/bin/bash
echo "Bootstrapped by LocalCloud Studio"
  EOF

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-instance"
  })

  # Emulator only: it ignores root volume settings. The AWS export keeps your size, type and encryption.
  lifecycle {
    ignore_changes = [root_block_device]
  }
}

resource "aws_iam_role" "lambda_function_exec_role" {
  name = "${local.name_prefix}-lambda_function-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Lets the function write its logs to CloudWatch
resource "aws_iam_role_policy_attachment" "lambda_function_logs" {
  role       = aws_iam_role.lambda_function_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "lambda_function" {
  function_name                  = "${local.name_prefix}-lambda_function"
  role                           = aws_iam_role.lambda_function_exec_role.arn
  runtime                        = "nodejs20.x"
  handler                        = "index.handler"
  filename                       = "artifacts/lambda_function.zip"
  source_code_hash               = filebase64sha256("artifacts/lambda_function.zip")
  memory_size                    = 256
  timeout                        = 30
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "PassThrough"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      LOG_LEVEL = "info"
      STAGE = "local"
      LAMBDA_FUNCTION_2_FUNCTION_NAME = "${local.name_prefix}-lambda_function_2"
      ECR_REPOSITORY_REPOSITORY_URL = "${aws_ecr_repository.ecr_repository.repository_url}"
      S3_BUCKET_BUCKET_NAME = "${aws_s3_bucket.s3_bucket.id}"
      EFS_FILE_SYSTEM_FILE_SYSTEM_ID = "${aws_efs_file_system.efs_file_system.id}"
      DYNAMODB_TABLE_TABLE_NAME = "${aws_dynamodb_table.dynamodb_table.name}"
      DB_INSTANCE_HOST = "${aws_db_instance.db_instance.address}"
      DB_INSTANCE_PORT = "${aws_db_instance.db_instance.port}"
      DB_INSTANCE_NAME = "${aws_db_instance.db_instance.db_name}"
      DB_INSTANCE_SECRET_ARN = "${try(aws_db_instance.db_instance.master_user_secret[0].secret_arn, "")}"
      ELASTICACHE_CLUSTER_HOST = "${aws_elasticache_cluster.elasticache_cluster.cache_nodes[0].address}"
      ELASTICACHE_CLUSTER_PORT = "${aws_elasticache_cluster.elasticache_cluster.port}"
      SQS_QUEUE_QUEUE_URL = "${aws_sqs_queue.sqs_queue.url}"
      SNS_TOPIC_TOPIC_ARN = "${aws_sns_topic.sns_topic.arn}"
      CLOUDWATCH_EVENT_BUS_EVENT_BUS_NAME = "${aws_cloudwatch_event_bus.cloudwatch_event_bus.name}"
      SFN_STATE_MACHINE_STATE_MACHINE_ARN = "${aws_sfn_state_machine.sfn_state_machine.arn}"
      IAM_ROLE_ROLE_ARN = "${aws_iam_role.iam_role.arn}"
      KMS_KEY_KEY_ARN = "${aws_kms_key.kms_key.arn}"
      SECRETSMANAGER_SECRET_SECRET_ARN = "${aws_secretsmanager_secret.secretsmanager_secret.arn}"
      CLOUDWATCH_LOG_GROUP_LOG_GROUP_NAME = "${aws_cloudwatch_log_group.cloudwatch_log_group.name}"
      SSM_PARAMETER_PARAMETER_NAME = "${aws_ssm_parameter.ssm_parameter.name}"
      KINESIS_STREAM_STREAM_NAME = "${aws_kinesis_stream.kinesis_stream.name}"
      OPENSEARCH_DOMAIN_ENDPOINT = "${aws_opensearch_domain.opensearch_domain.endpoint}"
      BEDROCK_AGENT_AGENT_ID = "${aws_bedrockagent_agent.bedrock_agent.agent_id}"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-lambda_function"
  })
}

resource "aws_iam_role" "autoscaling_group_instance_role" {
  name = "${local.name_prefix}-autoscaling_group-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_instance_profile" "autoscaling_group_profile" {
  name = "${local.name_prefix}-autoscaling_group-profile"
  role = aws_iam_role.autoscaling_group_instance_role.name
}

resource "aws_launch_template" "autoscaling_group_lt" {
  name_prefix   = "${local.name_prefix}-autoscaling_group-"
  image_id      = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value
  instance_type = "t3.medium"
  vpc_security_group_ids = [aws_security_group.security_group.id]

  iam_instance_profile {
    name = aws_iam_instance_profile.autoscaling_group_profile.name
  }
}

resource "aws_autoscaling_group" "autoscaling_group" {
  name                      = "${local.name_prefix}-autoscaling_group-asg"
  min_size                  = 1
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = [aws_subnet.subnet.id]
  health_check_type         = "ELB"
  health_check_grace_period = 300

  launch_template {
    id      = aws_launch_template.autoscaling_group_lt.id
    version = "$Latest"
  }
}

resource "aws_ecs_cluster" "ecs_service_cluster" {
  name = "${local.name_prefix}-ecs_service-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.common_tags
}

# Execution role: lets ECS pull the image and write logs
resource "aws_iam_role" "ecs_service_exec_role" {
  name = "${local.name_prefix}-ecs_service-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_service_exec_role" {
  role       = aws_iam_role.ecs_service_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: what the containers themselves may call
resource "aws_iam_role" "ecs_service_task_role" {
  name = "${local.name_prefix}-ecs_service-task-role"

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
resource "aws_iam_role_policy" "ecs_service_task_exec_command" {
  name = "ecs-exec"
  role = aws_iam_role.ecs_service_task_role.id

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

resource "aws_ecs_task_definition" "ecs_service_task" {
  family                   = "${local.name_prefix}-ecs_service"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_service_exec_role.arn
  task_role_arn            = aws_iam_role.ecs_service_task_role.arn

  container_definitions = jsonencode([
    {
      name      = "ecs_service"
      image     = "${aws_ecr_repository.ecr_repository.repository_url}:latest"
      essential = true
      portMappings = [
        {
          containerPort = 80
          hostPort      = 80
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "ENVIRONMENT", value = var.environment },
        { name = "LAMBDA_FUNCTION_FUNCTION_NAME", value = "${local.name_prefix}-lambda_function" },
        { name = "ECR_REPOSITORY_REPOSITORY_URL", value = tostring(aws_ecr_repository.ecr_repository.repository_url) },
        { name = "S3_BUCKET_BUCKET_NAME", value = tostring(aws_s3_bucket.s3_bucket.id) },
        { name = "EFS_FILE_SYSTEM_FILE_SYSTEM_ID", value = tostring(aws_efs_file_system.efs_file_system.id) },
        { name = "DYNAMODB_TABLE_TABLE_NAME", value = tostring(aws_dynamodb_table.dynamodb_table.name) },
        { name = "DB_INSTANCE_HOST", value = tostring(aws_db_instance.db_instance.address) },
        { name = "DB_INSTANCE_PORT", value = tostring(aws_db_instance.db_instance.port) },
        { name = "DB_INSTANCE_NAME", value = tostring(aws_db_instance.db_instance.db_name) },
        { name = "DB_INSTANCE_SECRET_ARN", value = tostring(try(aws_db_instance.db_instance.master_user_secret[0].secret_arn, "")) },
        { name = "ELASTICACHE_CLUSTER_HOST", value = tostring(aws_elasticache_cluster.elasticache_cluster.cache_nodes[0].address) },
        { name = "ELASTICACHE_CLUSTER_PORT", value = tostring(aws_elasticache_cluster.elasticache_cluster.port) },
        { name = "SQS_QUEUE_QUEUE_URL", value = tostring(aws_sqs_queue.sqs_queue.url) },
        { name = "SNS_TOPIC_TOPIC_ARN", value = tostring(aws_sns_topic.sns_topic.arn) },
        { name = "CLOUDWATCH_EVENT_BUS_EVENT_BUS_NAME", value = tostring(aws_cloudwatch_event_bus.cloudwatch_event_bus.name) },
        { name = "SFN_STATE_MACHINE_STATE_MACHINE_ARN", value = tostring(aws_sfn_state_machine.sfn_state_machine.arn) },
        { name = "IAM_ROLE_ROLE_ARN", value = tostring(aws_iam_role.iam_role.arn) },
        { name = "KMS_KEY_KEY_ARN", value = tostring(aws_kms_key.kms_key.arn) },
        { name = "SECRETSMANAGER_SECRET_SECRET_ARN", value = tostring(aws_secretsmanager_secret.secretsmanager_secret.arn) },
        { name = "CLOUDWATCH_LOG_GROUP_LOG_GROUP_NAME", value = tostring(aws_cloudwatch_log_group.cloudwatch_log_group.name) },
        { name = "SSM_PARAMETER_PARAMETER_NAME", value = tostring(aws_ssm_parameter.ssm_parameter.name) },
        { name = "KINESIS_STREAM_STREAM_NAME", value = tostring(aws_kinesis_stream.kinesis_stream.name) },
        { name = "OPENSEARCH_DOMAIN_ENDPOINT", value = tostring(aws_opensearch_domain.opensearch_domain.endpoint) },
        { name = "BEDROCK_AGENT_AGENT_ID", value = tostring(aws_bedrockagent_agent.bedrock_agent.agent_id) }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.cloudwatch_log_group.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs_service"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "ecs_service" {
  name                   = "${local.name_prefix}-ecs_service"
  cluster                = aws_ecs_cluster.ecs_service_cluster.id
  task_definition        = aws_ecs_task_definition.ecs_service_task.arn
  desired_count          = 2
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets          = [aws_subnet.subnet.id]
    security_groups  = [aws_security_group.security_group.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.lb_tg.arn
    container_name   = "ecs_service"
    container_port   = 80
  }

  tags = local.common_tags
  depends_on = [aws_lb_listener.lb_listener]
}

# Workloads assume this role through EKS Pod Identity: associate it with a service account
resource "aws_iam_role" "eks_cluster_pod_role" {
  name = "${local.name_prefix}-eks_cluster-pod-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role" "eks_cluster_eks_role" {
  name = "${local.name_prefix}-eks_cluster-eks-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_eks_cluster" "eks_cluster" {
  name     = "${local.name_prefix}-eks_cluster"
  role_arn = aws_iam_role.eks_cluster_eks_role.arn
  version  = "1.31"

  vpc_config {
    subnet_ids              = [aws_subnet.subnet.id]
    security_group_ids      = [aws_security_group.security_group.id]
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  tags = local.common_tags
}

resource "aws_ecr_repository" "ecr_repository" {
  name                 = "${local.name_prefix}/ecr_repository"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

resource "aws_s3_bucket" "s3_bucket" {
  bucket        = trimsuffix(substr("${local.name_prefix}-app-assets-storage", 0, 63), "-")
  force_destroy = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-s3_bucket"
  })
}

resource "aws_s3_bucket_versioning" "s3_bucket_versioning" {
  bucket = aws_s3_bucket.s3_bucket.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "s3_bucket_sse" {
  bucket = aws_s3_bucket.s3_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "s3_bucket_pab" {
  bucket                  = aws_s3_bucket.s3_bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_efs_file_system" "efs_file_system" {
  creation_token   = "${local.name_prefix}-efs_file_system"
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  encrypted        = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-efs_file_system"
  })
}

resource "aws_dynamodb_table" "dynamodb_table" {
  name             = "${local.name_prefix}-dynamodb_table"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "pk"
  range_key        = "sk"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-dynamodb_table"
  })

  # Not modeled on the canvas; AWS Emulator reports -1 here, which would otherwise diff on every plan
  lifecycle {
    ignore_changes = [on_demand_throughput]
  }
}

resource "aws_db_subnet_group" "db_instance_subnets" {
  name       = trimsuffix(substr("${local.name_prefix}-db-instance-subnets", 0, 255), "-")
  subnet_ids = [aws_subnet.subnet.id]

  tags = local.common_tags
}

resource "aws_db_instance" "db_instance" {
  identifier              = trimsuffix(substr("${local.name_prefix}-db-instance", 0, 63), "-")
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  max_allocated_storage   = 100
  db_name                 = "appdb"
  username                = "dbadmin"
  manage_master_user_password = true
  multi_az                = false
  storage_encrypted       = true
  backup_retention_period = 7
  skip_final_snapshot     = true
  vpc_security_group_ids  = [aws_security_group.security_group.id]
  db_subnet_group_name    = aws_db_subnet_group.db_instance_subnets.name

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-db_instance"
  })
}

resource "aws_elasticache_subnet_group" "elasticache_cluster_subnets" {
  name       = trimsuffix(substr("${local.name_prefix}-elasticache-cluster-subnets", 0, 255), "-")
  subnet_ids = [aws_subnet.subnet.id]
}

resource "aws_elasticache_cluster" "elasticache_cluster" {
  cluster_id           = trimsuffix(substr("${local.name_prefix}-elasticache-cluster", 0, 50), "-")
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.elasticache_cluster_subnets.name
  security_group_ids   = [aws_security_group.security_group.id]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-elasticache_cluster"
  })

  # Emulator only: it serves the cache on a port of its own choosing. The AWS export keeps the designed port.
  lifecycle {
    ignore_changes = [port]
  }
}

resource "aws_sqs_queue" "sqs_queue_dlq" {
  name                      = "${local.name_prefix}-sqs_queue-dlq"
  fifo_queue                = false
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "sqs_queue" {
  name                       = "${local.name_prefix}-sqs_queue"
  fifo_queue                 = false
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600
  delay_seconds              = 0
  receive_wait_time_seconds  = 10
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sqs_queue_dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-sqs_queue"
  })
}

resource "aws_sns_topic" "sns_topic" {
  name                        = "${local.name_prefix}-sns_topic"
  display_name                = "LocalCloud Alerts"
  fifo_topic                  = false
  content_based_deduplication = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-sns_topic"
  })
}

resource "aws_cloudwatch_event_bus" "cloudwatch_event_bus" {
  name = "${local.name_prefix}-cloudwatch_event_bus"
  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "cloudwatch_event_bus_rule" {
  name           = "${local.name_prefix}-cloudwatch_event_bus-rule"
  event_bus_name = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
  event_pattern = jsonencode({
    source = ["custom.app.orders"]
  })
}

resource "aws_iam_role" "sfn_state_machine_sfn_role" {
  name = "${local.name_prefix}-sfn_state_machine-sfn-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_sfn_state_machine" "sfn_state_machine" {
  name     = "${local.name_prefix}-sfn_state_machine"
  role_arn = aws_iam_role.sfn_state_machine_sfn_role.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Compiled by LocalCloud Studio"
    StartAt = "Invoke_lambda_function"
    States = {
      Invoke_lambda_function = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = "${local.name_prefix}-lambda_function"
          "Payload.$"  = "$"
        }
        OutputPath = "$.Payload"
        Next = "Send_sqs_queue"
      }
      Send_sqs_queue = {
        Type     = "Task"
        Resource = "arn:aws:states:::sqs:sendMessage"
        Parameters = {
          QueueUrl        = aws_sqs_queue.sqs_queue.url
          "MessageBody.$" = "States.JsonToString($)"
        }
        ResultPath = null
        Next = "Publish_sns_topic"
      }
      Publish_sns_topic = {
        Type     = "Task"
        Resource = "arn:aws:states:::sns:publish"
        Parameters = {
          TopicArn    = aws_sns_topic.sns_topic.arn
          "Message.$" = "States.JsonToString($)"
        }
        ResultPath = null
        Next = "Emit_cloudwatch_event_bus"
      }
      Emit_cloudwatch_event_bus = {
        Type     = "Task"
        Resource = "arn:aws:states:::events:putEvents"
        Parameters = {
          Entries = [{
            EventBusName = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
            Source       = "custom.app.orders"
            DetailType   = "StateMachineStep"
            "Detail.$"   = "$"
          }]
        }
        ResultPath = null
        Next = "Start_sfn_state_machine_2"
      }
      Start_sfn_state_machine_2 = {
        Type     = "Task"
        Resource = "arn:aws:states:::states:startExecution"
        Parameters = {
          StateMachineArn = aws_sfn_state_machine.sfn_state_machine_2.arn
          "Input.$"       = "$"
        }
        ResultPath = null
        End = true
      }
    }
  })

  tracing_configuration {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_iam_role" "iam_role" {
  name                 = "${local.name_prefix}-iam_role"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

resource "aws_kms_key" "kms_key" {
  description             = "KMS Master Key for kms_key (${var.environment})"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = local.common_tags
}

resource "aws_kms_alias" "kms_key_alias" {
  name          = "alias/${local.name_prefix}-app-master-key"
  target_key_id = aws_kms_key.kms_key.key_id
}

resource "aws_secretsmanager_secret" "secretsmanager_secret" {
  name                    = "${local.name_prefix}/app/database/credentials"
  recovery_window_in_days = 0

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "secretsmanager_secret_val" {
  secret_id     = aws_secretsmanager_secret.secretsmanager_secret.id
  secret_string = "{\"username\":\"app_user\",\"api_key\":\"local_emulator_secret_key\"}"
}

resource "aws_cognito_user_pool" "cognito_user_pool" {
  name                     = "${local.name_prefix}-cognito_user_pool"
  mfa_configuration        = "OFF"
  auto_verified_attributes = ["email"]

  lambda_config {
    post_confirmation = aws_lambda_function.lambda_function.arn
  }

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  tags = local.common_tags
}

resource "aws_cognito_user_pool_client" "cognito_user_pool_client" {
  name         = "${local.name_prefix}-cognito_user_pool-web-client"
  user_pool_id = aws_cognito_user_pool.cognito_user_pool.id
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
}

resource "aws_cloudwatch_log_group" "cloudwatch_log_group" {
  name              = "/aws/localcloud/service/${var.environment}/cloudwatch_log_group"
  retention_in_days = 14

  tags = local.common_tags
}

resource "aws_ssm_parameter" "ssm_parameter" {
  name  = "/${var.environment}/config/app/feature_flags"
  type  = "String"
  value = "{\"newCheckout\":true}"

  tags = local.common_tags
}

resource "aws_kinesis_stream" "kinesis_stream" {
  name             = "${local.name_prefix}-kinesis_stream"
  # Emulator only: 24 hours of retention runs as 25, since the emulator rejects 24 (https://github.com/aws/aws-emulator/issues/327). The AWS export keeps the designed value.
  retention_period = 25

  stream_mode_details {
    stream_mode = "ON_DEMAND"
  }

  tags = local.common_tags
}

resource "aws_opensearch_domain" "opensearch_domain" {
  domain_name    = trimsuffix(substr("${local.name_prefix}-opensearch-domain", 0, 28), "-")
  engine_version = "OpenSearch_2.15"

  cluster_config {
    instance_type  = "t3.small.search"
    instance_count = 1
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 20
    volume_type = "gp3"
  }

  tags = local.common_tags
}

resource "aws_iam_role" "bedrock_agent_agent_role" {
  name = "${local.name_prefix}-bedrock_agent-agent-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "bedrock.amazonaws.com"
      }
    }]
  })
}

resource "aws_bedrockagent_agent" "bedrock_agent" {
  agent_name                  = "${local.name_prefix}-bedrock_agent"
  agent_resource_role_arn     = aws_iam_role.bedrock_agent_agent_role.arn
  foundation_model            = "anthropic.claude-3-5-sonnet-20241022-v2:0"
  instruction                 = "You are an intelligent cloud assistant analyzing customer telemetry and executing workflow tools."
  idle_session_ttl_in_seconds = 600

  tags = local.common_tags
}

resource "aws_iam_role" "lambda_function_2_exec_role" {
  name = "${local.name_prefix}-lambda_function_2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Lets the function write its logs to CloudWatch
resource "aws_iam_role_policy_attachment" "lambda_function_2_logs" {
  role       = aws_iam_role.lambda_function_2_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "lambda_function_2" {
  function_name                  = "${local.name_prefix}-lambda_function_2"
  role                           = aws_iam_role.lambda_function_2_exec_role.arn
  runtime                        = "nodejs20.x"
  handler                        = "index.handler"
  filename                       = "artifacts/lambda_function_2.zip"
  source_code_hash               = filebase64sha256("artifacts/lambda_function_2.zip")
  memory_size                    = 256
  timeout                        = 30
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "PassThrough"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      LOG_LEVEL = "info"
      STAGE = "local"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-lambda_function_2"
  })
}

resource "aws_iam_role" "sfn_state_machine_2_sfn_role" {
  name = "${local.name_prefix}-sfn_state_machine_2-sfn-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_sfn_state_machine" "sfn_state_machine_2" {
  name     = "${local.name_prefix}-sfn_state_machine_2"
  role_arn = aws_iam_role.sfn_state_machine_2_sfn_role.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Compiled by LocalCloud Studio"
    StartAt = "InvokePrimaryStep"
    States = {
      InvokePrimaryStep = {
        Type = "Pass"
        End  = true
      }
    }
  })

  tracing_configuration {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_iam_role" "bedrock_agent_2_agent_role" {
  name = "${local.name_prefix}-bedrock_agent_2-agent-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "bedrock.amazonaws.com"
      }
    }]
  })
}

resource "aws_bedrockagent_agent" "bedrock_agent_2" {
  agent_name                  = "${local.name_prefix}-bedrock_agent_2"
  agent_resource_role_arn     = aws_iam_role.bedrock_agent_2_agent_role.arn
  foundation_model            = "anthropic.claude-3-5-sonnet-20241022-v2:0"
  instruction                 = "You are an intelligent cloud assistant analyzing customer telemetry and executing workflow tools."
  idle_session_ttl_in_seconds = 600

  tags = local.common_tags
}

# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================

resource "aws_lb_target_group_attachment" "lb_to_instance" {
  target_group_arn = aws_lb_target_group.lb_instances_tg.arn
  target_id        = aws_instance.instance.id
}

resource "aws_lambda_permission" "lb_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromALB-lb"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.lb_lambda_function_tg.arn
}

resource "aws_lb_target_group_attachment" "lb_to_lambda_function" {
  target_group_arn = aws_lb_target_group.lb_lambda_function_tg.arn
  target_id        = aws_lambda_function.lambda_function.arn
  depends_on       = [aws_lambda_permission.lb_invoke_lambda_function]
}

resource "aws_autoscaling_attachment" "lb_to_autoscaling_group" {
  autoscaling_group_name = aws_autoscaling_group.autoscaling_group.name
  lb_target_group_arn    = aws_lb_target_group.lb_instances_tg.arn
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_lb" {
  api_id             = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = "http://${aws_lb.lb.dns_name}/{proxy}"
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_lb" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "ANY /lb/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_lb.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_lambda_function" {
  api_id                 = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lambda_function.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_lambda_function" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "ANY /lambda_function/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_lambda_function.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_lambda_permission" "apigatewayv2_api_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromAPIGateway-apigatewayv2_api"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.apigatewayv2_api.execution_arn}/*/*"
}

resource "aws_iam_role" "apigatewayv2_api_integration_role" {
  name = "${local.name_prefix}-apigatewayv2_api-integration-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "apigateway.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "apigatewayv2_api_calls_sqs_queue" {
  name = "apigatewayv2_api-calls-sqs_queue"
  role = aws_iam_role.apigatewayv2_api_integration_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_sqs_queue" {
  api_id                 = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "SQS-SendMessage"
  credentials_arn        = aws_iam_role.apigatewayv2_api_integration_role.arn
  payload_format_version = "1.0"

  request_parameters = {
    QueueUrl    = aws_sqs_queue.sqs_queue.url
    MessageBody = "$request.body"
  }
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_sqs_queue" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "POST /sqs_queue"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_sqs_queue.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_iam_role_policy" "apigatewayv2_api_calls_cloudwatch_event_bus" {
  name = "apigatewayv2_api-calls-cloudwatch_event_bus"
  role = aws_iam_role.apigatewayv2_api_integration_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_cloudwatch_event_bus" {
  api_id                 = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "EventBridge-PutEvents"
  credentials_arn        = aws_iam_role.apigatewayv2_api_integration_role.arn
  payload_format_version = "1.0"

  request_parameters = {
    EventBusName = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
    Source       = "custom.app.orders"
    DetailType   = "ApiRequest"
    Detail       = "$request.body"
  }
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_cloudwatch_event_bus" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "POST /cloudwatch_event_bus"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_cloudwatch_event_bus.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_iam_role_policy" "apigatewayv2_api_calls_sfn_state_machine" {
  name = "apigatewayv2_api-calls-sfn_state_machine"
  role = aws_iam_role.apigatewayv2_api_integration_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_sfn_state_machine" {
  api_id                 = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "StepFunctions-StartExecution"
  credentials_arn        = aws_iam_role.apigatewayv2_api_integration_role.arn
  payload_format_version = "1.0"

  request_parameters = {
    StateMachineArn = aws_sfn_state_machine.sfn_state_machine.arn
    Input           = "$request.body"
  }
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_sfn_state_machine" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "POST /sfn_state_machine"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_sfn_state_machine.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_iam_role_policy" "apigatewayv2_api_calls_kinesis_stream" {
  name = "apigatewayv2_api-calls-kinesis_stream"
  role = aws_iam_role.apigatewayv2_api_integration_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_apigatewayv2_integration" "apigatewayv2_api_to_kinesis_stream" {
  api_id                 = aws_apigatewayv2_api.apigatewayv2_api.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "Kinesis-PutRecord"
  credentials_arn        = aws_iam_role.apigatewayv2_api_integration_role.arn
  payload_format_version = "1.0"

  request_parameters = {
    StreamName   = aws_kinesis_stream.kinesis_stream.name
    Data         = "$request.body"
    PartitionKey = "$context.requestId"
  }
}

resource "aws_apigatewayv2_route" "apigatewayv2_api_route_kinesis_stream" {
  api_id    = aws_apigatewayv2_api.apigatewayv2_api.id
  route_key = "POST /kinesis_stream"
  target    = "integrations/${aws_apigatewayv2_integration.apigatewayv2_api_to_kinesis_stream.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.apigatewayv2_api_cognito_user_pool_auth.id
}

resource "aws_cloudfront_origin_access_control" "cloudfront_distribution_lambda_function_oac" {
  name                              = substr("${local.name_prefix}-cloudfront_distribution-lambda_function", 0, 64)
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_lambda_function_url" "lambda_function_url" {
  function_name      = aws_lambda_function.lambda_function.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_distribution_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromCloudFront-cloudfront_distribution"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.cloudfront_distribution.arn
}

resource "aws_cloudfront_origin_access_control" "cloudfront_distribution_s3_bucket_oac" {
  name                              = substr("${local.name_prefix}-cloudfront_distribution-s3_bucket", 0, 64)
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_route53_record" "route53_zone_to_lb" {
  zone_id = aws_route53_zone.route53_zone.zone_id
  name    = "lb.${aws_route53_zone.route53_zone.name}"
  type    = "A"

  alias {
    name                   = aws_lb.lb.dns_name
    zone_id                = aws_lb.lb.zone_id
    evaluate_target_health = true
  }
}

# CloudFront only answers for this name once the distribution lists it under aliases with a matching certificate
resource "aws_route53_record" "route53_zone_to_cloudfront_distribution" {
  zone_id = aws_route53_zone.route53_zone.zone_id
  name    = "cloudfront-distribution.${aws_route53_zone.route53_zone.name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.cloudfront_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.cloudfront_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_iam_role_policy" "instance_invoke_lambda_function" {
  name = "instance-invoke-lambda_function"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_ecr_ecr_repository" {
  name = "instance-ecr-ecr_repository"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_s3_s3_bucket" {
  name = "instance-s3-s3_bucket"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "instance_efs_efs_file_system" {
  name = "instance-efs-efs_file_system"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_ddb_dynamodb_table" {
  name = "instance-ddb-dynamodb_table"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "instance_db_db_instance" {
  name = "instance-db-db_instance"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "instance_sqs_sqs_queue" {
  name = "instance-sqs-sqs_queue"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_sns_sns_topic" {
  name = "instance-sns-sns_topic"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_events_cloudwatch_event_bus" {
  name = "instance-events-cloudwatch_event_bus"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_sfn_sfn_state_machine" {
  name = "instance-sfn-sfn_state_machine"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_assume_iam_role" {
  name = "instance-assume-iam_role"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_kms_kms_key" {
  name = "instance-kms-kms_key"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_secret_secretsmanager_secret" {
  name = "instance-secret-secretsmanager_secret"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_logs_cloudwatch_log_group" {
  name = "instance-logs-cloudwatch_log_group"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "instance_ssm_ssm_parameter" {
  name = "instance-ssm-ssm_parameter"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_kinesis_kinesis_stream" {
  name = "instance-kinesis-kinesis_stream"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "instance_opensearch_opensearch_domain" {
  name = "instance-opensearch-opensearch_domain"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "instance_agent_bedrock_agent" {
  name = "instance-agent-bedrock_agent"
  role = aws_iam_role.instance_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_invoke_lambda_function_2" {
  name = "lambda_function-invoke-lambda_function_2"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function_2.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_ecr_ecr_repository" {
  name = "lambda_function-ecr-ecr_repository"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_s3_s3_bucket" {
  name = "lambda_function-s3-s3_bucket"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_efs_efs_file_system" {
  name = "lambda_function-efs-efs_file_system"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_ddb_dynamodb_table" {
  name = "lambda_function-ddb-dynamodb_table"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_db_db_instance" {
  name = "lambda_function-db-db_instance"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_sqs_sqs_queue" {
  name = "lambda_function-sqs-sqs_queue"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_sns_sns_topic" {
  name = "lambda_function-sns-sns_topic"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_events_cloudwatch_event_bus" {
  name = "lambda_function-events-cloudwatch_event_bus"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_sfn_sfn_state_machine" {
  name = "lambda_function-sfn-sfn_state_machine"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_assume_iam_role" {
  name = "lambda_function-assume-iam_role"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_kms_kms_key" {
  name = "lambda_function-kms-kms_key"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_secret_secretsmanager_secret" {
  name = "lambda_function-secret-secretsmanager_secret"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_logs_cloudwatch_log_group" {
  name = "lambda_function-logs-cloudwatch_log_group"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_ssm_ssm_parameter" {
  name = "lambda_function-ssm-ssm_parameter"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_kinesis_kinesis_stream" {
  name = "lambda_function-kinesis-kinesis_stream"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_opensearch_opensearch_domain" {
  name = "lambda_function-opensearch-opensearch_domain"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_function_agent_bedrock_agent" {
  name = "lambda_function-agent-bedrock_agent"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_invoke_lambda_function" {
  name = "autoscaling_group-invoke-lambda_function"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_ecr_ecr_repository" {
  name = "autoscaling_group-ecr-ecr_repository"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_s3_s3_bucket" {
  name = "autoscaling_group-s3-s3_bucket"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_efs_efs_file_system" {
  name = "autoscaling_group-efs-efs_file_system"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_ddb_dynamodb_table" {
  name = "autoscaling_group-ddb-dynamodb_table"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_db_db_instance" {
  name = "autoscaling_group-db-db_instance"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_sqs_sqs_queue" {
  name = "autoscaling_group-sqs-sqs_queue"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_sns_sns_topic" {
  name = "autoscaling_group-sns-sns_topic"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_events_cloudwatch_event_bus" {
  name = "autoscaling_group-events-cloudwatch_event_bus"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_sfn_sfn_state_machine" {
  name = "autoscaling_group-sfn-sfn_state_machine"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_assume_iam_role" {
  name = "autoscaling_group-assume-iam_role"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_kms_kms_key" {
  name = "autoscaling_group-kms-kms_key"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_secret_secretsmanager_secret" {
  name = "autoscaling_group-secret-secretsmanager_secret"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_logs_cloudwatch_log_group" {
  name = "autoscaling_group-logs-cloudwatch_log_group"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_ssm_ssm_parameter" {
  name = "autoscaling_group-ssm-ssm_parameter"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_kinesis_kinesis_stream" {
  name = "autoscaling_group-kinesis-kinesis_stream"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_opensearch_opensearch_domain" {
  name = "autoscaling_group-opensearch-opensearch_domain"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "autoscaling_group_agent_bedrock_agent" {
  name = "autoscaling_group-agent-bedrock_agent"
  role = aws_iam_role.autoscaling_group_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_invoke_lambda_function" {
  name = "ecs_service-invoke-lambda_function"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_ecr_ecr_repository" {
  name = "ecs_service-ecr-ecr_repository"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_s3_s3_bucket" {
  name = "ecs_service-s3-s3_bucket"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_efs_efs_file_system" {
  name = "ecs_service-efs-efs_file_system"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_ddb_dynamodb_table" {
  name = "ecs_service-ddb-dynamodb_table"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_db_db_instance" {
  name = "ecs_service-db-db_instance"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_sqs_sqs_queue" {
  name = "ecs_service-sqs-sqs_queue"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_sns_sns_topic" {
  name = "ecs_service-sns-sns_topic"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_events_cloudwatch_event_bus" {
  name = "ecs_service-events-cloudwatch_event_bus"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_sfn_sfn_state_machine" {
  name = "ecs_service-sfn-sfn_state_machine"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_assume_iam_role" {
  name = "ecs_service-assume-iam_role"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_kms_kms_key" {
  name = "ecs_service-kms-kms_key"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_secret_secretsmanager_secret" {
  name = "ecs_service-secret-secretsmanager_secret"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_logs_cloudwatch_log_group" {
  name = "ecs_service-logs-cloudwatch_log_group"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_ssm_ssm_parameter" {
  name = "ecs_service-ssm-ssm_parameter"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_kinesis_kinesis_stream" {
  name = "ecs_service-kinesis-kinesis_stream"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_opensearch_opensearch_domain" {
  name = "ecs_service-opensearch-opensearch_domain"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_service_agent_bedrock_agent" {
  name = "ecs_service-agent-bedrock_agent"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_invoke_lambda_function" {
  name = "eks_cluster-invoke-lambda_function"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_ecr_ecr_repository" {
  name = "eks_cluster-ecr-ecr_repository"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_s3_s3_bucket" {
  name = "eks_cluster-s3-s3_bucket"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_efs_efs_file_system" {
  name = "eks_cluster-efs-efs_file_system"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_ddb_dynamodb_table" {
  name = "eks_cluster-ddb-dynamodb_table"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_db_db_instance" {
  name = "eks_cluster-db-db_instance"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_sqs_sqs_queue" {
  name = "eks_cluster-sqs-sqs_queue"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_sns_sns_topic" {
  name = "eks_cluster-sns-sns_topic"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_events_cloudwatch_event_bus" {
  name = "eks_cluster-events-cloudwatch_event_bus"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_sfn_sfn_state_machine" {
  name = "eks_cluster-sfn-sfn_state_machine"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_assume_iam_role" {
  name = "eks_cluster-assume-iam_role"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_kms_kms_key" {
  name = "eks_cluster-kms-kms_key"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_secret_secretsmanager_secret" {
  name = "eks_cluster-secret-secretsmanager_secret"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_logs_cloudwatch_log_group" {
  name = "eks_cluster-logs-cloudwatch_log_group"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_ssm_ssm_parameter" {
  name = "eks_cluster-ssm-ssm_parameter"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_kinesis_kinesis_stream" {
  name = "eks_cluster-kinesis-kinesis_stream"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_opensearch_opensearch_domain" {
  name = "eks_cluster-opensearch-opensearch_domain"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "eks_cluster_agent_bedrock_agent" {
  name = "eks_cluster-agent-bedrock_agent"
  role = aws_iam_role.eks_cluster_pod_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_lambda_permission" "s3_bucket_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromS3-s3_bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.s3_bucket.arn
}

resource "aws_iam_role_policy" "lambda_function_consume_dynamodb_table" {
  name = "lambda_function-consume-dynamodb_table"
  role = aws_iam_role.lambda_function_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"]
      Resource = [aws_dynamodb_table.dynamodb_table.stream_arn]
    }]
  })
}

resource "aws_lambda_event_source_mapping" "dynamodb_table_stream_lambda_function" {
  event_source_arn  = aws_dynamodb_table.dynamodb_table.stream_arn
  function_name     = aws_lambda_function.lambda_function.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.lambda_function_consume_dynamodb_table]
}

resource "aws_iam_role_policy" "lambda_function_consume_sqs_queue" {
  name = "lambda_function-consume-sqs_queue"
  role = aws_iam_role.lambda_function_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = aws_sqs_queue.sqs_queue.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "sqs_queue_trigger_lambda_function" {
  event_source_arn = aws_sqs_queue.sqs_queue.arn
  function_name    = aws_lambda_function.lambda_function.arn
  batch_size       = 10
  enabled          = true
  depends_on       = [aws_iam_role_policy.lambda_function_consume_sqs_queue]
}

resource "aws_iam_role_policy" "ecs_service_consume_sqs_queue" {
  name = "ecs_service-consume-sqs_queue"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_sns_topic_subscription" "sns_topic_sub_lambda_function" {
  topic_arn = aws_sns_topic.sns_topic.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.lambda_function.arn
}

resource "aws_lambda_permission" "sns_topic_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromSNS-sns_topic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.sns_topic.arn
}

resource "aws_sns_topic_subscription" "sns_topic_sub_sqs_queue" {
  topic_arn = aws_sns_topic.sns_topic.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.sqs_queue.arn
}

resource "aws_cloudwatch_event_target" "cloudwatch_event_bus_to_lambda_function" {
  rule           = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.name
  event_bus_name = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
  target_id      = "lambda_function"
  arn            = aws_lambda_function.lambda_function.arn
}

resource "aws_lambda_permission" "cloudwatch_event_bus_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromEventBridge-cloudwatch_event_bus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.arn
}

resource "aws_cloudwatch_event_target" "cloudwatch_event_bus_to_sqs_queue" {
  rule           = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.name
  event_bus_name = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
  target_id      = "sqs_queue"
  arn            = aws_sqs_queue.sqs_queue.arn
}

resource "aws_cloudwatch_event_target" "cloudwatch_event_bus_to_sns_topic" {
  rule           = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.name
  event_bus_name = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
  target_id      = "sns_topic"
  arn            = aws_sns_topic.sns_topic.arn
}

resource "aws_iam_role" "cloudwatch_event_bus_start_sfn_state_machine_role" {
  name = "${local.name_prefix}-cloudwatch_event_bus-start-sfn_state_machine"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "cloudwatch_event_bus_start_sfn_state_machine" {
  name = "cloudwatch_event_bus-start-sfn_state_machine"
  role = aws_iam_role.cloudwatch_event_bus_start_sfn_state_machine_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_cloudwatch_event_target" "cloudwatch_event_bus_to_sfn_state_machine" {
  rule           = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.name
  event_bus_name = aws_cloudwatch_event_bus.cloudwatch_event_bus.name
  target_id      = "sfn_state_machine"
  arn            = aws_sfn_state_machine.sfn_state_machine.arn
  role_arn       = aws_iam_role.cloudwatch_event_bus_start_sfn_state_machine_role.arn
}

resource "aws_iam_role_policy" "sfn_state_machine_invoke_lambda_function" {
  name = "sfn_state_machine-invoke-lambda_function"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_ecr_ecr_repository" {
  name = "sfn_state_machine-ecr-ecr_repository"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_s3_s3_bucket" {
  name = "sfn_state_machine-s3-s3_bucket"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_efs_efs_file_system" {
  name = "sfn_state_machine-efs-efs_file_system"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_ddb_dynamodb_table" {
  name = "sfn_state_machine-ddb-dynamodb_table"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_db_db_instance" {
  name = "sfn_state_machine-db-db_instance"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_sqs_sqs_queue" {
  name = "sfn_state_machine-sqs-sqs_queue"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_sns_sns_topic" {
  name = "sfn_state_machine-sns-sns_topic"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_events_cloudwatch_event_bus" {
  name = "sfn_state_machine-events-cloudwatch_event_bus"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_sfn_sfn_state_machine_2" {
  name = "sfn_state_machine-sfn-sfn_state_machine_2"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine_2.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_assume_iam_role" {
  name = "sfn_state_machine-assume-iam_role"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_kms_kms_key" {
  name = "sfn_state_machine-kms-kms_key"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_secret_secretsmanager_secret" {
  name = "sfn_state_machine-secret-secretsmanager_secret"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_logs_cloudwatch_log_group" {
  name = "sfn_state_machine-logs-cloudwatch_log_group"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_ssm_ssm_parameter" {
  name = "sfn_state_machine-ssm-ssm_parameter"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_kinesis_kinesis_stream" {
  name = "sfn_state_machine-kinesis-kinesis_stream"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_opensearch_opensearch_domain" {
  name = "sfn_state_machine-opensearch-opensearch_domain"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "sfn_state_machine_agent_bedrock_agent" {
  name = "sfn_state_machine-agent-bedrock_agent"
  role = aws_iam_role.sfn_state_machine_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

# Routes on apigatewayv2_api require a token issued by this user pool
resource "aws_apigatewayv2_authorizer" "apigatewayv2_api_cognito_user_pool_auth" {
  api_id           = aws_apigatewayv2_api.apigatewayv2_api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito_user_pool-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.cognito_user_pool_client.id]
    issuer   = "https://${aws_cognito_user_pool.cognito_user_pool.endpoint}"
  }
}

resource "aws_lambda_permission" "cognito_user_pool_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromCognito-cognito_user_pool"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.cognito_user_pool.arn
}

resource "aws_iam_role_policy" "lambda_function_consume_kinesis_stream" {
  name = "lambda_function-consume-kinesis_stream"
  role = aws_iam_role.lambda_function_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:ListStreams"]
      Resource = aws_kinesis_stream.kinesis_stream.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "kinesis_stream_stream_lambda_function" {
  event_source_arn  = aws_kinesis_stream.kinesis_stream.arn
  function_name     = aws_lambda_function.lambda_function.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.lambda_function_consume_kinesis_stream]
}

resource "aws_iam_role_policy" "ecs_service_consume_kinesis_stream" {
  name = "ecs_service-consume-kinesis_stream"
  role = aws_iam_role.ecs_service_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_invoke_lambda_function" {
  name = "bedrock_agent-invoke-lambda_function"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.lambda_function.arn]
    }]
  })
}

resource "aws_lambda_permission" "bedrock_agent_invoke_lambda_function" {
  statement_id  = "AllowExecutionFromBedrock-bedrock_agent"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_function.function_name
  principal     = "bedrock.amazonaws.com"
  source_arn    = aws_bedrockagent_agent.bedrock_agent.agent_arn
}

resource "aws_iam_role_policy" "bedrock_agent_ecr_ecr_repository" {
  name = "bedrock_agent-ecr-ecr_repository"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    }, {
      Effect   = "Allow"
      Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
      Resource = [aws_ecr_repository.ecr_repository.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_s3_s3_bucket" {
  name = "bedrock_agent-s3-s3_bucket"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.s3_bucket.arn, "${aws_s3_bucket.s3_bucket.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_efs_efs_file_system" {
  name = "bedrock_agent-efs-efs_file_system"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = [aws_efs_file_system.efs_file_system.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_ddb_dynamodb_table" {
  name = "bedrock_agent-ddb-dynamodb_table"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.dynamodb_table.arn, "${aws_dynamodb_table.dynamodb_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_db_db_instance" {
  name = "bedrock_agent-db-db_instance"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = coalescelist(aws_db_instance.db_instance.master_user_secret[*].secret_arn, ["arn:aws:secretsmanager:*:*:secret:rds!*"])
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_sqs_sqs_queue" {
  name = "bedrock_agent-sqs-sqs_queue"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.sqs_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_sns_sns_topic" {
  name = "bedrock_agent-sns-sns_topic"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = [aws_sns_topic.sns_topic.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_events_cloudwatch_event_bus" {
  name = "bedrock_agent-events-cloudwatch_event_bus"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = [aws_cloudwatch_event_bus.cloudwatch_event_bus.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_sfn_sfn_state_machine" {
  name = "bedrock_agent-sfn-sfn_state_machine"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.sfn_state_machine.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_assume_iam_role" {
  name = "bedrock_agent-assume-iam_role"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.iam_role.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_kms_kms_key" {
  name = "bedrock_agent-kms-kms_key"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource = [aws_kms_key.kms_key.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_secret_secretsmanager_secret" {
  name = "bedrock_agent-secret-secretsmanager_secret"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.secretsmanager_secret.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_logs_cloudwatch_log_group" {
  name = "bedrock_agent-logs-cloudwatch_log_group"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = ["${aws_cloudwatch_log_group.cloudwatch_log_group.arn}:*"]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_ssm_ssm_parameter" {
  name = "bedrock_agent-ssm-ssm_parameter"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [aws_ssm_parameter.ssm_parameter.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_kinesis_kinesis_stream" {
  name = "bedrock_agent-kinesis-kinesis_stream"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStreamSummary"]
      Resource = [aws_kinesis_stream.kinesis_stream.arn]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_opensearch_opensearch_domain" {
  name = "bedrock_agent-opensearch-opensearch_domain"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["es:ESHttpGet", "es:ESHttpHead", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete"]
      Resource = ["${aws_opensearch_domain.opensearch_domain.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "bedrock_agent_agent_bedrock_agent_2" {
  name = "bedrock_agent-agent-bedrock_agent_2"
  role = aws_iam_role.bedrock_agent_agent_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeAgent"]
      Resource = ["${replace(aws_bedrockagent_agent.bedrock_agent_2.agent_arn, ":agent/", ":agent-alias/")}/*"]
    }]
  })
}

resource "aws_sqs_queue_policy" "sqs_queue_senders" {
  queue_url = aws_sqs_queue.sqs_queue.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowBuckets3bucket"
        Effect    = "Allow"
        Principal = { Service = "s3.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.sqs_queue.arn
        Condition = { ArnLike = { "aws:SourceArn" = aws_s3_bucket.s3_bucket.arn } }
      },
      {
        Sid       = "AllowTopicsnstopic"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.sqs_queue.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.sns_topic.arn } }
      },
      {
        Sid       = "AllowRulecloudwatcheventbus"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.sqs_queue.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.arn } }
      }
    ]
  })
}

resource "aws_sns_topic_policy" "sns_topic_publishers" {
  arn = aws_sns_topic.sns_topic.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowBuckets3bucket"
        Effect    = "Allow"
        Principal = { Service = "s3.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.sns_topic.arn
        Condition = { ArnLike = { "aws:SourceArn" = aws_s3_bucket.s3_bucket.arn } }
      },
      {
        Sid       = "AllowRulecloudwatcheventbus"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.sns_topic.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.cloudwatch_event_bus_rule.arn } }
      }
    ]
  })
}

resource "aws_s3_bucket_policy" "s3_bucket_cloudfront" {
  bucket = aws_s3_bucket.s3_bucket.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontcloudfrontdistribution"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.s3_bucket.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.cloudfront_distribution.arn } }
      }
    ]
  })
}

resource "aws_s3_bucket_notification" "s3_bucket_notifications" {
  bucket = aws_s3_bucket.s3_bucket.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.lambda_function.arn
    events              = ["s3:ObjectCreated:*"]
  }

  queue {
    queue_arn           = aws_sqs_queue.sqs_queue.arn
    events              = ["s3:ObjectCreated:*"]
  }

  topic {
    topic_arn           = aws_sns_topic.sns_topic.arn
    events              = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_lambda_permission.s3_bucket_invoke_lambda_function, aws_sqs_queue_policy.sqs_queue_senders, aws_sns_topic_policy.sns_topic_publishers]
}
