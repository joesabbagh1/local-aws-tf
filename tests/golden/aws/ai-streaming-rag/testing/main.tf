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
    }
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-embedding_processor_fn"
  })
}

resource "aws_iam_role" "bedrock_reasoning_agent_agent_role" {
  name = "${local.name_prefix}-bedrock_reasoning_agent-agent-role"

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

resource "aws_bedrockagent_agent" "bedrock_reasoning_agent" {
  agent_name                  = "${local.name_prefix}-bedrock_reasoning_agent"
  agent_resource_role_arn     = aws_iam_role.bedrock_reasoning_agent_agent_role.arn
  foundation_model            = "anthropic.claude-3-5-haiku-20241022-v1:0"
  instruction                 = "Synthesize real-time telemetry anomalies and recommend automated remediations."
  idle_session_ttl_in_seconds = 600

  tags = local.common_tags
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
