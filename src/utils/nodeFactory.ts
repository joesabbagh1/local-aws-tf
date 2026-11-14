import type { CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE, getDefaultConfigForService } from '../data/awsCatalog';
import { findDropContainer, normalizeNodes, reparentNode } from './canvasLayout';

/** Catalog short name as a lowercase identifier slug, e.g. "Lambda Fn" → "lambda_fn". */
export function serviceSlug(shortName: string): string {
  return shortName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
}

/** A fresh Lambda body seeded for new aws_lambda_function nodes. */
export function defaultLambdaInlineCode(resourceName: string): string {
  return `export const handler = async (event) => {\n  console.log("Event received on AWS Emulator:", JSON.stringify(event));\n  return {\n    statusCode: 200,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({\n      ok: true,\n      service: "${resourceName}",\n      environment: process.env.ENVIRONMENT || "dev",\n      timestamp: new Date().toISOString(),\n    }),\n  };\n};\n`;
}

export interface CreatedServiceNode {
  node: CloudNode;
  /**
   * The node list with the new node appended: normalized, and when a drop position was given,
   * nested inside the VPC / Subnet container under that position (the compiler reads nesting as
   * vpc_id / subnet_ids).
   */
  nodes: CloudNode[];
}

/**
 * Build a node for a catalog service exactly as dropping it on the canvas would: id, label and
 * resource name numbered per existing use, catalog default config, container sizing, seeded
 * Lambda code. Pure — the caller decides what to do with `nodes`.
 */
export function createServiceNode(
  serviceType: string,
  existingNodes: CloudNode[],
  position?: { x: number; y: number }
): CreatedServiceNode | null {
  const svc = SERVICE_BY_TYPE[serviceType];
  if (!svc) return null;

  const indexSuffix = existingNodes.filter((n) => n.data.serviceType === serviceType).length + 1;
  const cleanShort = serviceSlug(svc.shortName);

  const newId = `node-${cleanShort}-${Date.now().toString(36)}`;
  const defaultPos = position || {
    x: 240 + ((existingNodes.length * 45) % 450),
    y: 120 + ((existingNodes.length * 40) % 340),
  };

  const newNode: CloudNode = {
    id: newId,
    type: svc.isContainer ? 'awsContainer' : 'awsNode',
    position: defaultPos,
    ...(svc.isContainer ? { width: svc.defaultWidth ?? 420, height: svc.defaultHeight ?? 280 } : {}),
    data: {
      label: `${svc.shortName} ${indexSuffix}`,
      resourceName: `${cleanShort}_${indexSuffix}`,
      serviceType,
      baseConfig: getDefaultConfigForService(serviceType),
      envOverrides: {},
      envEnabled: {
        dev: true,
        testing: true,
        staging: true,
        prod: true,
      },
      tags: {
        Service: svc.serviceCode,
      },
      inlineCode:
        serviceType === 'aws_lambda_function' ? defaultLambdaInlineCode(`${cleanShort}_${indexSuffix}`) : undefined,
    },
  };

  // Dropping onto a VPC / Subnet places the new resource inside it
  let nodes = normalizeNodes([...existingNodes, newNode]);
  const container = position ? findDropContainer(newNode, nodes) : undefined;
  if (container) nodes = reparentNode(nodes, newId, container.id);

  return { node: nodes.find((n) => n.id === newId) ?? newNode, nodes };
}
