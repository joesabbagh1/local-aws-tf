# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (TESTING / QA)
# Target Mode: AWS (us-east-1)
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

resource "aws_kinesis_stream" "telemetry_ingest_stream" {
  name             = "${local.name_prefix}-telemetry_ingest_stream"
  retention_period = 24

  stream_mode_details {
    stream_mode = "ON_DEMAND"
  }

  tags = local.common_tags
}

resource "aws_iam_role" "rag_orchestrator_sfn_sfn_role" {
  name = "${local.name_prefix}-rag_orchestrator_sfn-sfn-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_sfn_state_machine" "rag_orchestrator_sfn" {
  name     = "${local.name_prefix}-rag_orchestrator_sfn"
  role_arn = aws_iam_role.rag_orchestrator_sfn_sfn_role.arn
  type     = "EXPRESS"

  definition = jsonencode({
    Comment = "Compiled by LocalCloud Studio"
    StartAt = "Invoke_claude_reasoning_fn"
    States = {
      Invoke_claude_reasoning_fn = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = "${local.name_prefix}-claude_reasoning_fn"
          "Payload.$"  = "$"
        }
        OutputPath = "$.Payload"
        End = true
      }
    }
  })

  tracing_configuration {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_iam_role" "embedding_processor_fn_exec_role" {
  name = "${local.name_prefix}-embedding_processor_fn-role"

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
resource "aws_iam_role_policy_attachment" "embedding_processor_fn_logs" {
  role       = aws_iam_role.embedding_processor_fn_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "embedding_processor_fn" {
  function_name                  = "${local.name_prefix}-embedding_processor_fn"
  role                           = aws_iam_role.embedding_processor_fn_exec_role.arn
  runtime                        = "python3.12"
  handler                        = "embeddings.handler"
  filename                       = "artifacts/embedding_processor_fn.zip"
  source_code_hash               = filebase64sha256("artifacts/embedding_processor_fn.zip")
  memory_size                    = 1024
  timeout                        = 60
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      CHUNK_TOKENS = "512"
      RAG_ORCHESTRATOR_SFN_STATE_MACHINE_ARN = "${aws_sfn_state_machine.rag_orchestrator_sfn.arn}"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-embedding_processor_fn"
  })
}

resource "aws_iam_role" "claude_reasoning_fn_exec_role" {
  name = "${local.name_prefix}-claude_reasoning_fn-role"

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
resource "aws_iam_role_policy_attachment" "claude_reasoning_fn_logs" {
  role       = aws_iam_role.claude_reasoning_fn_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "claude_reasoning_fn" {
  function_name                  = "${local.name_prefix}-claude_reasoning_fn"
  role                           = aws_iam_role.claude_reasoning_fn_exec_role.arn
  runtime                        = "python3.12"
  handler                        = "app.handler"
  filename                       = "artifacts/claude_reasoning_fn.zip"
  source_code_hash               = filebase64sha256("artifacts/claude_reasoning_fn.zip")
  memory_size                    = 512
  timeout                        = 120
  architectures                  = ["arm64"]
  reserved_concurrent_executions = -1

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
      CLAUDE_MODEL_ID = "anthropic.claude-opus-5-5"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-claude_reasoning_fn"
  })
}

# Lets the function call Claude through Amazon Bedrock's Messages API (bedrock-mantle endpoint)
resource "aws_iam_role_policy" "claude_reasoning_fn_claude" {
  name = "claude-bedrock"
  role = aws_iam_role.claude_reasoning_fn_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-mantle:CreateInference"]
      Resource = "*"
    }]
  })
}

# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================

resource "aws_iam_role_policy" "embedding_processor_fn_consume_telemetry_ingest_stream" {
  name = "embedding_processor_fn-consume-telemetry_ingest_stream"
  role = aws_iam_role.embedding_processor_fn_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:ListStreams"]
      Resource = aws_kinesis_stream.telemetry_ingest_stream.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "telemetry_ingest_stream_stream_embedding_processor_fn" {
  event_source_arn  = aws_kinesis_stream.telemetry_ingest_stream.arn
  function_name     = aws_lambda_function.embedding_processor_fn.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.embedding_processor_fn_consume_telemetry_ingest_stream]
}

resource "aws_iam_role_policy" "embedding_processor_fn_sfn_rag_orchestrator_sfn" {
  name = "embedding_processor_fn-sfn-rag_orchestrator_sfn"
  role = aws_iam_role.embedding_processor_fn_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = [aws_sfn_state_machine.rag_orchestrator_sfn.arn]
    }]
  })
}

resource "aws_iam_role_policy" "rag_orchestrator_sfn_invoke_claude_reasoning_fn" {
  name = "rag_orchestrator_sfn-invoke-claude_reasoning_fn"
  role = aws_iam_role.rag_orchestrator_sfn_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.claude_reasoning_fn.arn]
    }]
  })
}
