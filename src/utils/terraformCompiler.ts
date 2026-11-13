import type {
  CloudNode,
  CloudEdge,
  EnvironmentId,
  EnvironmentProfile,
} from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { findAncestorOfType } from './canvasLayout';

export function resolveNodeConfigForEnv(
  node: CloudNode,
  envId: EnvironmentId
): Record<string, any> {
  const base = node.data.baseConfig || {};
  const overrides = node.data.envOverrides?.[envId] || {};
  return {
    ...base,
    ...overrides,
  };
}

export function isFieldOverriddenInEnv(
  node: CloudNode,
  envId: EnvironmentId,
  fieldKey: string
): boolean {
  const overrides = node.data.envOverrides?.[envId];
  return Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, fieldKey));
}

export function sanitizeIdentifier(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z_]+/, 'res_')
      .replace(/_+/g, '_')
      .replace(/_$/, '') || 'aws_resource'
  );
}

export interface CompiledTerraformBundle {
  environment: EnvironmentProfile;
  mainTf: string;
  providerTf: string;
  variablesTf: string;
  tfvars: string;
  outputsTf: string;
  emulatorScriptSh: string;
  dockerfile: string;
  dockerComposeYml: string;
}

export function compileTerraformForEnvironment(
  nodes: CloudNode[],
  edges: CloudEdge[],
  envProfile: EnvironmentProfile,
  allEnvironments: Record<EnvironmentId, EnvironmentProfile>,
  targetLocalEmulator: boolean
): CompiledTerraformBundle {
  const envId = envProfile.id;
  const activeNodes = nodes.filter((n) => n.data.envEnabled?.[envId] !== false);
  const activeNodeIds = new Set(activeNodes.map((n) => n.id));
  const activeEdges = edges.filter(
    (e) => activeNodeIds.has(e.source) && activeNodeIds.has(e.target)
  );

  // Build adjacency helper
  const incomingByTarget: Record<string, CloudEdge[]> = {};
  const outgoingBySource: Record<string, CloudEdge[]> = {};
  for (const edge of activeEdges) {
    if (!incomingByTarget[edge.target]) incomingByTarget[edge.target] = [];
    incomingByTarget[edge.target].push(edge);
    if (!outgoingBySource[edge.source]) outgoingBySource[edge.source] = [];
    outgoingBySource[edge.source].push(edge);
  }

  const nodeById: Record<string, CloudNode> = Object.fromEntries(
    activeNodes.map((n) => [n.id, n])
  );

  // Find default VPC or Subnet if present on canvas
  const firstVpcNode = activeNodes.find((n) => n.data.serviceType === 'aws_vpc');
  const subnetNodes = activeNodes.filter((n) => n.data.serviceType === 'aws_subnet');
  const sgNodes = activeNodes.filter((n) => n.data.serviceType === 'aws_security_group');

  // 1. Generate provider.tf
  const providerTf = generateProviderTf(envProfile, targetLocalEmulator);

  // 2. Generate variables.tf & <env>.tfvars
  const { variablesTf, tfvars } = generateVariablesAndTfvars(envProfile, allEnvironments);

  // 3. Generate main.tf resources and wiring
  const resourceBlocks: string[] = [];

  resourceBlocks.push(`# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (${envProfile.name.toUpperCase()})
# Target Mode: ${targetLocalEmulator ? `AWS Emulator (${envProfile.emulatorEndpoint})` : `Production AWS (${envProfile.region})`}
# Active Resources: ${activeNodes.length} | Wired Connections: ${activeEdges.length}
# ============================================================================

locals {
  environment = var.environment
  name_prefix = "lc-\${var.environment}"
  common_tags = merge(var.default_tags, {
    Environment = var.environment
    Region      = var.aws_region
    Compiler    = "LocalCloud-Studio-2D"
  })
}`);

  for (const node of activeNodes) {
    const resName = sanitizeIdentifier(node.data.resourceName || node.data.label);
    const cfg = resolveNodeConfigForEnv(node, envId);
    const incoming = incomingByTarget[node.id] || [];
    const outgoing = outgoingBySource[node.id] || [];

    // Membership comes from explicit wires first, then from canvas nesting (VPC / Subnet containers)
    const containingVpc =
      findAncestorOfType(node, 'aws_vpc', nodeById) ||
      (node.data.parentVpcId ? nodeById[node.data.parentVpcId] : undefined);
    const containingSubnet = findAncestorOfType(node, 'aws_subnet', nodeById);

    const connectedVpc =
      incoming
        .map((e) => nodeById[e.source])
        .find((n) => n?.data.serviceType === 'aws_vpc') ||
      containingVpc ||
      firstVpcNode;

    const connectedSubnets = incoming
      .map((e) => nodeById[e.source])
      .filter((n): n is CloudNode => n?.data.serviceType === 'aws_subnet');

    if (containingSubnet && !connectedSubnets.some((s) => s.id === containingSubnet.id)) {
      connectedSubnets.unshift(containingSubnet);
    }

    const effectiveSubnets = connectedSubnets.length > 0 ? connectedSubnets : subnetNodes;

    const connectedSgs = incoming
      .map((e) => nodeById[e.source])
      .filter((n): n is CloudNode => n?.data.serviceType === 'aws_security_group');
    const effectiveSgs = connectedSgs.length > 0 ? connectedSgs : sgNodes;

    const explicitDeps = incoming
      .filter((e) => e.data?.relationshipType === 'depends_on')
      .map((e) => nodeById[e.source])
      .filter(Boolean);

    const dependsOnLine =
      explicitDeps.length > 0
        ? `\n  depends_on = [${explicitDeps
            .map(
              (d) =>
                `${d.data.serviceType}.${sanitizeIdentifier(
                  d.data.resourceName || d.data.label
                )}`
            )
            .join(', ')}]`
        : '';

    const block = renderResourceBlock(
      node,
      resName,
      cfg,
      envId,
      connectedVpc,
      effectiveSubnets,
      effectiveSgs,
      incoming,
      outgoing,
      nodeById,
      dependsOnLine
    );

    resourceBlocks.push(block);
  }

  // 4. Generate Cross-Resource Wiring Blocks (API Gateway Integrations, Event Source Mappings, IAM Policies, ALB Attachments)
  const wiringBlocks = renderEdgeWiringBlocks(activeEdges, nodeById, envId);
  if (wiringBlocks.length > 0) {
    resourceBlocks.push(`# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================`);
    resourceBlocks.push(...wiringBlocks);
  }

  const mainTf = resourceBlocks.join('\n\n') + '\n';

  // 5. Generate outputs.tf
  const outputsTf = generateOutputsTf(activeNodes);

  // 6. Generate AWS Emulator helper scripts & Docker Compose for all 4 environments
  const emulatorScriptSh = generateEmulatorShellScript(envProfile, allEnvironments);
  const dockerfile = generateEmulatorDockerfile();
  const dockerComposeYml = generateDockerComposeYml(allEnvironments);

  return {
    environment: envProfile,
    mainTf,
    providerTf,
    variablesTf,
    tfvars,
    outputsTf,
    emulatorScriptSh,
    dockerfile,
    dockerComposeYml,
  };
}

function generateProviderTf(
  env: EnvironmentProfile,
  targetLocalEmulator: boolean
): string {
  if (!targetLocalEmulator) {
    return `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.default_tags
  }
}
`;
  }

  return `# ============================================================================
# AWS Emulator Provider Configuration (https://github.com/aws/aws-emulator)
# Environment: ${env.name} (${env.id}) -> HTTPS Endpoint 127.0.0.1:${env.emulatorPort}
# ============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Point all AWS API operations to local aws-emulator router instance for [${env.id}]
  endpoints {
    apigateway     = var.emulator_endpoint
    apigatewayv2   = var.emulator_endpoint
    autoscaling    = var.emulator_endpoint
    bedrock        = var.emulator_endpoint
    bedrockagent   = var.emulator_endpoint
    cloudfront     = var.emulator_endpoint
    cloudwatch     = var.emulator_endpoint
    cognitoidp     = var.emulator_endpoint
    dynamodb       = var.emulator_endpoint
    ec2            = var.emulator_endpoint
    ecr            = var.emulator_endpoint
    ecs            = var.emulator_endpoint
    efs            = var.emulator_endpoint
    eks            = var.emulator_endpoint
    elasticache    = var.emulator_endpoint
    elbv2          = var.emulator_endpoint
    events         = var.emulator_endpoint
    iam            = var.emulator_endpoint
    kinesis        = var.emulator_endpoint
    kms            = var.emulator_endpoint
    lambda         = var.emulator_endpoint
    logs           = var.emulator_endpoint
    opensearch     = var.emulator_endpoint
    rds            = var.emulator_endpoint
    route53        = var.emulator_endpoint
    s3             = var.emulator_endpoint
    secretsmanager = var.emulator_endpoint
    sfn            = var.emulator_endpoint
    sns            = var.emulator_endpoint
    sqs            = var.emulator_endpoint
    ssm            = var.emulator_endpoint
    sts            = var.emulator_endpoint
  }

  # AWS Emulator local credentials & self-signed CA bundle (~/.aws/emulator/${env.emulatorPort}/)
  shared_credentials_files = [pathexpand("~/.aws/emulator/\${var.emulator_port}/emulator_credentials")]
  shared_config_files      = [pathexpand("~/.aws/emulator/\${var.emulator_port}/config")]
  custom_ca_bundle         = pathexpand("~/.aws/emulator/\${var.emulator_port}/ca.pem")

  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  default_tags {
    tags = var.default_tags
  }
}
`;
}

function generateVariablesAndTfvars(
  env: EnvironmentProfile,
  allEnvs: Record<EnvironmentId, EnvironmentProfile>
): { variablesTf: string; tfvars: string } {
  const variablesTf = `variable "environment" {
  description = "Target deployment environment (dev, testing, staging, prod)"
  type        = string
  default     = "${env.id}"
}

variable "aws_region" {
  description = "AWS Region for this environment"
  type        = string
  default     = "${env.region}"
}

variable "emulator_port" {
  description = "Local AWS Emulator port for isolated environment state"
  type        = number
  default     = ${env.emulatorPort}
}

variable "emulator_endpoint" {
  description = "Local AWS Emulator HTTPS endpoint URL"
  type        = string
  default     = "${env.emulatorEndpoint}"
}

variable "default_tags" {
  description = "Default resource tags applied across the environment"
  type        = map(string)
  default     = {
${Object.entries(env.defaultTags)
  .map(([k, v]) => `    ${k} = "${v}"`)
  .join('\n')}
  }
}
`;

  const envSummaryComments = Object.values(allEnvs)
    .map(
      (e) =>
        `#   - ${e.id.padEnd(8)} : region=${e.region}, port=${e.emulatorPort}, endpoint=${e.emulatorEndpoint}`
    )
    .join('\n');

  const tfvars = `# ============================================================================
# Environment Variable Values: ${env.name} (${env.id}.tfvars)
# Multi-Environment Matrix:
${envSummaryComments}
# ============================================================================

environment       = "${env.id}"
aws_region        = "${env.region}"
emulator_port     = ${env.emulatorPort}
emulator_endpoint = "${env.emulatorEndpoint}"

default_tags = {
${Object.entries(env.defaultTags)
  .map(([k, v]) => `  ${k} = "${v}"`)
  .join('\n')}
}
`;

  return { variablesTf, tfvars };
}

function renderResourceBlock(
  node: CloudNode,
  resName: string,
  cfg: Record<string, any>,
  envId: EnvironmentId,
  connectedVpc: CloudNode | undefined,
  effectiveSubnets: CloudNode[],
  effectiveSgs: CloudNode[],
  incoming: CloudEdge[],
  outgoing: CloudEdge[],
  nodeById: Record<string, CloudNode>,
  dependsOnLine: string
): string {
  const type = node.data.serviceType;
  const vpcRef = connectedVpc
    ? `aws_vpc.${sanitizeIdentifier(connectedVpc.data.resourceName || connectedVpc.data.label)}.id`
    : `"vpc-default-${envId}"`;

  const subnetIdsArray =
    effectiveSubnets.length > 0
      ? `[${effectiveSubnets
          .map(
            (s) =>
              `aws_subnet.${sanitizeIdentifier(s.data.resourceName || s.data.label)}.id`
          )
          .join(', ')}]`
      : `["subnet-default-${envId}-a", "subnet-default-${envId}-b"]`;

  const firstSubnetRef =
    effectiveSubnets.length > 0
      ? `aws_subnet.${sanitizeIdentifier(
          effectiveSubnets[0].data.resourceName || effectiveSubnets[0].data.label
        )}.id`
      : `"subnet-default-${envId}-a"`;

  const sgIdsArray =
    effectiveSgs.length > 0
      ? `[${effectiveSgs
          .map(
            (sg) =>
              `aws_security_group.${sanitizeIdentifier(
                sg.data.resourceName || sg.data.label
              )}.id`
          )
          .join(', ')}]`
      : `[]`;

  switch (type) {
    case 'aws_vpc':
      return `resource "aws_vpc" "${resName}" {
  cidr_block                       = "${cfg.cidr_block || '10.0.0.0/16'}"
  instance_tenancy                 = "${cfg.instance_tenancy || 'default'}"
  enable_dns_support               = ${Boolean(cfg.enable_dns_support ?? true)}
  enable_dns_hostnames             = ${Boolean(cfg.enable_dns_hostnames ?? true)}
  assign_generated_ipv6_cidr_block = ${Boolean(cfg.assign_generated_ipv6_cidr_block ?? false)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_subnet':
      return `resource "aws_subnet" "${resName}" {
  vpc_id                  = ${vpcRef}
  cidr_block              = "${cfg.cidr_block || '10.0.1.0/24'}"
  availability_zone       = "${cfg.availability_zone || 'us-east-1a'}"
  map_public_ip_on_launch = ${Boolean(cfg.map_public_ip_on_launch ?? true)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
    Tier = "${cfg.tier || 'public'}"
  })${dependsOnLine}
}`;

    case 'aws_internet_gateway':
      return `resource "aws_internet_gateway" "${resName}" {
  vpc_id = ${vpcRef}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_nat_gateway':
      return `resource "aws_eip" "${resName}_eip" {
  domain = "vpc"
  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}-eip"
  })
}

resource "aws_nat_gateway" "${resName}" {
  allocation_id     = aws_eip.${resName}_eip.id
  subnet_id         = ${firstSubnetRef}
  connectivity_type = "${cfg.connectivity_type || 'public'}"

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_route_table': {
      const igwNode = Object.values(nodeById).find(
        (n) => n.data.serviceType === 'aws_internet_gateway'
      );
      const gwRef = igwNode
        ? `aws_internet_gateway.${sanitizeIdentifier(
            igwNode.data.resourceName || igwNode.data.label
          )}.id`
        : `"igw-local"`;
      return `resource "aws_route_table" "${resName}" {
  vpc_id = ${vpcRef}

  route {
    cidr_block = "${cfg.default_cidr_block || '0.0.0.0/0'}"
    gateway_id = ${gwRef}
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;
    }

    case 'aws_security_group':
      return `resource "aws_security_group" "${resName}" {
  name        = "\${local.name_prefix}-${resName}"
  description = "${cfg.description || 'Managed by LocalCloud Studio'}"
  vpc_id      = ${vpcRef}

  ingress {
    description = "Primary Ingress Rule"
    from_port   = ${Number(cfg.ingress_port ?? 443)}
    to_port     = ${Number(cfg.ingress_port ?? 443)}
    protocol    = "${cfg.ingress_protocol || 'tcp'}"
    cidr_blocks = ["${cfg.ingress_cidr || '0.0.0.0/0'}"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_lb':
      return `resource "aws_lb" "${resName}" {
  name                       = substr("\${local.name_prefix}-${resName}", 0, 32)
  internal                   = ${Boolean(cfg.internal ?? false)}
  load_balancer_type         = "${cfg.load_balancer_type || 'application'}"
  subnets                    = ${subnetIdsArray}
  security_groups            = ${sgIdsArray}
  enable_deletion_protection = ${Boolean(cfg.enable_deletion_protection ?? false)}
  idle_timeout               = ${Number(cfg.idle_timeout ?? 60)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}

resource "aws_lb_target_group" "${resName}_tg" {
  name        = substr("\${local.name_prefix}-${resName}-tg", 0, 32)
  port        = ${Number(cfg.listener_port ?? 80)}
  protocol    = "HTTP"
  vpc_id      = ${vpcRef}
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "${cfg.health_check_path || '/health'}"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener" "${resName}_listener" {
  load_balancer_arn = aws_lb.${resName}.arn
  port              = ${Number(cfg.listener_port ?? 80)}
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${resName}_tg.arn
  }
}`;

    case 'aws_apigatewayv2_api':
      return `resource "aws_apigatewayv2_api" "${resName}" {
  name          = "\${local.name_prefix}-${resName}"
  protocol_type = "${cfg.protocol_type || 'HTTP'}"

  cors_configuration {
    allow_origins = ["${cfg.cors_allow_origins || '*'}"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "x-amz-date"]
    max_age       = 300
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}

resource "aws_apigatewayv2_stage" "${resName}_stage" {
  api_id      = aws_apigatewayv2_api.${resName}.id
  name        = "${cfg.stage_name || '$default'}"
  auto_deploy = ${Boolean(cfg.auto_deploy ?? true)}

  default_route_settings {
    throttling_burst_limit = ${Number(cfg.throttling_burst_limit ?? 5000)}
    throttling_rate_limit  = ${Number(cfg.throttling_rate_limit ?? 10000)}
  }
}`;

    case 'aws_cloudfront_distribution': {
      // Find connected origin (S3, ALB, or API GW)
      const originTarget = outgoing
        .map((e) => nodeById[e.target])
        .find(Boolean);
      let originDomain = `"origin.${envId}.localcloud.internal"`;
      if (originTarget) {
        const tName = sanitizeIdentifier(
          originTarget.data.resourceName || originTarget.data.label
        );
        if (originTarget.data.serviceType === 'aws_s3_bucket') {
          originDomain = `aws_s3_bucket.${tName}.bucket_regional_domain_name`;
        } else if (originTarget.data.serviceType === 'aws_lb') {
          originDomain = `aws_lb.${tName}.dns_name`;
        } else if (originTarget.data.serviceType === 'aws_apigatewayv2_api') {
          originDomain = `replace(aws_apigatewayv2_api.${tName}.api_endpoint, "https://", "")`;
        }
      }

      return `resource "aws_cloudfront_distribution" "${resName}" {
  enabled             = ${Boolean(cfg.enabled ?? true)}
  is_ipv6_enabled     = ${Boolean(cfg.is_ipv6_enabled ?? true)}
  default_root_object = "${cfg.default_root_object || 'index.html'}"
  price_class         = "${cfg.price_class || 'PriceClass_100'}"

  origin {
    domain_name = ${originDomain}
    origin_id   = "${resName}-primary-origin"

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
    target_origin_id       = "${resName}-primary-origin"
    viewer_protocol_policy = "${cfg.viewer_protocol_policy || 'redirect-to-https'}"

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
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;
    }

    case 'aws_route53_zone':
      return `resource "aws_route53_zone" "${resName}" {
  name = "${cfg.domain_name || `${envId}.localcloud.dev`}"
${
  cfg.private_zone
    ? `
  vpc {
    vpc_id = ${vpcRef}
  }`
    : ''
}
  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_instance':
      return `resource "aws_instance" "${resName}" {
  ami                         = "${cfg.ami || 'ami-0c55b159cbfafe1f0'}"
  instance_type               = "${cfg.instance_type || 't3.micro'}"
  subnet_id                   = ${firstSubnetRef}
  vpc_security_group_ids      = ${sgIdsArray}
  associate_public_ip_address = ${Boolean(cfg.associate_public_ip_address ?? false)}
  monitoring                  = ${Boolean(cfg.monitoring ?? false)}

  root_block_device {
    volume_size = ${Number(cfg.root_volume_size ?? 20)}
    volume_type = "${cfg.root_volume_type || 'gp3'}"
    encrypted   = ${Boolean(cfg.ebs_encrypted ?? true)}
  }

  user_data = <<-EOF
${cfg.user_data || '#!/bin/bash\necho "Ready"'}
  EOF

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_lambda_function': {
      let parsedEnvVars: Record<string, string> = {};
      try {
        parsedEnvVars =
          typeof cfg.env_vars === 'string'
            ? JSON.parse(cfg.env_vars)
            : cfg.env_vars || {};
      } catch {
        parsedEnvVars = { STAGE: envId };
      }

      // Inject connected downstream target endpoints into Lambda environment variables automatically!
      for (const edge of outgoing) {
        const targetNode = nodeById[edge.target];
        if (!targetNode) continue;
        const tRes = sanitizeIdentifier(
          targetNode.data.resourceName || targetNode.data.label
        );
        const envKeyPrefix = tRes.toUpperCase();
        if (targetNode.data.serviceType === 'aws_dynamodb_table') {
          parsedEnvVars[`${envKeyPrefix}_TABLE_NAME`] = `\${aws_dynamodb_table.${tRes}.name}`;
        } else if (targetNode.data.serviceType === 'aws_sqs_queue') {
          parsedEnvVars[`${envKeyPrefix}_QUEUE_URL`] = `\${aws_sqs_queue.${tRes}.url}`;
        } else if (targetNode.data.serviceType === 'aws_s3_bucket') {
          parsedEnvVars[`${envKeyPrefix}_BUCKET_NAME`] = `\${aws_s3_bucket.${tRes}.id}`;
        } else if (targetNode.data.serviceType === 'aws_sns_topic') {
          parsedEnvVars[`${envKeyPrefix}_TOPIC_ARN`] = `\${aws_sns_topic.${tRes}.arn}`;
        } else if (targetNode.data.serviceType === 'aws_secretsmanager_secret') {
          parsedEnvVars[`${envKeyPrefix}_SECRET_ARN`] = `\${aws_secretsmanager_secret.${tRes}.arn}`;
        }
      }

      const envEntries = Object.entries(parsedEnvVars)
        .map(([k, v]) => `      ${k} = "${v}"`)
        .join('\n');

      return `resource "aws_iam_role" "${resName}_exec_role" {
  name = "\${local.name_prefix}-${resName}-role"

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

resource "aws_lambda_function" "${resName}" {
  function_name                  = "\${local.name_prefix}-${resName}"
  role                           = aws_iam_role.${resName}_exec_role.arn
  runtime                        = "${cfg.runtime || 'nodejs20.x'}"
  handler                        = "${cfg.handler || 'index.handler'}"
  filename                       = "artifacts/${resName}.zip"
  source_code_hash               = filebase64sha256("artifacts/${resName}.zip")
  memory_size                    = ${Number(cfg.memory_size ?? 256)}
  timeout                        = ${Number(cfg.timeout ?? 30)}
  architectures                  = ["${cfg.architectures || 'arm64'}"]
  reserved_concurrent_executions = ${Number(cfg.reserved_concurrent_executions ?? -1)}

  tracing_config {
    mode = "${cfg.tracing_mode || 'PassThrough'}"
  }

  environment {
    variables = {
      ENVIRONMENT = var.environment
${envEntries}
    }
  }

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;
    }

    case 'aws_autoscaling_group':
      return `resource "aws_launch_template" "${resName}_lt" {
  name_prefix   = "\${local.name_prefix}-${resName}-"
  image_id      = "ami-0c55b159cbfafe1f0"
  instance_type = "${cfg.instance_type || 't3.medium'}"
}

resource "aws_autoscaling_group" "${resName}" {
  name                      = "\${local.name_prefix}-${resName}-asg"
  min_size                  = ${Number(cfg.min_size ?? 1)}
  max_size                  = ${Number(cfg.max_size ?? 4)}
  desired_capacity          = ${Number(cfg.desired_capacity ?? 2)}
  vpc_zone_identifier       = ${subnetIdsArray}
  health_check_type         = "${cfg.health_check_type || 'ELB'}"
  health_check_grace_period = ${Number(cfg.health_check_grace_period ?? 300)}

  launch_template {
    id      = aws_launch_template.${resName}_lt.id
    version = "$Latest"
  }
}`;

    case 'aws_ecs_service':
      return `resource "aws_ecs_cluster" "${resName}_cluster" {
  name = "\${local.name_prefix}-${resName}-cluster"

  setting {
    name  = "containerInsights"
    value = "${envId === 'prod' || envId === 'staging' ? 'enabled' : 'disabled'}"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "${resName}_task" {
  family                   = "\${local.name_prefix}-${resName}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "${cfg.cpu || '256'}"
  memory                   = "${cfg.memory || '512'}"

  container_definitions = jsonencode([
    {
      name      = "${resName}"
      image     = "${cfg.container_image || 'public.ecr.aws/nginx/nginx:stable-alpine'}"
      essential = true
      portMappings = [
        {
          containerPort = ${Number(cfg.container_port ?? 80)}
          hostPort      = ${Number(cfg.container_port ?? 80)}
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "ENVIRONMENT", value = var.environment }
      ]
    }
  ])
}

resource "aws_ecs_service" "${resName}" {
  name                   = "\${local.name_prefix}-${resName}"
  cluster                = aws_ecs_cluster.${resName}_cluster.id
  task_definition        = aws_ecs_task_definition.${resName}_task.arn
  desired_count          = ${Number(cfg.desired_count ?? 2)}
  launch_type            = "FARGATE"
  enable_execute_command = ${Boolean(cfg.enable_execute_command ?? true)}

  network_configuration {
    subnets          = ${subnetIdsArray}
    security_groups  = ${sgIdsArray}
    assign_public_ip = ${Boolean(cfg.assign_public_ip ?? false)}
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_eks_cluster':
      return `resource "aws_iam_role" "${resName}_eks_role" {
  name = "\${local.name_prefix}-${resName}-eks-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
    }]
  })
}

resource "aws_eks_cluster" "${resName}" {
  name     = "\${local.name_prefix}-${resName}"
  role_arn = aws_iam_role.${resName}_eks_role.arn
  version  = "${cfg.kubernetes_version || '1.31'}"

  vpc_config {
    subnet_ids              = ${subnetIdsArray}
    endpoint_public_access  = ${Boolean(cfg.endpoint_public_access ?? true)}
    endpoint_private_access = ${Boolean(cfg.endpoint_private_access ?? true)}
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_ecr_repository':
      return `resource "aws_ecr_repository" "${resName}" {
  name                 = "\${local.name_prefix}/${resName}"
  image_tag_mutability = "${cfg.image_tag_mutability || 'MUTABLE'}"
  force_delete         = ${Boolean(cfg.force_delete ?? true)}

  image_scanning_configuration {
    scan_on_push = ${Boolean(cfg.scan_on_push ?? true)}
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_s3_bucket': {
      const blocks: string[] = [];
      blocks.push(`resource "aws_s3_bucket" "${resName}" {
  bucket        = "\${local.name_prefix}-${cfg.bucket_prefix || resName}"
  force_destroy = ${Boolean(cfg.force_destroy ?? true)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`);

      blocks.push(`resource "aws_s3_bucket_versioning" "${resName}_versioning" {
  bucket = aws_s3_bucket.${resName}.id
  versioning_configuration {
    status = "${cfg.versioning_enabled ? 'Enabled' : 'Suspended'}"
  }
}`);

      blocks.push(`resource "aws_s3_bucket_server_side_encryption_configuration" "${resName}_sse" {
  bucket = aws_s3_bucket.${resName}.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "${cfg.sse_algorithm || 'AES256'}"
    }
  }
}`);

      blocks.push(`resource "aws_s3_bucket_public_access_block" "${resName}_pab" {
  bucket                  = aws_s3_bucket.${resName}.id
  block_public_acls       = ${Boolean(cfg.block_public_acls ?? true)}
  block_public_policy     = ${Boolean(cfg.block_public_acls ?? true)}
  ignore_public_acls      = ${Boolean(cfg.block_public_acls ?? true)}
  restrict_public_buckets = ${Boolean(cfg.block_public_acls ?? true)}
}`);

      if (Number(cfg.lifecycle_expiration_days) > 0) {
        blocks.push(`resource "aws_s3_bucket_lifecycle_configuration" "${resName}_lifecycle" {
  bucket = aws_s3_bucket.${resName}.id
  rule {
    id     = "auto-expire-objects"
    status = "Enabled"
    filter {}
    expiration {
      days = ${Number(cfg.lifecycle_expiration_days)}
    }
  }
}`);
      }

      return blocks.join('\n\n');
    }

    case 'aws_efs_file_system':
      return `resource "aws_efs_file_system" "${resName}" {
  creation_token   = "\${local.name_prefix}-${resName}"
  performance_mode = "${cfg.performance_mode || 'generalPurpose'}"
  throughput_mode  = "${cfg.throughput_mode || 'bursting'}"
  encrypted        = ${Boolean(cfg.encrypted ?? true)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_dynamodb_table': {
      const isProv = cfg.billing_mode === 'PROVISIONED';
      const hasRangeKey = Boolean(cfg.range_key && String(cfg.range_key).trim());
      return `resource "aws_dynamodb_table" "${resName}" {
  name             = "\${local.name_prefix}-${resName}"
  billing_mode     = "${cfg.billing_mode || 'PAY_PER_REQUEST'}"
  hash_key         = "${cfg.hash_key || 'pk'}"
${hasRangeKey ? `  range_key        = "${cfg.range_key}"\n` : ''}${
        isProv
          ? `  read_capacity    = ${Number(cfg.read_capacity ?? 5)}\n  write_capacity   = ${Number(cfg.write_capacity ?? 5)}\n`
          : ''
      }  stream_enabled   = ${Boolean(cfg.stream_enabled ?? true)}
  stream_view_type = "${cfg.stream_view_type || 'NEW_AND_OLD_IMAGES'}"

  attribute {
    name = "${cfg.hash_key || 'pk'}"
    type = "${cfg.hash_key_type || 'S'}"
  }
${
  hasRangeKey
    ? `
  attribute {
    name = "${cfg.range_key}"
    type = "${cfg.range_key_type || 'S'}"
  }`
    : ''
}

  point_in_time_recovery {
    enabled = ${Boolean(cfg.point_in_time_recovery ?? false)}
  }
${
  cfg.ttl_attribute
    ? `
  ttl {
    attribute_name = "${cfg.ttl_attribute}"
    enabled        = true
  }`
    : ''
}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })

  # Not modeled on the canvas; AWS Emulator reports -1 here, which would otherwise diff on every plan
  lifecycle {
    ignore_changes = [on_demand_throughput]
  }${dependsOnLine}
}`;
    }

    case 'aws_db_instance':
      return `resource "aws_db_instance" "${resName}" {
  identifier              = "\${local.name_prefix}-${resName}"
  engine                  = "${cfg.engine || 'postgres'}"
  engine_version          = "${cfg.engine_version || '16.3'}"
  instance_class          = "${cfg.instance_class || 'db.t4g.micro'}"
  allocated_storage       = ${Number(cfg.allocated_storage ?? 20)}
  max_allocated_storage   = ${Number(cfg.max_allocated_storage ?? 100)}
  db_name                 = "${cfg.db_name || 'appdb'}"
  username                = "${cfg.username || 'dbadmin'}"
  manage_master_user_password = true
  multi_az                = ${Boolean(cfg.multi_az ?? false)}
  storage_encrypted       = ${Boolean(cfg.storage_encrypted ?? true)}
  backup_retention_period = ${Number(cfg.backup_retention_period ?? 7)}
  skip_final_snapshot     = ${Boolean(cfg.skip_final_snapshot ?? true)}
  vpc_security_group_ids  = ${sgIdsArray}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_elasticache_cluster':
      return `resource "aws_elasticache_cluster" "${resName}" {
  cluster_id           = "\${local.name_prefix}-${resName}"
  engine               = "${cfg.engine || 'redis'}"
  node_type            = "${cfg.node_type || 'cache.t4g.micro'}"
  num_cache_nodes      = ${Number(cfg.num_cache_nodes ?? 1)}
  port                 = ${Number(cfg.port ?? 6379)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_sqs_queue': {
      const suffix = cfg.fifo_queue ? '.fifo' : '';
      const dlqBlock = cfg.enable_dlq
        ? `resource "aws_sqs_queue" "${resName}_dlq" {
  name                      = "\${local.name_prefix}-${resName}-dlq${suffix}"
  fifo_queue                = ${Boolean(cfg.fifo_queue ?? false)}
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}\n\n`
        : '';

      return `${dlqBlock}resource "aws_sqs_queue" "${resName}" {
  name                       = "\${local.name_prefix}-${resName}${suffix}"
  fifo_queue                 = ${Boolean(cfg.fifo_queue ?? false)}
  visibility_timeout_seconds = ${Number(cfg.visibility_timeout_seconds ?? 30)}
  message_retention_seconds  = ${Number(cfg.message_retention_seconds ?? 345600)}
  delay_seconds              = ${Number(cfg.delay_seconds ?? 0)}
  receive_wait_time_seconds  = ${Number(cfg.receive_wait_time_seconds ?? 10)}
  sqs_managed_sse_enabled    = ${Boolean(cfg.sqs_managed_sse_enabled ?? true)}
${
  cfg.enable_dlq
    ? `
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.${resName}_dlq.arn
    maxReceiveCount     = 5
  })`
    : ''
}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;
    }

    case 'aws_sns_topic': {
      const suffix = cfg.fifo_topic ? '.fifo' : '';
      return `resource "aws_sns_topic" "${resName}" {
  name                        = "\${local.name_prefix}-${resName}${suffix}"
  display_name                = "${cfg.display_name || resName}"
  fifo_topic                  = ${Boolean(cfg.fifo_topic ?? false)}
  content_based_deduplication = ${Boolean(cfg.content_based_deduplication ?? false)}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;
    }

    case 'aws_cloudwatch_event_bus':
      return `resource "aws_cloudwatch_event_bus" "${resName}" {
  name = "\${local.name_prefix}-${resName}"
  tags = local.common_tags${dependsOnLine}
}

resource "aws_cloudwatch_event_rule" "${resName}_rule" {
  name           = "\${local.name_prefix}-${resName}-rule"
  event_bus_name = aws_cloudwatch_event_bus.${resName}.name
  event_pattern = jsonencode({
    source = ["${cfg.event_pattern_source || 'custom.app'}"]
  })
}`;

    case 'aws_sfn_state_machine':
      return `resource "aws_iam_role" "${resName}_sfn_role" {
  name = "\${local.name_prefix}-${resName}-sfn-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_sfn_state_machine" "${resName}" {
  name     = "\${local.name_prefix}-${resName}"
  role_arn = aws_iam_role.${resName}_sfn_role.arn
  type     = "${cfg.type || 'STANDARD'}"

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
    enabled = ${Boolean(cfg.tracing_enabled ?? true)}
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_iam_role':
      return `resource "aws_iam_role" "${resName}" {
  name                 = "\${local.name_prefix}-${resName}"
  max_session_duration = ${Number(cfg.max_session_duration ?? 3600)}

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "${cfg.principal_service || 'lambda.amazonaws.com'}"
      }
    }]
  })

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_kms_key':
      return `resource "aws_kms_key" "${resName}" {
  description             = "KMS Master Key for ${resName} (\${var.environment})"
  key_usage               = "${cfg.key_usage || 'ENCRYPT_DECRYPT'}"
  enable_key_rotation     = ${Boolean(cfg.enable_key_rotation ?? true)}
  deletion_window_in_days = ${Number(cfg.deletion_window_in_days ?? 7)}

  tags = local.common_tags${dependsOnLine}
}

resource "aws_kms_alias" "${resName}_alias" {
  name          = "alias/\${local.name_prefix}-${cfg.alias_name || resName}"
  target_key_id = aws_kms_key.${resName}.key_id
}`;

    case 'aws_secretsmanager_secret':
      return `resource "aws_secretsmanager_secret" "${resName}" {
  name                    = "\${local.name_prefix}/${cfg.secret_prefix || resName}"
  recovery_window_in_days = ${Number(cfg.recovery_window_in_days ?? 0)}

  tags = local.common_tags${dependsOnLine}
}

resource "aws_secretsmanager_secret_version" "${resName}_val" {
  secret_id     = aws_secretsmanager_secret.${resName}.id
  secret_string = ${JSON.stringify(cfg.secret_json || '{"key":"value"}')}
}`;

    case 'aws_cognito_user_pool':
      return `resource "aws_cognito_user_pool" "${resName}" {
  name                     = "\${local.name_prefix}-${resName}"
  mfa_configuration        = "${cfg.mfa_configuration || 'OFF'}"
  auto_verified_attributes = ${cfg.auto_verified_attributes ? '["email"]' : '[]'}

  password_policy {
    minimum_length    = ${Number(cfg.password_minimum_length ?? 8)}
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  tags = local.common_tags${dependsOnLine}
}${
        cfg.create_app_client
          ? `

resource "aws_cognito_user_pool_client" "${resName}_client" {
  name         = "\${local.name_prefix}-${resName}-web-client"
  user_pool_id = aws_cognito_user_pool.${resName}.id
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]
}`
          : ''
      }`;

    case 'aws_cloudwatch_log_group':
      return `resource "aws_cloudwatch_log_group" "${resName}" {
  name              = "${cfg.log_group_prefix || '/aws/localcloud'}/\${var.environment}/${resName}"
  retention_in_days = ${Number(cfg.retention_in_days ?? 14)}

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_ssm_parameter':
      return `resource "aws_ssm_parameter" "${resName}" {
  name  = "/\${var.environment}${cfg.param_name || `/app/${resName}`}"
  type  = "${cfg.param_type || 'String'}"
  value = ${JSON.stringify(cfg.param_value || 'enabled')}

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_kinesis_stream':
      return `resource "aws_kinesis_stream" "${resName}" {
  name             = "\${local.name_prefix}-${resName}"
  retention_period = ${Number(cfg.retention_period ?? 24)}
${
  cfg.stream_mode === 'PROVISIONED'
    ? `  shard_Count      = ${Number(cfg.shard_count ?? 1)}`
    : ''
}
  stream_mode_details {
    stream_mode = "${cfg.stream_mode || 'ON_DEMAND'}"
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_opensearch_domain':
      return `resource "aws_opensearch_domain" "${resName}" {
  domain_name    = substr("\${local.name_prefix}-${resName}", 0, 28)
  engine_version = "${cfg.engine_version || 'OpenSearch_2.15'}"

  cluster_config {
    instance_type  = "${cfg.instance_type || 't3.small.search'}"
    instance_count = ${Number(cfg.instance_count ?? 1)}
  }

  ebs_options {
    ebs_enabled = true
    volume_size = ${Number(cfg.ebs_volume_size ?? 20)}
    volume_type = "gp3"
  }

  tags = local.common_tags${dependsOnLine}
}`;

    case 'aws_bedrock_agent':
      return `resource "aws_iam_role" "${resName}_agent_role" {
  name = "\${local.name_prefix}-${resName}-agent-role"

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

resource "aws_bedrockagent_agent" "${resName}" {
  agent_name                  = "\${local.name_prefix}-${resName}"
  agent_resource_role_arn     = aws_iam_role.${resName}_agent_role.arn
  foundation_model            = "${cfg.foundation_model || 'anthropic.claude-3-5-sonnet-20241022-v2:0'}"
  instruction                 = ${JSON.stringify(
    cfg.instruction || 'You are an AWS cloud infrastructure AI assistant.'
  )}
  idle_session_ttl_in_seconds = ${Number(cfg.idle_session_ttl_in_seconds ?? 600)}

  tags = local.common_tags${dependsOnLine}
}`;

    default:
      return `# Unmapped service ${type} (${resName})`;
  }
}

function renderEdgeWiringBlocks(
  edges: CloudEdge[],
  nodeById: Record<string, CloudNode>,
  _envId: EnvironmentId
): string[] {
  const blocks: string[] = [];

  for (const edge of edges) {
    const src = nodeById[edge.source];
    const dst = nodeById[edge.target];
    if (!src || !dst) continue;

    const srcName = sanitizeIdentifier(src.data.resourceName || src.data.label);
    const dstName = sanitizeIdentifier(dst.data.resourceName || dst.data.label);
    const srcType = src.data.serviceType;
    const dstType = dst.data.serviceType;

    // 1. API Gateway -> Lambda Integration & Route & Permission
    if (srcType === 'aws_apigatewayv2_api' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_apigatewayv2_integration" "${srcName}_to_${dstName}" {
  api_id                 = aws_apigatewayv2_api.${srcName}.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.${dstName}.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "${srcName}_route_${dstName}" {
  api_id    = aws_apigatewayv2_api.${srcName}.id
  route_key = "${edge.data?.label && edge.data.label.includes('/') ? edge.data.label : `ANY /${dstName}/{proxy+}`}"
  target    = "integrations/\${aws_apigatewayv2_integration.${srcName}_to_${dstName}.id}"
}

resource "aws_lambda_permission" "${srcName}_invoke_${dstName}" {
  statement_id  = "AllowExecutionFromAPIGateway-${srcName}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.${dstName}.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "\${aws_apigatewayv2_api.${srcName}.execution_arn}/*/*"
}`);
    }

    // 2. SQS Queue -> Lambda Event Source Mapping
    if (srcType === 'aws_sqs_queue' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_iam_role_policy" "${dstName}_consume_${srcName}" {
  name = "${dstName}-consume-${srcName}"
  role = aws_iam_role.${dstName}_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = aws_sqs_queue.${srcName}.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "${srcName}_trigger_${dstName}" {
  event_source_arn = aws_sqs_queue.${srcName}.arn
  function_name    = aws_lambda_function.${dstName}.arn
  batch_size       = 10
  enabled          = true
  depends_on       = [aws_iam_role_policy.${dstName}_consume_${srcName}]
}`);
    }

    // 3. Kinesis Stream -> Lambda Event Source Mapping
    if (srcType === 'aws_kinesis_stream' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_iam_role_policy" "${dstName}_consume_${srcName}" {
  name = "${dstName}-consume-${srcName}"
  role = aws_iam_role.${dstName}_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:ListStreams"]
      Resource = aws_kinesis_stream.${srcName}.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "${srcName}_stream_${dstName}" {
  event_source_arn  = aws_kinesis_stream.${srcName}.arn
  function_name     = aws_lambda_function.${dstName}.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.${dstName}_consume_${srcName}]
}`);
    }

    // 4. SNS Topic -> SQS or Lambda Subscription
    if (srcType === 'aws_sns_topic' && dstType === 'aws_sqs_queue') {
      blocks.push(`resource "aws_sns_topic_subscription" "${srcName}_sub_${dstName}" {
  topic_arn = aws_sns_topic.${srcName}.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.${dstName}.arn
}`);
    }
    if (srcType === 'aws_sns_topic' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_sns_topic_subscription" "${srcName}_sub_${dstName}" {
  topic_arn = aws_sns_topic.${srcName}.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.${dstName}.arn
}`);
    }

    // 5. Lambda -> DynamoDB / S3 / SQS / SecretsManager IAM Role Policy Grant
    if (srcType === 'aws_lambda_function') {
      if (dstType === 'aws_dynamodb_table') {
        blocks.push(`resource "aws_iam_role_policy" "${srcName}_ddb_${dstName}" {
  name = "${srcName}-ddb-${dstName}"
  role = aws_iam_role.${srcName}_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]
      Resource = [aws_dynamodb_table.${dstName}.arn, "\${aws_dynamodb_table.${dstName}.arn}/index/*"]
    }]
  })
}`);
      } else if (dstType === 'aws_s3_bucket') {
        blocks.push(`resource "aws_iam_role_policy" "${srcName}_s3_${dstName}" {
  name = "${srcName}-s3-${dstName}"
  role = aws_iam_role.${srcName}_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.${dstName}.arn, "\${aws_s3_bucket.${dstName}.arn}/*"]
    }]
  })
}`);
      } else if (dstType === 'aws_sqs_queue') {
        blocks.push(`resource "aws_iam_role_policy" "${srcName}_sqs_${dstName}" {
  name = "${srcName}-sqs-${dstName}"
  role = aws_iam_role.${srcName}_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [aws_sqs_queue.${dstName}.arn]
    }]
  })
}`);
      }
    }
  }

  return blocks;
}

function generateOutputsTf(activeNodes: CloudNode[]): string {
  const lines: string[] = [
    `# ============================================================================
# Compiled Terraform Outputs
# ============================================================================`,
  ];

  for (const node of activeNodes) {
    const svc = SERVICE_BY_TYPE[node.data.serviceType];
    if (!svc || !svc.outputs.length) continue;
    const resName = sanitizeIdentifier(node.data.resourceName || node.data.label);
    for (const out of svc.outputs) {
      lines.push(`output "${resName}_${out.name}" {
  description = "${out.description} (${node.data.label})"
  value       = ${out.tfExpression(resName)}
}`);
    }
  }

  return lines.join('\n\n') + '\n';
}

function generateEmulatorDockerfile(): string {
  return `# ============================================================================
# AWS Emulator Official Container Image (https://github.com/aws/aws-emulator)
# Supports x86_64 and Apple Silicon (aarch64)
# ============================================================================
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG TARGETARCH=aarch64
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-aarch64.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \\
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297 9298 9299 9300
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`;
}

function generateDockerComposeYml(
  allEnvs: Record<EnvironmentId, EnvironmentProfile>
): string {
  const services = Object.values(allEnvs)
    .map((env) => {
      const telemetryFlag = env.emulatorTelemetry ? 'on' : 'off';
      const authFlag = env.emulatorAuth ? 'on' : 'off';
      return `  aws-emulator-${env.id}:
    build:
      context: .
      dockerfile: Dockerfile.emulator
    image: aws-emulator:local
    container_name: localcloud-aws-emulator-${env.id}
    ports:
      - "127.0.0.1:${env.emulatorPort}:${env.emulatorPort}"
    environment:
      - HOME=\${HOME}
      - EMULATOR_TELEMETRY=${telemetryFlag}
    volumes:
      - "\${HOME}/.aws/emulator:\${HOME}/.aws/emulator"
    command: ["-p", "${env.emulatorPort}", "--telemetry", "${telemetryFlag}", "--auth", "${authFlag}"]
    deploy:
      resources:
        limits:
          memory: 2G`;
    })
    .join('\n\n');

  return `# ============================================================================
# Multi-Environment AWS Emulator Cluster (dev, testing, staging, prod)
# Each environment runs an isolated in-memory AWS Emulator on its dedicated port
# ============================================================================
services:
${services}
`;
}

function generateEmulatorShellScript(
  env: EnvironmentProfile,
  allEnvs: Record<EnvironmentId, EnvironmentProfile>
): string {
  const port = env.emulatorPort;
  const envPortsComment = Object.values(allEnvs)
    .map((e) => `#   ${e.id.padEnd(8)} -> Port ${e.emulatorPort} (${e.region})`)
    .join('\n');

  return `#!/usr/bin/env bash
# ============================================================================
# LocalCloud Studio — AWS Emulator Launcher & SDK Environment Setup
# Active Environment: ${env.name} (${env.id})
#
# Multi-Environment Port Allocation:
${envPortsComment}
# ============================================================================
set -euo pipefail

PORT=${port}
REGION="${env.region}"
ENV_NAME="${env.id}"

mkdir -p "$HOME/.aws/emulator"

echo "🚀 Configuring shell for AWS Emulator [\$ENV_NAME] on https://127.0.0.1:\$PORT (\$REGION)..."

# 1. Export AWS SDK / CLI / Terraform environment variables for aws-emulator
export AWS_ENDPOINT_URL="https://127.0.0.1:\$PORT"
export AWS_SHARED_CREDENTIALS_FILE="\$HOME/.aws/emulator/\$PORT/emulator_credentials"
export AWS_CONFIG_FILE="\$HOME/.aws/emulator/\$PORT/config"
export AWS_CA_BUNDLE="\$HOME/.aws/emulator/\$PORT/ca.pem"
export NODE_EXTRA_CA_CERTS="\$HOME/.aws/emulator/\$PORT/ca.pem"
export AWS_EC2_METADATA_DISABLED="true"
export AWS_DISABLE_HOST_PREFIX_INJECTION="true"
export AWS_REGION="\$REGION"
export AWS_DEFAULT_REGION="\$REGION"
export EMULATOR_TELEMETRY="${env.emulatorTelemetry ? 'on' : 'off'}"

# 2. Unset real AWS credentials so requests are signed with emulator keys
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE || true

# 3. Health check helper
check_health() {
  curl -sf --cacert "\$HOME/.aws/emulator/\$PORT/ca.pem" "https://127.0.0.1:\$PORT/__admin/health" >/dev/null 2>&1
}

if check_health; then
  echo "✅ AWS Emulator [\$ENV_NAME] is healthy on https://127.0.0.1:\$PORT"
else
  echo "⚠️  AWS Emulator is not running yet on port \$PORT. Start it via Docker:"
  echo "   docker run --rm -d --name aws-emulator-\$ENV_NAME --memory=2g --memory-swap=2g \\\\"
  echo "     -p 127.0.0.1:\$PORT:\$PORT -e HOME=\"\$HOME\" \\\\"
  echo "     -v \"\$HOME/.aws/emulator:\$HOME/.aws/emulator\" \\\\"
  echo "     aws-emulator -p \$PORT --telemetry ${env.emulatorTelemetry ? 'on' : 'off'}"
fi

# 4. Run Terraform against this environment
echo ""
echo "📦 To provision [${env.id}] infrastructure into AWS Emulator:"
echo "   terraform init"
echo "   terraform apply -var-file=\"${env.id}.tfvars\" -auto-approve"
`;
}
