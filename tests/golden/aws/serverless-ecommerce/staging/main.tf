# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (STAGING)
# Target Mode: AWS (us-west-2)
# Active Resources: 8 | Wired Connections: 7
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

resource "aws_cloudfront_distribution" "global_edge_cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200"

  origin {
    domain_name = replace(aws_apigatewayv2_api.core_commerce_api.api_endpoint, "https://", "")
    origin_id   = "global_edge_cdn-primary-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "global_edge_cdn-primary-origin"
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
    Name = "${local.name_prefix}-global_edge_cdn"
  })
}

resource "aws_cognito_user_pool" "customer_identity_pool" {
  name                     = "${local.name_prefix}-customer_identity_pool"
  mfa_configuration        = "OPTIONAL"
  auto_verified_attributes = ["email"]

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length    = 10
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  tags = local.common_tags
}

resource "aws_cognito_user_pool_client" "customer_identity_pool_client" {
  name         = "${local.name_prefix}-customer_identity_pool-web-client"
  user_pool_id = aws_cognito_user_pool.customer_identity_pool.id
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
}

resource "aws_apigatewayv2_api" "core_commerce_api" {
  name          = "${local.name_prefix}-core_commerce_api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "x-amz-date"]
    max_age       = 300
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-core_commerce_api"
  })
}

resource "aws_apigatewayv2_stage" "core_commerce_api_stage" {
  api_id      = aws_apigatewayv2_api.core_commerce_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 5000
    throttling_rate_limit  = 10000
  }
}

resource "aws_iam_role" "orders_api_handler_exec_role" {
  name = "${local.name_prefix}-orders_api_handler-role"

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
resource "aws_iam_role_policy_attachment" "orders_api_handler_logs" {
  role       = aws_iam_role.orders_api_handler_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "orders_api_handler" {
  function_name                  = "${local.name_prefix}-orders_api_handler"
  role                           = aws_iam_role.orders_api_handler_exec_role.arn
  runtime                        = "nodejs20.x"
  handler                        = "dist/orders.handler"
  filename                       = "artifacts/orders_api_handler.zip"
  source_code_hash               = filebase64sha256("artifacts/orders_api_handler.zip")
  memory_size                    = 1024
  timeout                        = 15
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      LOG_LEVEL = "info"
      ORDERS_TABLE_TABLE_NAME = "${aws_dynamodb_table.orders_table.name}"
      ORDER_FULFILLMENT_QUEUE_QUEUE_URL = "${aws_sqs_queue.order_fulfillment_queue.url}"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-orders_api_handler"
  })
}

resource "aws_iam_role" "fulfillment_worker_exec_role" {
  name = "${local.name_prefix}-fulfillment_worker-role"

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
resource "aws_iam_role_policy_attachment" "fulfillment_worker_logs" {
  role       = aws_iam_role.fulfillment_worker_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "fulfillment_worker" {
  function_name                  = "${local.name_prefix}-fulfillment_worker"
  role                           = aws_iam_role.fulfillment_worker_exec_role.arn
  runtime                        = "python3.12"
  handler                        = "worker.process_queue"
  filename                       = "artifacts/fulfillment_worker.zip"
  source_code_hash               = filebase64sha256("artifacts/fulfillment_worker.zip")
  memory_size                    = 512
  timeout                        = 60
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      BATCH_SIZE = "10"
      INVOICES_MEDIA_BUCKET_BUCKET_NAME = "${aws_s3_bucket.invoices_media_bucket.id}"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-fulfillment_worker"
  })
}

resource "aws_dynamodb_table" "orders_table" {
  name             = "${local.name_prefix}-orders_table"
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
    enabled = true
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-orders_table"
  })

  # Not modeled on the canvas; AWS Emulator reports -1 here, which would otherwise diff on every plan
  lifecycle {
    ignore_changes = [on_demand_throughput]
  }
}

resource "aws_sqs_queue" "order_fulfillment_queue_dlq" {
  name                      = "${local.name_prefix}-order_fulfillment_queue-dlq"
  fifo_queue                = false
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "order_fulfillment_queue" {
  name                       = "${local.name_prefix}-order_fulfillment_queue"
  fifo_queue                 = false
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  delay_seconds              = 0
  receive_wait_time_seconds  = 10
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.order_fulfillment_queue_dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-order_fulfillment_queue"
  })
}

resource "aws_s3_bucket" "invoices_media_bucket" {
  bucket        = trimsuffix(substr("${local.name_prefix}-commerce-invoices-assets", 0, 63), "-")
  force_destroy = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-invoices_media_bucket"
  })
}

resource "aws_s3_bucket_versioning" "invoices_media_bucket_versioning" {
  bucket = aws_s3_bucket.invoices_media_bucket.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "invoices_media_bucket_sse" {
  bucket = aws_s3_bucket.invoices_media_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "invoices_media_bucket_pab" {
  bucket                  = aws_s3_bucket.invoices_media_bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "invoices_media_bucket_lifecycle" {
  bucket = aws_s3_bucket.invoices_media_bucket.id
  rule {
    id     = "auto-expire-objects"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================

# Routes on core_commerce_api require a token issued by this user pool
resource "aws_apigatewayv2_authorizer" "core_commerce_api_customer_identity_pool_auth" {
  api_id           = aws_apigatewayv2_api.core_commerce_api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "customer_identity_pool-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.customer_identity_pool_client.id]
    issuer   = "https://${aws_cognito_user_pool.customer_identity_pool.endpoint}"
  }
}

resource "aws_apigatewayv2_integration" "core_commerce_api_to_orders_api_handler" {
  api_id                 = aws_apigatewayv2_api.core_commerce_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.orders_api_handler.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "core_commerce_api_route_orders_api_handler" {
  api_id    = aws_apigatewayv2_api.core_commerce_api.id
  route_key = "ANY /orders/*"
  target    = "integrations/${aws_apigatewayv2_integration.core_commerce_api_to_orders_api_handler.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.core_commerce_api_customer_identity_pool_auth.id
}

resource "aws_lambda_permission" "core_commerce_api_invoke_orders_api_handler" {
  statement_id  = "AllowExecutionFromAPIGateway-core_commerce_api"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.orders_api_handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.core_commerce_api.execution_arn}/*/*"
}

resource "aws_iam_role_policy" "orders_api_handler_ddb_orders_table" {
  name = "orders_api_handler-ddb-orders_table"
  role = aws_iam_role.orders_api_handler_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.orders_table.arn, "${aws_dynamodb_table.orders_table.arn}/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "orders_api_handler_sqs_order_fulfillment_queue" {
  name = "orders_api_handler-sqs-order_fulfillment_queue"
  role = aws_iam_role.orders_api_handler_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.order_fulfillment_queue.arn]
    }]
  })
}

resource "aws_iam_role_policy" "fulfillment_worker_consume_order_fulfillment_queue" {
  name = "fulfillment_worker-consume-order_fulfillment_queue"
  role = aws_iam_role.fulfillment_worker_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = aws_sqs_queue.order_fulfillment_queue.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "order_fulfillment_queue_trigger_fulfillment_worker" {
  event_source_arn = aws_sqs_queue.order_fulfillment_queue.arn
  function_name    = aws_lambda_function.fulfillment_worker.arn
  batch_size       = 10
  enabled          = true
  depends_on       = [aws_iam_role_policy.fulfillment_worker_consume_order_fulfillment_queue]
}

resource "aws_iam_role_policy" "fulfillment_worker_s3_invoices_media_bucket" {
  name = "fulfillment_worker-s3-invoices_media_bucket"
  role = aws_iam_role.fulfillment_worker_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.invoices_media_bucket.arn, "${aws_s3_bucket.invoices_media_bucket.arn}/*"]
    }]
  })
}
