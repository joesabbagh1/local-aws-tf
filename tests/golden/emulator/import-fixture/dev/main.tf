# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (DEVELOPMENT)
# Target Mode: AWS Emulator (https://127.0.0.1:9297)
# Active Resources: 4 | Wired Connections: 3
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

resource "aws_kms_key" "payments_key" {
  description             = "KMS Master Key for payments_key (${var.environment})"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  tags = local.common_tags
}

resource "aws_kms_alias" "payments_key_alias" {
  name          = "alias/${local.name_prefix}-app-master-key"
  target_key_id = aws_kms_key.payments_key.key_id
}

resource "aws_iam_role" "payments_fn_exec_role" {
  name = "${local.name_prefix}-payments_fn-role"

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

resource "aws_lambda_function" "payments_fn" {
  function_name                  = "${local.name_prefix}-payments_fn"
  role                           = aws_iam_role.payments_fn_exec_role.arn
  runtime                        = "python3.12"
  handler                        = "app.handler"
  filename                       = "artifacts/payments_fn.zip"
  source_code_hash               = filebase64sha256("artifacts/payments_fn.zip")
  memory_size                    = 256
  timeout                        = 15
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
    Name = "${local.name_prefix}-payments_fn"
  })

  # Extra arguments (hand-written)
  publish       = true
  kms_key_arn   = aws_kms_key.payments_key.arn
  ephemeral_storage {
    size = 1024
  }
  lifecycle {
    ignore_changes = [description]
  }
}

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${local.name_prefix}-jobs-dlq"
  fifo_queue                = false
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.name_prefix}-jobs"
  fifo_queue                 = false
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600
  delay_seconds              = 0
  receive_wait_time_seconds  = 10
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-jobs"
  })

  # Extra arguments (hand-written)
  policy = jsonencode({
    Statement = [{ Effect = "Allow", Principal = "*", Action = "sqs:SendMessage", Resource = "*", Condition = { ArnEquals = { "aws:SourceArn" = aws_lambda_function.payments_fn.arn } } }]
  })
}

resource "aws_iam_role" "legacy" {
  name                 = "${local.name_prefix}-legacy"
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

# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================

resource "aws_iam_role_policy" "payments_fn_consume_jobs" {
  name = "payments_fn-consume-jobs"
  role = aws_iam_role.payments_fn_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = aws_sqs_queue.jobs.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "jobs_trigger_payments_fn" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.payments_fn.arn
  batch_size       = 10
  enabled          = true
  depends_on       = [aws_iam_role_policy.payments_fn_consume_jobs]
}
