import type { CloudNode, CloudEdge } from '../types/cloud';
import { SERVICE_BY_TYPE, getDefaultConfigForService } from '../data/awsCatalog';

/**
 * Parses Terraform HCL (`resource "<type>" "<name>" { ... }`) and reconstructs
 * a 2D node graph and inferred dependency/wiring edges for LocalCloud Studio.
 */
export function parseTerraformHclToCanvas(hclText: string): {
  nodes: CloudNode[];
  edges: CloudEdge[];
  importedCount: number;
} {
  const nodes: CloudNode[] = [];
  const edges: CloudEdge[] = [];

  // Match top-level resource blocks: resource "aws_..." "name" { ... }
  const resourceRegex = /resource\s+"([a-zA-Z0-9_]+)"\s+"([a-zA-Z0-9_-]+)"\s*\{/g;
  const blocks: {
    tfType: string;
    tfName: string;
    body: string;
  }[] = [];

  let match: RegExpExecArray | null;
  while ((match = resourceRegex.exec(hclText)) !== null) {
    const tfType = match[1];
    const tfName = match[2];
    const startIdx = match.index + match[0].length;

    // Find matching closing brace
    let depth = 1;
    let i = startIdx;
    while (i < hclText.length && depth > 0) {
      if (hclText[i] === '{') depth++;
      else if (hclText[i] === '}') depth--;
      i++;
    }
    const body = hclText.slice(startIdx, i - 1);
    blocks.push({ tfType, tfName, body });
  }

  // Map secondary companion resources to their primary service type
  const primaryBlocks = blocks.filter((b) => Boolean(SERVICE_BY_TYPE[b.tfType]));
  const nodeByTfAddress: Record<string, CloudNode> = {};

  primaryBlocks.forEach((b, idx) => {
    const svc = SERVICE_BY_TYPE[b.tfType];
    if (!svc) return;

    const baseConfig = getDefaultConfigForService(b.tfType);

    // Extract simple key = value pairs from body
    for (const field of svc.schema) {
      const keyRegex = new RegExp(`\\b${field.key}\\s*=\\s*([^\\n#]+)`, 'm');
      const m = keyRegex.exec(b.body);
      if (m) {
        const raw = m[1].trim();
        if (field.type === 'boolean') {
          baseConfig[field.key] = raw === 'true';
        } else if (field.type === 'number') {
          const num = parseFloat(raw.replace(/[^0-9.-]/g, ''));
          if (!isNaN(num)) baseConfig[field.key] = num;
        } else {
          // Strip surrounding quotes if present
          const cleaned = raw.replace(/^"(.*)"$/, '$1');
          if (!cleaned.includes('${') && !cleaned.startsWith('aws_')) {
            baseConfig[field.key] = cleaned;
          }
        }
      }
    }

    const col = idx % 4;
    const row = Math.floor(idx / 4);
    const nodeId = `node-import-${b.tfName}-${idx}`;

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
        tags: {
          ImportedFrom: 'TerraformHCL',
        },
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

  return {
    nodes,
    edges: edges.filter((e) => !nestedEdgeIds.has(e.id)),
    importedCount: nodes.length,
  };
}
