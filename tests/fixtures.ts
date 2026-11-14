import { getDefaultConfigForService } from '../src/data/awsCatalog';
import type { CloudNode } from '../src/types/cloud';

export function nodeFor(typeId: string, resourceName: string, config: Record<string, unknown> = {}): CloudNode {
  return {
    id: `n-${resourceName}`,
    type: 'awsNode',
    position: { x: 0, y: 0 },
    data: {
      label: resourceName,
      resourceName,
      serviceType: typeId,
      baseConfig: { ...getDefaultConfigForService(typeId), ...config },
      envOverrides: {},
      envEnabled: { dev: true, testing: true, staging: true, prod: true },
      tags: {},
    },
  };
}

/** A canvas with no VPC or Subnet nodes, so networked resources fall back to inputs. */
export const NO_NETWORK_CANVAS = [
  nodeFor('aws_instance', 'web'),
  nodeFor('aws_instance', 'worker', { instance_type: 't4g.small' }),
  nodeFor('aws_instance', 'pinned', { ami: 'ami-0abcdef1234567890' }),
  nodeFor('aws_autoscaling_group', 'fleet'),
  nodeFor('aws_lb', 'edge'),
];

/** Hand-written Terraform with arguments the form doesn't model, for the importer. */
export const IMPORT_FIXTURE_HCL = `
resource "aws_kms_key" "payments_key" {
  description = "payments"
}

resource "aws_lambda_function" "payments-fn" {
  function_name = "payments"
  role          = aws_iam_role.legacy.arn
  runtime       = "python3.12"
  handler       = "app.handler"
  timeout       = 15
  memory_size   = var.memory
  publish       = true
  kms_key_arn   = aws_kms_key.payments_key.arn
  description   = "uses \${aws_sns_topic.alerts.arn}"

  ephemeral_storage {
    size = 1024
  }

  lifecycle {
    ignore_changes = [description]
  }

  tags = {
    Team = "payments"
  }
}

resource "aws_sqs_queue" "jobs" {
  count = 2
  name  = "jobs"
  policy = jsonencode({
    Statement = [{ Effect = "Allow", Principal = "*", Action = "sqs:SendMessage", Resource = "*", Condition = { ArnEquals = { "aws:SourceArn" = aws_lambda_function.payments-fn.arn } } }]
  })
}

resource "aws_iam_role" "legacy" {
  name = "legacy"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = "x"
}
`;
