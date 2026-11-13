# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "telemetry_ingest_stream_kinesis_arn" {
  description = "Kinesis Stream ARN (Telemetry Ingestion Stream)"
  value       = aws_kinesis_stream.telemetry_ingest_stream.arn
}

output "rag_orchestrator_sfn_state_machine_arn" {
  description = "State Machine ARN (RAG Ingestion State Machine)"
  value       = aws_sfn_state_machine.rag_orchestrator_sfn.arn
}

output "embedding_processor_fn_lambda_arn" {
  description = "ARN of the Lambda function (Chunk & Embedding Processor)"
  value       = aws_lambda_function.embedding_processor_fn.arn
}

output "embedding_processor_fn_invoke_arn" {
  description = "Invoke ARN for API Gateway (Chunk & Embedding Processor)"
  value       = aws_lambda_function.embedding_processor_fn.invoke_arn
}

output "bedrock_reasoning_agent_agent_id" {
  description = "Bedrock Agent Identifier (Bedrock Claude Reasoning Agent)"
  value       = aws_bedrockagent_agent.bedrock_reasoning_agent.id
}

output "vector_knowledge_index_opensearch_endpoint" {
  description = "Domain-specific endpoint (OpenSearch Vector Knowledge Index)"
  value       = aws_opensearch_domain.vector_knowledge_index.endpoint
}
