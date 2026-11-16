import type {
  CloudNode,
  CloudEdge,
  EnvironmentId,
  EnvironmentProfile,
} from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { findAncestorOfType } from './canvasLayout';
import { adjustmentComment, emulatorInstanceType, emulatorKinesisRetention, isBurstableInstanceType } from './emulatorAdjustments';
import {
  dnsSafeName,
  isRedisReplicationGroup,
  mainResourceType,
  resolveNodeConfigForEnv,
  sanitizeIdentifier,
} from './terraformNames';

import {
  cloudfrontOrigins,
  cognitoTriggers,
  connectionEnvVars,
  hasGrants,
  isWired,
  lbTargets,
  onDemandCallerRole,
  renderEdgeWiringBlocks,
  sfnDefinition,
} from './terraformWiring';

// These lived here first and are imported from this module all over the app
export { mainResourceType, resolveNodeConfigForEnv, sanitizeIdentifier };

/**
 * Base dir for the emulator's per-port credentials and CA, as written into provider.tf.
 * `~` expands against the terraform process's home, which is wrong when terraform runs inside
 * the backend's container — there LOCALCLOUD_EMULATOR_DIR carries the host-shared absolute path.
 */
function emulatorDir(): string {
  return process.env.LOCALCLOUD_EMULATOR_DIR || '~/.aws/emulator';
}

export function isFieldOverriddenInEnv(
  node: CloudNode,
  envId: EnvironmentId,
  fieldKey: string
): boolean {
  const overrides = node.data.envOverrides?.[envId];
  return Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, fieldKey));
}

/** Config key holding hand-written HCL appended to a node's main resource block. Scoped like any other field. */
export const EXTRA_HCL_KEY = '_extra_hcl';

/**
 * Appends raw HCL lines inside `resource "<tfType>" "<resName>" { ... }`, just before its closing brace.
 * Interpolations and JSON keep braces balanced, so plain depth counting finds the end of the block.
 */
export function injectExtraHcl(blocks: string, tfType: string, resName: string, extraHcl: string): string {
  const extra = extraHcl.replace(/\s+$/, '');
  if (!extra.trim()) return blocks;

  const header = `resource "${tfType}" "${resName}" {`;
  const start = blocks.indexOf(header);
  if (start === -1) {
    return `${blocks}\n\n# Extra HCL for ${resName} was not applied: no ${tfType} block to attach it to.`;
  }

  let depth = 1;
  let i = start + header.length;
  while (i < blocks.length && depth > 0) {
    if (blocks[i] === '{') depth++;
    else if (blocks[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return blocks;

  const closeIdx = i - 1;
  const indented = extra
    .split('\n')
    .map((line) => (line.trim() ? `  ${line.replace(/\s+$/, '')}` : ''))
    .join('\n');
  return `${blocks.slice(0, closeIdx).replace(/\s+$/, '')}\n\n  # Extra arguments (hand-written)\n${indented}\n${blocks.slice(closeIdx)}`;
}

/** The text of the block that opens at `open` (index of its `{`), braces included, or null if unbalanced. */
function blockAt(text: string, open: number): { start: number; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { start: open, end: i + 1 };
  }
  return null;
}

/**
 * Terraform allows one `lifecycle` block per resource, but the compiler writes one (to ignore
 * attributes the emulator reports differently) and Extra HCL can add another. Folds every
 * lifecycle block of `resource "<tfType>" "<resName>"` into the first: ignore_changes lists are
 * combined (`all` wins), every other line is kept once.
 */
export function mergeLifecycleBlocks(blocks: string, tfType: string, resName: string): string {
  const header = `resource "${tfType}" "${resName}" {`;
  const start = blocks.indexOf(header);
  if (start === -1) return blocks;
  const resource = blockAt(blocks, start + header.length - 1);
  if (!resource) return blocks;

  // Lifecycle blocks directly inside the resource (depth 1), not inside a nested block
  const found: { start: number; end: number; body: string }[] = [];
  let depth = 0;
  for (let i = resource.start; i < resource.end; i++) {
    const ch = blocks[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 1 && blocks.startsWith('lifecycle', i) && /[\s\n]/.test(blocks[i - 1] ?? '\n')) {
      const open = blocks.indexOf('{', i);
      if (!/^lifecycle\s*$/.test(blocks.slice(i, open))) continue;
      const block = blockAt(blocks, open);
      if (!block) return blocks;
      found.push({ start: i, end: block.end, body: blocks.slice(open + 1, block.end - 1) });
      i = block.end - 1;
    }
  }
  if (found.length < 2) return blocks;

  const ignored: string[] = [];
  let ignoreAll = false;
  const lines: string[] = [];
  for (const { body } of found) {
    const rest = body.replace(/ignore_changes\s*=\s*(all\b|\[([\s\S]*?)\])/g, (_m, value: string, list?: string) => {
      if (value === 'all') ignoreAll = true;
      else for (const item of (list || '').split(',').map((x) => x.trim()).filter(Boolean)) if (!ignored.includes(item)) ignored.push(item);
      return '';
    });
    for (const line of rest.split('\n').map((l) => l.trim()).filter(Boolean)) if (!lines.includes(line)) lines.push(line);
  }

  // Re-indent nested blocks (preconditions, postconditions) by their brace depth
  let level = 2;
  const indented = lines.map((line) => {
    if (line.startsWith('}')) level--;
    const out = `${'  '.repeat(level)}${line}`;
    if (line.endsWith('{')) level++;
    return out;
  });
  const merged = [
    'lifecycle {',
    ...(ignoreAll ? ['    ignore_changes = all'] : ignored.length ? [`    ignore_changes = [${ignored.join(', ')}]`] : []),
    ...indented,
    '  }',
  ].join('\n');

  let out = blocks;
  // Remove from the end so earlier offsets stay valid, then put the merged block where the first one was
  for (const block of [...found.slice(1)].reverse()) {
    const lineStart = out.lastIndexOf('\n', block.start - 1);
    out = out.slice(0, lineStart) + out.slice(block.end);
  }
  out = out.slice(0, found[0].start) + merged + out.slice(found[0].end);
  // The hand-written section may now be empty: drop its heading
  return out.replace(/\n+ {2}# Extra arguments \(hand-written\)\n*(?=\}(?:\n|$))/g, '\n');
}

/**
 * Where the Terraform is meant to run. `emulator` is what LocalCloud plans and applies locally;
 * `aws` is the export for real accounts: no emulator endpoints, S3 remote state, and real values
 * (variables or lookups) wherever the emulator build uses placeholders.
 */
export type CompileTarget = 'emulator' | 'aws';

/** Services AWS only accepts with subnets in two or more availability zones. */
const MULTI_AZ_TYPES = new Set(['aws_lb', 'aws_db_instance', 'aws_elasticache_cluster']);

/**
 * Placeholder AMI the catalog ships as a default. It exists in neither AWS nor the emulator, so both
 * builds look up the latest Amazon Linux 2023 instead (the emulator serves the same SSM parameter).
 */
const PLACEHOLDER_AMI = 'ami-0c55b159cbfafe1f0';

/** Tags that only mean something on the emulator. */
const EMULATOR_ONLY_TAGS = new Set(['EmulatorPort']);

/** Graviton instance families (t4g, m7g, c6gn, r7gd…) need the arm64 image. */
function amiArchForInstanceType(instanceType: string): 'x86_64' | 'arm64' {
  const suffix = instanceType.match(/^[a-z]+\d+([a-z-]*)\./)?.[1] || '';
  return suffix.includes('g') ? 'arm64' : 'x86_64';
}

function amiExpression(cfgAmi: unknown, instanceType: string): string {
  const ami = typeof cfgAmi === 'string' && cfgAmi.trim() ? cfgAmi.trim() : PLACEHOLDER_AMI;
  if (ami === PLACEHOLDER_AMI) {
    return `data.aws_ssm_parameter.al2023_ami_${amiArchForInstanceType(instanceType)}.insecure_value`;
  }
  return `"${ami}"`;
}

export interface CompiledTerraformBundle {
  environment: EnvironmentProfile;
  target: CompileTarget;
  mainTf: string;
  providerTf: string;
  variablesTf: string;
  tfvars: string;
  outputsTf: string;
  /** AWS export only: the S3 backend block, and its per-environment settings to fill in. Empty for the emulator. */
  backendTf: string;
  backendConfig: string;
  emulatorScriptSh: string;
  dockerfile: string;
  dockerComposeYml: string;
}

export function compileTerraformForEnvironment(
  nodes: CloudNode[],
  edges: CloudEdge[],
  envProfile: EnvironmentProfile,
  allEnvironments: Record<EnvironmentId, EnvironmentProfile>,
  target: CompileTarget = 'emulator'
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
  const providerTf = generateProviderTf(envProfile, target);

  // 3. Generate main.tf resources and wiring
  const resourceBlocks: string[] = [];

  resourceBlocks.push(`# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (${envProfile.name.toUpperCase()})
# Target Mode: ${target === 'emulator' ? `AWS Emulator (${envProfile.emulatorEndpoint})` : `AWS (${envProfile.region})`}
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

    let effectiveSubnets = connectedSubnets.length > 0 ? connectedSubnets : subnetNodes;

    // Load balancers, RDS and ElastiCache need subnets in at least two availability zones. When a node
    // sits in one subnet, add the other subnets of the same tier in its VPC.
    if (MULTI_AZ_TYPES.has(node.data.serviceType) && effectiveSubnets.length === 1) {
      const anchor = effectiveSubnets[0];
      const anchorVpc = findAncestorOfType(anchor, 'aws_vpc', nodeById);
      const tierOf = (s: CloudNode) => String(resolveNodeConfigForEnv(s, envId).tier || 'public');
      const siblings = subnetNodes.filter(
        (s) =>
          s.id !== anchor.id &&
          findAncestorOfType(s, 'aws_vpc', nodeById)?.id === anchorVpc?.id &&
          tierOf(s) === tierOf(anchor)
      );
      effectiveSubnets = [anchor, ...siblings];
    }

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
      dependsOnLine,
      target,
      {
        explicitVpc: incoming.some((e) => nodeById[e.source]?.data.serviceType === 'aws_vpc'),
        explicitSubnets: connectedSubnets,
      }
    );

    const extraHcl = typeof cfg[EXTRA_HCL_KEY] === 'string' ? cfg[EXTRA_HCL_KEY] : '';
    const mainType = mainResourceType(node, cfg);
    resourceBlocks.push(
      extraHcl.trim() ? mergeLifecycleBlocks(injectExtraHcl(block, mainType, resName, extraHcl), mainType, resName) : block
    );
  }

  // 4. Generate Cross-Resource Wiring Blocks (API Gateway Integrations, Event Source Mappings, IAM Policies, ALB Attachments)
  const wiringBlocks = renderEdgeWiringBlocks(activeEdges, nodeById, envId);
  if (wiringBlocks.length > 0) {
    resourceBlocks.push(`# ============================================================================
# Cross-Service Wiring, Permissions & Event Triggers (Canvas Edges)
# ============================================================================`);
    resourceBlocks.push(...wiringBlocks);
  }

  // Look up the current Amazon Linux 2023 image instead of a fixed AMI ID
  {
    for (const arch of ['x86_64', 'arm64'] as const) {
      const ref = `data.aws_ssm_parameter.al2023_ami_${arch}`;
      if (resourceBlocks.some((b) => b.includes(ref))) {
        resourceBlocks.splice(
          1,
          0,
          `# Latest Amazon Linux 2023 image for this region (set an AMI on the node to pin one)
data "aws_ssm_parameter" "al2023_ami_${arch}" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}"
}`
        );
      }
    }
  }

  const mainTf = resourceBlocks.join('\n\n') + '\n';

  // 2. Generate variables.tf & <env>.tfvars (after main.tf, which decides the network inputs it needs)
  const { variablesTf, tfvars } = generateVariablesAndTfvars(envProfile, allEnvironments, target, {
    vpcId: /\bvar\.vpc_id\b/.test(mainTf),
    subnetIds: /\bvar\.subnet_ids\b/.test(mainTf),
  });
  const { backendTf, backendConfig } =
    target === 'aws' ? generateS3Backend(envProfile) : { backendTf: '', backendConfig: '' };

  // 5. Generate outputs.tf
  const outputsTf = generateOutputsTf(activeNodes, envId);

  // 6. Generate AWS Emulator helper scripts & Docker Compose for every environment
  const emulatorScriptSh = generateEmulatorShellScript(envProfile, allEnvironments);
  const dockerfile = generateEmulatorDockerfile(allEnvironments);
  const dockerComposeYml = generateDockerComposeYml(allEnvironments);

  return {
    environment: envProfile,
    target,
    mainTf,
    providerTf,
    variablesTf,
    tfvars,
    outputsTf,
    backendTf,
    backendConfig,
    emulatorScriptSh,
    dockerfile,
    dockerComposeYml,
  };
}

function generateProviderTf(
  env: EnvironmentProfile,
  target: CompileTarget
): string {
  if (target === 'aws') {
    return `# ============================================================================
# AWS Provider: ${env.name} (${env.id}), ${env.region}
# Credentials come from your usual AWS setup (profile, SSO, CI role).
# Remote state is configured in backend.tf.
# ============================================================================

terraform {
  # 1.10+ for S3 native state locking (use_lockfile in backend.tfbackend)
  required_version = ">= 1.10.0"

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
  shared_credentials_files = [pathexpand("${emulatorDir()}/\${var.emulator_port}/emulator_credentials")]
  shared_config_files      = [pathexpand("${emulatorDir()}/\${var.emulator_port}/config")]
  custom_ca_bundle         = pathexpand("${emulatorDir()}/\${var.emulator_port}/ca.pem")

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

function generateS3Backend(env: EnvironmentProfile): { backendTf: string; backendConfig: string } {
  const backendTf = `# Remote state in S3. The settings live in backend.tfbackend so each environment
# can point at its own bucket or account:
#   terraform init -backend-config=backend.tfbackend
#
# Using Terraform Cloud or another backend instead? Replace this block.

terraform {
  backend "s3" {}
}
`;

  const backendConfig = `# State settings for ${env.name} (${env.id}). Fill in once; LocalCloud never overwrites this file.
# The bucket must exist before \`terraform init\` and should have versioning enabled.

bucket       = "CHANGE-ME-terraform-state"
key          = "localcloud/${env.id}/terraform.tfstate"
region       = "${env.region}"
encrypt      = true
use_lockfile = true
`;

  return { backendTf, backendConfig };
}

function generateVariablesAndTfvars(
  env: EnvironmentProfile,
  allEnvs: Record<EnvironmentId, EnvironmentProfile>,
  target: CompileTarget,
  needs: { vpcId: boolean; subnetIds: boolean }
): { variablesTf: string; tfvars: string } {
  const isAws = target === 'aws';
  const tags = Object.entries(env.defaultTags).filter(([k]) => !isAws || !EMULATOR_ONLY_TAGS.has(k));

  const emulatorVariables = isAws
    ? ''
    : `variable "emulator_port" {
  description = "Local AWS Emulator port for isolated environment state"
  type        = number
  default     = ${env.emulatorPort}
}

variable "emulator_endpoint" {
  description = "Local AWS Emulator HTTPS endpoint URL"
  type        = string
  default     = "${env.emulatorEndpoint}"
}

`;

  // Resources that need a network when the canvas has no VPC / Subnet nodes take existing ones
  const networkVariables = [
    needs.vpcId &&
      `variable "vpc_id" {
  description = "Existing VPC for resources that are not placed in a VPC on the canvas"
  type        = string
}
`,
    needs.subnetIds &&
      `variable "subnet_ids" {
  description = "Existing subnets for resources that are not placed in a subnet on the canvas"
  type        = list(string)
}
`,
  ]
    .filter(Boolean)
    .join('\n');

  const variablesTf = `variable "environment" {
  description = "Target deployment environment (${Object.keys(allEnvs).join(', ')})"
  type        = string
  default     = "${env.id}"
}

variable "aws_region" {
  description = "AWS Region for this environment"
  type        = string
  default     = "${env.region}"
}

${emulatorVariables}variable "default_tags" {
  description = "Default resource tags applied across the environment"
  type        = map(string)
  default     = {
${tags.map(([k, v]) => `    ${k} = "${v}"`).join('\n')}
  }
}
${networkVariables ? `\n${networkVariables}` : ''}`;

  const envSummaryComments = Object.values(allEnvs)
    .map((e) =>
      isAws
        ? `#   - ${e.id.padEnd(8)} : region=${e.region}`
        : `#   - ${e.id.padEnd(8)} : region=${e.region}, port=${e.emulatorPort}, endpoint=${e.emulatorEndpoint}`
    )
    .join('\n');

  const networkTfvars =
    needs.vpcId || needs.subnetIds
      ? `
# Required: some resources need a network, and the canvas has no VPC or Subnet for them in ${env.id}.
# Either place them in a VPC / Subnet on the canvas, or point them at existing ones here.
${needs.vpcId ? `vpc_id     = "CHANGE-ME"  # e.g. "vpc-0123456789abcdef0"\n` : ''}${
          needs.subnetIds ? `subnet_ids = ["CHANGE-ME"] # e.g. ["subnet-0aaa...", "subnet-0bbb..."]\n` : ''
        }`
      : '';

  const tfvars = `# ============================================================================
# Environment Variable Values: ${env.name} (${env.id}.tfvars)
# Multi-Environment Matrix:
${envSummaryComments}
# ============================================================================

${
  isAws
    ? `environment = "${env.id}"
aws_region  = "${env.region}"`
    : `environment       = "${env.id}"
aws_region        = "${env.region}"
emulator_port     = ${env.emulatorPort}
emulator_endpoint = "${env.emulatorEndpoint}"`
}

default_tags = {
${tags.map(([k, v]) => `  ${k} = "${v}"`).join('\n')}
}
${networkTfvars}`;

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
  dependsOnLine: string,
  target: CompileTarget,
  /** Placement the canvas states outright (a wire or nesting), as opposed to the fallbacks above. */
  placement: { explicitVpc: boolean; explicitSubnets: CloudNode[] } = { explicitVpc: false, explicitSubnets: [] }
): string {
  const type = node.data.serviceType;
  /** `depends_on` for this resource: what the canvas asks for plus what its own wiring needs. */
  const dependsOn = (extra: string[]) => {
    if (extra.length === 0) return dependsOnLine;
    const existing = dependsOnLine.match(/\[(.*)\]/)?.[1];
    return `\n  depends_on = [${[...(existing ? [existing] : []), ...extra].join(', ')}]`;
  };
  const isAws = target === 'aws';
  // Real subnets to place the resource in; the emulator build's placeholder IDs don't count
  const hasSubnets = effectiveSubnets.length > 0 || isAws;
  // Without a VPC / Subnet on the canvas the emulator accepts placeholder IDs; real AWS needs existing ones
  const vpcRef = connectedVpc
    ? `aws_vpc.${sanitizeIdentifier(connectedVpc.data.resourceName || connectedVpc.data.label)}.id`
    : isAws
      ? 'var.vpc_id'
      : `"vpc-default-${envId}"`;

  const subnetIdsArray =
    effectiveSubnets.length > 0
      ? `[${effectiveSubnets
          .map(
            (s) =>
              `aws_subnet.${sanitizeIdentifier(s.data.resourceName || s.data.label)}.id`
          )
          .join(', ')}]`
      : isAws
        ? 'var.subnet_ids'
        : `["subnet-default-${envId}-a", "subnet-default-${envId}-b"]`;

  const firstSubnetRef =
    effectiveSubnets.length > 0
      ? `aws_subnet.${sanitizeIdentifier(
          effectiveSubnets[0].data.resourceName || effectiveSubnets[0].data.label
        )}.id`
      : isAws
        ? 'var.subnet_ids[0]'
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

  // EC2, Auto Scaling and EKS only get a role once a connection grants them something
  const granted = hasGrants(node, outgoing, nodeById);
  const onDemandRole = granted ? `${onDemandCallerRole(node, resName)}\n\n` : '';

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
}${placement.explicitSubnets
        .map((subnet) => {
          const subnetName = sanitizeIdentifier(subnet.data.resourceName || subnet.data.label);
          return `

resource "aws_route_table_association" "${resName}_${subnetName}" {
  subnet_id      = aws_subnet.${subnetName}.id
  route_table_id = aws_route_table.${resName}.id
}`;
        })
        .join('')}`;
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

    case 'aws_lb': {
      const listenerPort = Number(cfg.listener_port ?? 80);
      const healthCheck = `health_check {
    enabled             = true
    path                = "${cfg.health_check_path || '/health'}"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }`;
      const plan = lbTargets(resName, outgoing, nodeById);
      const extraGroups = plan.groups
        .map((group) =>
          group.kind === 'instance'
            ? `

# EC2 instances and Auto Scaling groups register by instance ID
resource "aws_lb_target_group" "${group.tg}" {
  name        = ${dnsSafeName(`${resName}-inst`, 32)}
  port        = ${listenerPort}
  protocol    = "HTTP"
  vpc_id      = ${vpcRef}
  target_type = "instance"

  ${healthCheck}
}`
            : `

resource "aws_lb_target_group" "${group.tg}" {
  target_type = "lambda"

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}-${group.key}"
  })
}`
        )
        .join('');
      const rules = plan.ruled
        .map(
          (rule, i) => `

resource "aws_lb_listener_rule" "${resName}_to_${rule.key}" {
  listener_arn = aws_lb_listener.${resName}_listener.arn
  priority     = ${(i + 1) * 10}

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${rule.tg}.arn
  }

  condition {
    path_pattern {
      values = ["/${rule.key.replace(/_/g, '-')}/*"]
    }
  }
}`
        )
        .join('');

      return `resource "aws_lb" "${resName}" {
  name                       = ${dnsSafeName(resName, 32)}
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
  name        = ${dnsSafeName(`${resName}-tg`, 32)}
  port        = ${listenerPort}
  protocol    = "HTTP"
  vpc_id      = ${vpcRef}
  target_type = "ip"

  ${healthCheck}
}${extraGroups}

resource "aws_lb_listener" "${resName}_listener" {
  load_balancer_arn = aws_lb.${resName}.arn
  port              = ${listenerPort}
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${plan.defaultTg}.arn
  }
}${rules}`;
    }

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
      // One origin per connected bucket, load balancer, API or function; the first takes the default route
      const origins = cloudfrontOrigins(resName, outgoing, nodeById, envId);
      const behaviour = (originId: string) => `allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "${originId}"
    viewer_protocol_policy = "${cfg.viewer_protocol_policy || 'redirect-to-https'}"

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }`;
      const originBlocks =
        origins.length > 0
          ? origins.map((o) => `  origin {\n    ${o.body}\n  }`).join('\n\n')
          : `  origin {
    domain_name = "origin.${envId}.localcloud.internal"
    origin_id   = "${resName}-primary-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }`;
      const orderedBehaviours = origins
        .slice(1)
        .map(
          (o) => `

  ordered_cache_behavior {
    path_pattern           = "/${o.path.replace(/_/g, '-')}/*"
    ${behaviour(o.id)}
  }`
        )
        .join('');

      return `resource "aws_cloudfront_distribution" "${resName}" {
  enabled             = ${Boolean(cfg.enabled ?? true)}
  is_ipv6_enabled     = ${Boolean(cfg.is_ipv6_enabled ?? true)}
  default_root_object = "${cfg.default_root_object || 'index.html'}"
  price_class         = "${cfg.price_class || 'PriceClass_100'}"

${originBlocks}

  default_cache_behavior {
    ${behaviour(`${resName}-primary-origin`)}
  }${orderedBehaviours}

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
  cfg.private_zone || placement.explicitVpc
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

    case 'aws_instance': {
      const designedType = String(cfg.instance_type || 't3.micro');
      const runType = isAws ? designedType : emulatorInstanceType(designedType);
      const typeNote =
        runType !== designedType
          ? `  ${adjustmentComment('aws_instance', `${designedType} runs as ${runType}, since the emulator can't read burstable instances' CPU credits`)}\n`
          : '';
      return `${onDemandRole}resource "aws_instance" "${resName}" {
  ami                         = ${amiExpression(cfg.ami, designedType)}
${typeNote}  instance_type               = "${runType}"${
    granted ? `\n  iam_instance_profile        = aws_iam_instance_profile.${resName}_profile.name` : ''
  }
  subnet_id                   = ${firstSubnetRef}${
    // Same zone as the subnet. Redundant on AWS, but the emulator rejects the empty zone the provider sends otherwise
    effectiveSubnets.length > 0
      ? `\n  availability_zone           = aws_subnet.${sanitizeIdentifier(effectiveSubnets[0].data.resourceName || effectiveSubnets[0].data.label)}.availability_zone`
      : ''
  }
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
  })${
    // The emulator keeps an 8 GB unencrypted root volume whatever was asked, and `encrypted`
    // forces replacement: without this every plan after an apply would replace the instance
    isAws
      ? ''
      : `\n\n  # Emulator only: it ignores root volume settings. The AWS export keeps your size, type and encryption.\n  lifecycle {\n    ignore_changes = [root_block_device]\n  }`
  }${dependsOnLine}
}`;
    }

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

      // Where each connected resource is: <TARGET>_TABLE_NAME, <TARGET>_QUEUE_URL, …
      Object.assign(parsedEnvVars, connectionEnvVars(node, incoming, outgoing, nodeById, envId));

      // Claude through Amazon Bedrock's Messages API (bedrock-mantle): the model ID for the code, and the permission
      const claudeModelId = typeof cfg.claude_model_id === 'string' ? cfg.claude_model_id.trim() : '';
      if (claudeModelId) parsedEnvVars.CLAUDE_MODEL_ID = claudeModelId;

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

# Lets the function write its logs to CloudWatch
resource "aws_iam_role_policy_attachment" "${resName}_logs" {
  role       = aws_iam_role.${resName}_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
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
}${
        claudeModelId
          ? `

# Lets the function call Claude through Amazon Bedrock's Messages API (bedrock-mantle endpoint)
resource "aws_iam_role_policy" "${resName}_claude" {
  name = "claude-bedrock"
  role = aws_iam_role.${resName}_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-mantle:CreateInference"]
      Resource = "*"
    }]
  })
}`
          : ''
      }`;
    }

    case 'aws_autoscaling_group':
      return `${onDemandRole}resource "aws_launch_template" "${resName}_lt" {
  name_prefix   = "\${local.name_prefix}-${resName}-"
  image_id      = ${amiExpression(undefined, cfg.instance_type || 't3.medium')}
  instance_type = "${cfg.instance_type || 't3.medium'}"${
    effectiveSgs.length > 0 ? `\n  vpc_security_group_ids = ${sgIdsArray}` : ''
  }${
    granted
      ? `

  iam_instance_profile {
    name = aws_iam_instance_profile.${resName}_profile.name
  }`
      : ''
  }
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

    case 'aws_ecs_service': {
      const wiredIn = incoming.filter(isWired).map((e) => nodeById[e.source]).filter(Boolean);
      const nameOf = (n: CloudNode) => sanitizeIdentifier(n.data.resourceName || n.data.label);
      // An image repository on the canvas is where the image comes from
      const repo = wiredIn.find((n) => n.data.serviceType === 'aws_ecr_repository');
      const image = repo
        ? `\${aws_ecr_repository.${nameOf(repo)}.repository_url}:latest`
        : cfg.container_image || 'public.ecr.aws/nginx/nginx:stable-alpine';
      const containerEnv = Object.entries(connectionEnvVars(node, incoming, outgoing, nodeById, envId))
        // A template that is only one interpolation keeps its type in HCL (a port is a number), and
        // ECS rejects anything but strings here
        .map(([key, value]) => {
          const single = value.match(/^\$\{([\s\S]*)\}$/);
          const expr = single && !single[1].includes('${') ? `tostring(${single[1]})` : `"${value}"`;
          return `,\n        { name = "${key}", value = ${expr} }`;
        })
        .join('');
      // A connected log group receives the container's output
      const logGroup = outgoing
        .filter(isWired)
        .map((e) => nodeById[e.target])
        .find((n) => n?.data.serviceType === 'aws_cloudwatch_log_group');
      const logConfiguration = logGroup
        ? `
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.${nameOf(logGroup)}.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "${resName}"
        }
      }`
        : '';
      // Load balancers in front of the service: tasks register in their IP target group
      const loadBalancers = wiredIn.filter((n) => n.data.serviceType === 'aws_lb').map(nameOf);
      const loadBalancerBlocks = loadBalancers
        .map(
          (lb) => `

  load_balancer {
    target_group_arn = aws_lb_target_group.${lb}_tg.arn
    container_name   = "${resName}"
    container_port   = ${Number(cfg.container_port ?? 80)}
  }`
        )
        .join('');

      return `resource "aws_ecs_cluster" "${resName}_cluster" {
  name = "\${local.name_prefix}-${resName}-cluster"

  setting {
    name  = "containerInsights"
    value = "${envId === 'prod' || envId === 'staging' ? 'enabled' : 'disabled'}"
  }

  tags = local.common_tags
}

# Execution role: lets ECS pull the image and write logs
resource "aws_iam_role" "${resName}_exec_role" {
  name = "\${local.name_prefix}-${resName}-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "${resName}_exec_role" {
  role       = aws_iam_role.${resName}_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: what the containers themselves may call
resource "aws_iam_role" "${resName}_task_role" {
  name = "\${local.name_prefix}-${resName}-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}
${
  Boolean(cfg.enable_execute_command ?? true)
    ? `
# ECS Exec needs the task to open SSM sessions
resource "aws_iam_role_policy" "${resName}_task_exec_command" {
  name = "ecs-exec"
  role = aws_iam_role.${resName}_task_role.id

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
`
    : ''
}
resource "aws_ecs_task_definition" "${resName}_task" {
  family                   = "\${local.name_prefix}-${resName}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "${cfg.cpu || '256'}"
  memory                   = "${cfg.memory || '512'}"
  execution_role_arn       = aws_iam_role.${resName}_exec_role.arn
  task_role_arn            = aws_iam_role.${resName}_task_role.arn

  container_definitions = jsonencode([
    {
      name      = "${resName}"
      image     = "${image}"
      essential = true
      portMappings = [
        {
          containerPort = ${Number(cfg.container_port ?? 80)}
          hostPort      = ${Number(cfg.container_port ?? 80)}
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "ENVIRONMENT", value = var.environment }${containerEnv}
      ]${logConfiguration}
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
  }${loadBalancerBlocks}

  tags = local.common_tags${dependsOn(loadBalancers.map((lb) => `aws_lb_listener.${lb}_listener`))}
}`;
    }

    case 'aws_eks_cluster':
      return `${onDemandRole}resource "aws_iam_role" "${resName}_eks_role" {
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
    subnet_ids              = ${subnetIdsArray}${
      effectiveSgs.length > 0 ? `\n    security_group_ids      = ${sgIdsArray}` : ''
    }
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
  bucket        = ${dnsSafeName(String(cfg.bucket_prefix || resName), 63)}
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
      // A Lambda wired to the table reads its stream, so the stream has to exist
      const streamConsumed = outgoing.some(
        (e) => isWired(e) && nodeById[e.target]?.data.serviceType === 'aws_lambda_function'
      );
      return `resource "aws_dynamodb_table" "${resName}" {
  name             = "\${local.name_prefix}-${resName}"
  billing_mode     = "${cfg.billing_mode || 'PAY_PER_REQUEST'}"
  hash_key         = "${cfg.hash_key || 'pk'}"
${hasRangeKey ? `  range_key        = "${cfg.range_key}"\n` : ''}${
        isProv
          ? `  read_capacity    = ${Number(cfg.read_capacity ?? 5)}\n  write_capacity   = ${Number(cfg.write_capacity ?? 5)}\n`
          : ''
      }  stream_enabled   = ${Boolean(cfg.stream_enabled ?? true) || streamConsumed}
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
      // Without a subnet group RDS lands in the account's default VPC, away from its security groups
      return `${
        hasSubnets
          ? `resource "aws_db_subnet_group" "${resName}_subnets" {
  name       = ${dnsSafeName(`${resName}-subnets`, 255)}
  subnet_ids = ${subnetIdsArray}

  tags = local.common_tags
}

`
          : ''
      }resource "aws_db_instance" "${resName}" {
  identifier              = ${dnsSafeName(resName, 63)}
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
  skip_final_snapshot     = ${Boolean(cfg.skip_final_snapshot ?? true)}${
    // Keeping a final snapshot needs a name for it, or destroy can never succeed
    Boolean(cfg.skip_final_snapshot ?? true) ? '' : `\n  final_snapshot_identifier = ${dnsSafeName(`${resName}-final`, 255)}`
  }
  vpc_security_group_ids  = ${sgIdsArray}${hasSubnets ? `\n  db_subnet_group_name    = aws_db_subnet_group.${resName}_subnets.name` : ''}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${dependsOnLine}
}`;

    case 'aws_elasticache_cluster': {
      const subnetGroup = hasSubnets
        ? `resource "aws_elasticache_subnet_group" "${resName}_subnets" {
  name       = ${dnsSafeName(`${resName}-subnets`, 255)}
  subnet_ids = ${subnetIdsArray}
}

`
        : '';
      // The emulator runs a real Redis on a port of its own and reports that one back; without this,
      // every plan after an apply would replace the cache (port forces replacement)
      const portDrift = isAws
        ? ''
        : `\n\n  # Emulator only: it serves the cache on a port of its own choosing (https://github.com/aws/aws-emulator/issues/471). The AWS export keeps the designed port.\n  lifecycle {\n    ignore_changes = [port]\n  }`;
      const cachePlacement = hasSubnets
        ? `\n  subnet_group_name    = aws_elasticache_subnet_group.${resName}_subnets.name\n  security_group_ids   = ${sgIdsArray}`
        : effectiveSgs.length > 0
          ? `\n  security_group_ids   = ${sgIdsArray}`
          : '';

      if (isRedisReplicationGroup(type, cfg)) {
        const nodes = Number(cfg.num_cache_nodes);
        return `${subnetGroup}# Redis with more than one node: a primary plus replicas with automatic failover
resource "aws_elasticache_replication_group" "${resName}" {
  replication_group_id       = ${dnsSafeName(resName, 40)}
  description                = "${resName} (${nodes} nodes)"
  engine                     = "redis"
  node_type                  = "${cfg.node_type || 'cache.t4g.micro'}"
  num_cache_clusters         = ${nodes}
  port                       = ${Number(cfg.port ?? 6379)}
  automatic_failover_enabled = true
  multi_az_enabled           = true${cachePlacement}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${portDrift}${dependsOnLine}
}`;
      }

      return `${subnetGroup}resource "aws_elasticache_cluster" "${resName}" {
  cluster_id           = ${dnsSafeName(resName, 50)}
  engine               = "${cfg.engine || 'redis'}"
  node_type            = "${cfg.node_type || 'cache.t4g.micro'}"
  num_cache_nodes      = ${Number(cfg.num_cache_nodes ?? 1)}
  port                 = ${Number(cfg.port ?? 6379)}${cachePlacement}

  tags = merge(local.common_tags, {
    Name = "\${local.name_prefix}-${resName}"
  })${portDrift}${dependsOnLine}
}`;
    }

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

  definition = jsonencode(${sfnDefinition(outgoing, nodeById, envId)})

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

    case 'aws_cognito_user_pool': {
      const triggers = cognitoTriggers(outgoing, nodeById);
      const lambdaConfig = triggers.length
        ? `
  lambda_config {
${triggers.map((t) => `    ${t.trigger} = aws_lambda_function.${t.fn}.arn`).join('\n')}
  }
`
        : '';
      // An API that authorizes with this pool needs a client for its tokens' audience
      const needsClient =
        Boolean(cfg.create_app_client) ||
        outgoing.some((e) => isWired(e) && nodeById[e.target]?.data.serviceType === 'aws_apigatewayv2_api');
      return `resource "aws_cognito_user_pool" "${resName}" {
  name                     = "\${local.name_prefix}-${resName}"
  mfa_configuration        = "${cfg.mfa_configuration || 'OFF'}"
  auto_verified_attributes = ${cfg.auto_verified_attributes ? '["email"]' : '[]'}
${lambdaConfig}${
  // OPTIONAL or ON needs an MFA method; authenticator apps need no SMS setup
  (cfg.mfa_configuration || 'OFF') !== 'OFF'
    ? `
  software_token_mfa_configuration {
    enabled = true
  }
`
    : ''
}
  password_policy {
    minimum_length    = ${Number(cfg.password_minimum_length ?? 8)}
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  tags = local.common_tags${dependsOnLine}
}${
        needsClient
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
    }

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

    case 'aws_kinesis_stream': {
      const designedRetention = Number(cfg.retention_period ?? 24);
      const kinesisRetention = isAws ? designedRetention : emulatorKinesisRetention(designedRetention);
      const retentionNote =
        kinesisRetention !== designedRetention
          ? `  ${adjustmentComment('aws_kinesis_stream', `${designedRetention} hours of retention runs as ${kinesisRetention}, since the emulator rejects 24`)}\n`
          : '';
      return `resource "aws_kinesis_stream" "${resName}" {
  name             = "\${local.name_prefix}-${resName}"
${retentionNote}  retention_period = ${kinesisRetention}
${
  cfg.stream_mode === 'PROVISIONED'
    ? `  shard_count      = ${Number(cfg.shard_count ?? 1)}`
    : ''
}
  stream_mode_details {
    stream_mode = "${cfg.stream_mode || 'ON_DEMAND'}"
  }

  tags = local.common_tags${dependsOnLine}
}`;
    }

    case 'aws_opensearch_domain':
      return `resource "aws_opensearch_domain" "${resName}" {
  domain_name    = ${dnsSafeName(resName, 28)}
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

function generateOutputsTf(activeNodes: CloudNode[], envId: EnvironmentId): string {
  const lines: string[] = [
    `# ============================================================================
# Compiled Terraform Outputs
# ============================================================================`,
  ];

  for (const node of activeNodes) {
    const svc = SERVICE_BY_TYPE[node.data.serviceType];
    if (!svc || !svc.outputs.length) continue;
    const resName = sanitizeIdentifier(node.data.resourceName || node.data.label);
    const outputs =
      mainResourceType(node, resolveNodeConfigForEnv(node, envId)) === 'aws_elasticache_replication_group'
        ? [{ name: 'primary_endpoint', tfExpression: (r: string) => `aws_elasticache_replication_group.${r}.primary_endpoint_address`, description: 'Redis primary endpoint' }]
        : svc.outputs;
    for (const out of outputs) {
      lines.push(`output "${resName}_${out.name}" {
  description = "${out.description} (${node.data.label})"
  value       = ${out.tfExpression(resName)}
}`);
    }
  }

  return lines.join('\n\n') + '\n';
}

function generateEmulatorDockerfile(allEnvs: Record<EnvironmentId, EnvironmentProfile>): string {
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
EXPOSE ${Object.values(allEnvs).map((e) => e.emulatorPort).join(' ')}
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
# Multi-Environment AWS Emulator Cluster (${Object.keys(allEnvs).join(', ')})
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
