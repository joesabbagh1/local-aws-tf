import type { CloudNode, CloudEdge, EnvironmentId } from '../types/cloud';
import { DEFAULT_ENVIRONMENTS, SERVICE_BY_TYPE, getDefaultConfigForService } from '../data/awsCatalog';
import { compileTerraformForEnvironment, EXTRA_HCL_KEY, sanitizeIdentifier } from './terraformCompiler';
import { parseHclLiteral, parseHclStringMap, splitHclBody } from './hclBody';

export interface HclImportResult {
  nodes: CloudNode[];
  edges: CloudEdge[];
  importedCount: number;
  /** Arguments kept as each node's Extra HCL. */
  extraArgCount: number;
  /** Resources with no canvas service (helpers like aws_s3_bucket_versioning, or unsupported types). */
  skippedResources: string[];
  /** Arguments that could not be kept, and why. */
  dropped: { address: string; key: string; reason: string }[];
  /** Extra HCL that points at things the canvas won't define. */
  warnings: string[];
}

// Meta-arguments the canvas has no model for; carrying them over would break references to the resource
const UNSUPPORTED_META = new Set(['count', 'for_each', 'provider']);
// Computed by AWS, never set
const IGNORED_ARGS = new Set(['tags_all', 'id', 'arn']);

const ALL_ENVS: Record<EnvironmentId, boolean> = { dev: true, testing: true, staging: true, prod: true };

/** Top-level argument and block names the compiler writes into this node's main resource block. */
function compilerOwnedKeys(node: CloudNode): Set<string> {
  const svc = SERVICE_BY_TYPE[node.data.serviceType];
  const resName = sanitizeIdentifier(node.data.resourceName);
  const { mainTf } = compileTerraformForEnvironment([node], [], DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS);
  const header = `resource "${svc.terraformResourceType}" "${resName}" {`;
  const start = mainTf.indexOf(header);
  if (start === -1) return new Set();
  const block = splitHclBody(mainTf.slice(start)).find((item) => item.key === 'resource');
  const body = block ? block.text.slice(block.text.indexOf('{') + 1, block.text.lastIndexOf('}')) : '';
  return new Set(splitHclBody(body).map((item) => item.key));
}

/**
 * Parses Terraform HCL (`resource "<type>" "<name>" { ... }`) and reconstructs
 * a 2D node graph and inferred dependency/wiring edges for LocalCloud Studio.
 * Arguments the form models become fields; the rest are kept as the node's Extra HCL.
 */
export function parseTerraformHclToCanvas(hclText: string): HclImportResult {
  const nodes: CloudNode[] = [];
  const edges: CloudEdge[] = [];
  const dropped: HclImportResult['dropped'] = [];
  const warnings: string[] = [];
  let extraArgCount = 0;

  // Top-level resource blocks: resource "aws_..." "name" { ... }
  const blocks: { tfType: string; tfName: string; body: string }[] = [];
  for (const item of splitHclBody(hclText)) {
    if (item.key !== 'resource' || item.kind !== 'block') continue;
    const header = /^resource\s+"([a-zA-Z0-9_]+)"\s+"([a-zA-Z0-9_-]+)"\s*\{/.exec(item.text);
    if (!header) continue;
    blocks.push({
      tfType: header[1],
      tfName: header[2],
      body: item.text.slice(header[0].length, item.text.lastIndexOf('}')),
    });
  }

  // Map secondary companion resources to their primary service type
  const primaryBlocks = blocks.filter((b) => Boolean(SERVICE_BY_TYPE[b.tfType]));
  const nodeByTfAddress: Record<string, CloudNode> = {};

  // Imported names may not be valid canvas identifiers; references in Extra HCL follow the rename
  const renames = new Map<string, string>();
  for (const b of primaryBlocks) {
    const svc = SERVICE_BY_TYPE[b.tfType];
    const sanitized = sanitizeIdentifier(b.tfName);
    if (svc && sanitized !== b.tfName) renames.set(`${svc.terraformResourceType}.${b.tfName}`, `${svc.terraformResourceType}.${sanitized}`);
  }

  primaryBlocks.forEach((b, idx) => {
    const svc = SERVICE_BY_TYPE[b.tfType];
    if (!svc) return;
    const address = `${b.tfType}.${b.tfName}`;

    const baseConfig = getDefaultConfigForService(b.tfType);
    const fieldsByKey = new Map(svc.schema.map((f) => [f.key, f]));
    const items = splitHclBody(b.body);
    let tags: Record<string, string> = {};

    // 1. Literal values for fields the form models
    const mapped = new Set<string>();
    for (const item of items) {
      const field = item.kind === 'attribute' ? fieldsByKey.get(item.key) : undefined;
      if (!field) continue;
      const literal = parseHclLiteral(item.value || '');
      if (literal === undefined) continue;
      if (field.type === 'number' && typeof literal === 'number') baseConfig[field.key] = literal;
      else if (field.type === 'boolean' && typeof literal === 'boolean') baseConfig[field.key] = literal;
      else if (field.type !== 'number' && field.type !== 'boolean') baseConfig[field.key] = String(literal);
      else continue;
      mapped.add(item.key);
    }

    const nodeId = `node-import-${b.tfName}-${idx}`;
    const probe: CloudNode = {
      id: nodeId,
      type: 'awsNode',
      position: { x: 0, y: 0 },
      data: { label: b.tfName, resourceName: b.tfName, serviceType: b.tfType, baseConfig, envOverrides: {}, envEnabled: ALL_ENVS, tags: {} },
    };
    const owned = compilerOwnedKeys(probe);

    // 2. Everything else: kept as Extra HCL unless the compiler writes it too (Terraform rejects duplicates)
    const extra: string[] = [];
    for (const item of items) {
      if (mapped.has(item.key) || IGNORED_ARGS.has(item.key)) continue;
      if (item.key === 'tags' && item.kind === 'attribute') {
        const parsed = parseHclStringMap(item.value || '');
        if (parsed) tags = parsed;
        else dropped.push({ address, key: 'tags', reason: 'not a plain map of strings' });
        continue;
      }
      if (UNSUPPORTED_META.has(item.key)) {
        dropped.push({ address, key: item.key, reason: 'not supported on the canvas' });
        continue;
      }
      if (owned.has(item.key)) {
        dropped.push({
          address,
          key: item.key,
          reason: fieldsByKey.has(item.key) ? 'not a literal value the form can hold' : 'generated by LocalCloud',
        });
        continue;
      }
      let text = item.text;
      for (const [from, to] of renames) text = text.replace(new RegExp(`\\b${from.replace('.', '\\.')}\\b`, 'g'), to);
      extra.push(text);
    }
    if (extra.length > 0) {
      baseConfig[EXTRA_HCL_KEY] = extra.join('\n');
      extraArgCount += extra.length;
    }

    const col = idx % 4;
    const row = Math.floor(idx / 4);

    const label = b.tfName
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const newNode: CloudNode = {
      id: nodeId,
      type: 'awsNode',
      position: {
        x: 80 + col * 330,
        y: 80 + row * 210,
      },
      data: {
        label: `${svc.shortName}: ${label}`,
        resourceName: b.tfName,
        serviceType: b.tfType,
        baseConfig,
        envOverrides: {},
        envEnabled: {
          dev: true,
          testing: true,
          staging: true,
          prod: true,
        },
        tags: { ...tags, ImportedFrom: 'TerraformHCL' },
      },
    };

    nodes.push(newNode);
    nodeByTfAddress[`${b.tfType}.${b.tfName}`] = newNode;
  });

  // Second pass: scan bodies of all blocks (including integrations & event source mappings) for references to `aws_<type>.<name>`
  const refRegex = /\b(aws_[a-z0-9_]+)\.([a-zA-Z0-9_-]+)\b/g;
  const edgeSet = new Set<string>();

  for (const b of blocks) {
    const ownerNode = nodeByTfAddress[`${b.tfType}.${b.tfName}`];

    // Special case: aws_lambda_event_source_mapping or aws_apigatewayv2_integration
    if (!ownerNode) {
      const refsInHelper: CloudNode[] = [];
      let rm: RegExpExecArray | null;
      while ((rm = refRegex.exec(b.body)) !== null) {
        const targetAddr = `${rm[1]}.${rm[2]}`;
        if (nodeByTfAddress[targetAddr] && !refsInHelper.includes(nodeByTfAddress[targetAddr])) {
          refsInHelper.push(nodeByTfAddress[targetAddr]);
        }
      }
      if (refsInHelper.length >= 2) {
        const src = refsInHelper[0];
        const dst = refsInHelper[1];
        const key = `${src.id}->${dst.id}`;
        if (!edgeSet.has(key) && src.id !== dst.id) {
          edgeSet.add(key);
          edges.push({
            id: `edge-import-${src.id}-${dst.id}`,
            source: src.id,
            target: dst.id,
            animated: true,
            data: {
              relationshipType: 'event_trigger',
              label: 'Trigger / Integration',
            },
          });
        }
      }
      continue;
    }

    let rm: RegExpExecArray | null;
    while ((rm = refRegex.exec(b.body)) !== null) {
      const refAddr = `${rm[1]}.${rm[2]}`;
      const refNode = nodeByTfAddress[refAddr];
      if (refNode && refNode.id !== ownerNode.id) {
        // Direction: if refNode is VPC/Subnet/SG, wire refNode -> ownerNode
        const isNet = ['aws_vpc', 'aws_subnet', 'aws_security_group'].includes(
          refNode.data.serviceType
        );
        const sourceId = isNet ? refNode.id : ownerNode.id;
        const targetId = isNet ? ownerNode.id : refNode.id;
        const key = `${sourceId}->${targetId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({
            id: `edge-import-${sourceId}-${targetId}`,
            source: sourceId,
            target: targetId,
            animated: !isNet,
            data: {
              relationshipType: isNet ? 'network_attachment' : 'data_flow',
              label: isNet ? 'VPC Network' : 'Reference',
            },
          });
        }
      }
    }
  }

  // Turn VPC / Subnet references into canvas nesting instead of network edges
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const networkEdgesInto = (targetId: string, sourceType: string) =>
    edges.filter(
      (e) =>
        e.target === targetId &&
        e.data?.relationshipType === 'network_attachment' &&
        nodeById[e.source]?.data.serviceType === sourceType
    );
  const nestedEdgeIds = new Set<string>();

  for (const node of nodes) {
    const type = node.data.serviceType;
    if (type === 'aws_vpc') continue;
    const subnetEdges = type === 'aws_subnet' ? [] : networkEdgesInto(node.id, 'aws_subnet');
    const vpcEdges = networkEdgesInto(node.id, 'aws_vpc');
    // Resources spanning several subnets stay wired so every subnet still compiles in
    const parentEdge = subnetEdges.length === 1 ? subnetEdges[0] : subnetEdges.length === 0 ? vpcEdges[0] : undefined;
    if (!parentEdge) continue;
    node.parentId = parentEdge.source;
    nestedEdgeIds.add(parentEdge.id);
    // The VPC is implied by the subnet's own nesting
    if (subnetEdges.length === 1) vpcEdges.forEach((e) => nestedEdgeIds.add(e.id));
  }

  // Extra HCL can only point at what the canvas will compile
  const onCanvas = new Set(
    nodes.map((n) => `${SERVICE_BY_TYPE[n.data.serviceType].terraformResourceType}.${sanitizeIdentifier(n.data.resourceName)}`)
  );
  for (const node of nodes) {
    const extra = String(node.data.baseConfig[EXTRA_HCL_KEY] || '');
    const missing = new Set<string>();
    for (const m of extra.matchAll(/\b(aws_[a-z0-9_]+\.[A-Za-z0-9_-]+|var\.\w+|local\.\w+|module\.\w+|data\.\w+\.\w+)/g)) {
      if (!onCanvas.has(m[1])) missing.add(m[1]);
    }
    if (missing.size > 0) {
      warnings.push(`${node.data.resourceName}: Extra HCL refers to ${[...missing].join(', ')}, which the canvas doesn't define`);
    }
  }

  const primaryAddresses = new Set(primaryBlocks.map((b) => `${b.tfType}.${b.tfName}`));
  return {
    nodes,
    edges: edges.filter((e) => !nestedEdgeIds.has(e.id)),
    importedCount: nodes.length,
    extraArgCount,
    skippedResources: blocks.map((b) => `${b.tfType}.${b.tfName}`).filter((a) => !primaryAddresses.has(a)),
    dropped,
    warnings,
  };
}
