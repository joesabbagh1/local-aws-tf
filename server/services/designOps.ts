import { ARCHITECTURE_TEMPLATES } from '../../src/data/templates';
import { SERVICE_BY_TYPE } from '../../src/data/awsCatalog';
import type { CloudEdge, CloudNode, EnvironmentId } from '../../src/types/cloud';
import { EXTRA_HCL_KEY } from '../../src/utils/terraformCompiler';
import { checkConnection } from '../../src/utils/connectionRules';
import { createServiceNode } from '../../src/utils/nodeFactory';
import { normalizeNodes, releaseChildren, reparentNode } from '../../src/utils/canvasLayout';
import { parseTerraformHclToCanvas } from '../../src/utils/hclImporter';
import { runArchitectureLinter } from '../../src/utils/architectureValidator';
import type { ProjectFile } from '../../src/utils/projectFile';

/**
 * Headless design mutations, one op = one function over the design document. The ops route loads
 * the head version, applies one of these, and saves atomically — so the MCP server, like the UI,
 * can only produce designs the canvas rules allow (invalid connections and unknown fields are
 * refused with the reason).
 */

export type DesignOpResult =
  | { ok: true; doc: ProjectFile; result: Record<string, unknown> }
  | { ok: false; error: string; status?: number };

const ENV_IDS = ['dev', 'testing', 'staging', 'prod'] as const;

function nodesOf(doc: ProjectFile): CloudNode[] {
  return doc.nodes as CloudNode[];
}

function edgesOf(doc: ProjectFile): CloudEdge[] {
  return doc.edges as CloudEdge[];
}

function withParts(doc: ProjectFile, nodes: CloudNode[], edges?: CloudEdge[]): ProjectFile {
  return { ...doc, nodes, edges: edges ?? edgesOf(doc) };
}

function findNode(doc: ProjectFile, id: string): CloudNode | null {
  return nodesOf(doc).find((n) => n.id === id) ?? null;
}

function parseEnv(value: unknown): EnvironmentId | null {
  return typeof value === 'string' && (ENV_IDS as readonly string[]).includes(value) ? (value as EnvironmentId) : null;
}

/** Field keys a service accepts, for refusing unknown keys with something actionable. */
function fieldKeys(serviceType: string): string[] {
  const svc = SERVICE_BY_TYPE[serviceType];
  return [...(svc?.schema.map((f) => f.key) ?? []), EXTRA_HCL_KEY, 'notes'];
}

function checkFields(serviceType: string, fields: Record<string, unknown>): string | null {
  const known = new Set(fieldKeys(serviceType));
  const unknown = Object.keys(fields).filter((k) => !known.has(k));
  if (unknown.length) {
    return `Unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} for ${serviceType}. Valid fields: ${[...known].join(', ')}`;
  }
  return null;
}

const nowId = () => Date.now().toString(36);

export type DesignOpArgs = Record<string, unknown>;

export function applyDesignOp(op: string, doc: ProjectFile, args: DesignOpArgs): DesignOpResult {
  const requireString = (key: string): string | null => {
    const v = args[key];
    return typeof v === 'string' && v.trim() ? v : null;
  };

  switch (op) {
    case 'resource.add': {
      const serviceType = requireString('type');
      if (!serviceType) return { ok: false, error: 'type is required (a catalog typeId, e.g. aws_lambda_function)', status: 400 };
      const parent = requireString('parent');
      const parentNode = parent ? findNode(doc, parent) : null;
      if (parent && !parentNode) return { ok: false, error: `parent ${parent} not found`, status: 404 };

      const created = createServiceNode(serviceType, nodesOf(doc), undefined);
      if (!created) return { ok: false, error: `Unknown service type ${serviceType}. Use catalog_list to see valid typeIds.`, status: 400 };

      const fields = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>;
      const bad = checkFields(serviceType, fields);
      if (bad) return { ok: false, error: bad, status: 400 };

      let node = created.node;
      const name = requireString('name');
      if (name) {
        node = { ...node, data: { ...node.data, label: name, resourceName: name.toLowerCase().replace(/[^a-z0-9_]/g, '_') } };
      }
      if (Object.keys(fields).length) {
        node = { ...node, data: { ...node.data, baseConfig: { ...node.data.baseConfig, ...fields } } };
      }
      if (parentNode) {
        node = { ...node, position: { x: 40, y: 60 }, parentId: parentNode.id };
      }
      // createServiceNode already normalized + maybe nested by drop position; redo cleanly with the final node
      let nodes = normalizeNodes([...nodesOf(doc).filter((n) => n.id !== created.node.id), node]);
      if (parentNode) nodes = reparentNode(nodes, node.id, parentNode.id);

      return {
        ok: true,
        doc: withParts(doc, nodes),
        result: { id: node.id, label: node.data.label, resourceName: node.data.resourceName, ...(parentNode ? { parent: parentNode.id } : {}) },
      };
    }

    case 'resource.configure': {
      const id = requireString('id');
      const node = id ? findNode(doc, id) : null;
      if (!node) return { ok: false, error: `resource ${id} not found`, status: 404 };
      const fields = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>;
      if (!Object.keys(fields).length) return { ok: false, error: 'fields is required', status: 400 };
      const bad = checkFields(node.data.serviceType, fields);
      if (bad) return { ok: false, error: bad, status: 400 };

      const env = args.env === undefined ? null : parseEnv(args.env);
      if (args.env !== undefined && !env) return { ok: false, error: `env must be one of ${ENV_IDS.join(', ')}`, status: 400 };

      const data = { ...node.data };
      if (env) {
        data.envOverrides = { ...data.envOverrides, [env]: { ...(data.envOverrides?.[env] ?? {}), ...fields } };
      } else {
        data.baseConfig = { ...data.baseConfig, ...fields };
      }
      const nodes = nodesOf(doc).map((n) => (n.id === id ? { ...n, data } : n));
      return { ok: true, doc: withParts(doc, nodes), result: { id, updated: Object.keys(fields), ...(env ? { env } : {}) } };
    }

    case 'resource.move': {
      const id = requireString('id');
      if (!id || !findNode(doc, id)) return { ok: false, error: `resource ${id} not found`, status: 404 };
      const parent = args.parent === null ? null : requireString('parent');
      if (parent && !findNode(doc, parent)) return { ok: false, error: `parent ${parent} not found`, status: 404 };
      if (parent === id) return { ok: false, error: 'a resource cannot be its own parent', status: 400 };

      let nodes = nodesOf(doc);
      if (parent) {
        nodes = reparentNode(nodes, id, parent);
      } else {
        // Move to the canvas root: children positions become absolute
        const absolute = releaseChildren(nodes, id).map((n) => (n.id === id ? { ...n, parentId: undefined } : n));
        nodes = normalizeNodes(absolute);
      }
      return { ok: true, doc: withParts(doc, nodes), result: { id, parent: parent ?? null } };
    }

    case 'resource.remove': {
      const id = requireString('id');
      if (!id || !findNode(doc, id)) return { ok: false, error: `resource ${id} not found`, status: 404 };
      let nodes = releaseChildren(nodesOf(doc), id);
      nodes = normalizeNodes(nodes.filter((n) => n.id !== id));
      const edges = edgesOf(doc).filter((e) => e.source !== id && e.target !== id);
      return { ok: true, doc: withParts(doc, nodes, edges), result: { id, removed: true } };
    }

    case 'connection.create': {
      const from = requireString('from');
      const to = requireString('to');
      const source = from ? findNode(doc, from) : null;
      const target = to ? findNode(doc, to) : null;
      if (!source || !target) return { ok: false, error: `resource ${!source ? from : to} not found`, status: 404 };

      // Same rules as the canvas: a refused connection returns the reason
      const check = checkConnection(source, target, edgesOf(doc));
      if (!check.ok) return { ok: false, error: `Connection refused: ${check.reason}`, status: 400 };

      const edge: CloudEdge = {
        id: `edge-${from}-${to}-${nowId()}`,
        source: from!,
        target: to!,
        animated: check.relationshipType !== 'network_attachment',
        data: { relationshipType: check.relationshipType, label: check.label },
      };
      return {
        ok: true,
        doc: withParts(doc, nodesOf(doc), [...edgesOf(doc), edge]),
        result: { id: edge.id, from: from!, to: to!, relationshipType: check.relationshipType, label: check.label },
      };
    }

    case 'connection.remove': {
      const id = requireString('id');
      const edges = edgesOf(doc);
      if (!id || !edges.some((e) => e.id === id)) return { ok: false, error: `connection ${id} not found`, status: 404 };
      return { ok: true, doc: withParts(doc, nodesOf(doc), edges.filter((e) => e.id !== id)), result: { id, removed: true } };
    }

    case 'env.override': {
      const id = requireString('id');
      const env = parseEnv(args.env);
      const field = requireString('field');
      if (!id || !findNode(doc, id)) return { ok: false, error: `resource ${id} not found`, status: 404 };
      if (!env) return { ok: false, error: `env must be one of ${ENV_IDS.join(', ')}`, status: 400 };
      if (!field) return { ok: false, error: 'field is required', status: 400 };
      if (!('value' in args)) return { ok: false, error: 'value is required (null clears the override)', status: 400 };

      const nodes = nodesOf(doc).map((n) => {
        if (n.id !== id) return n;
        const overrides = { ...(n.data.envOverrides ?? {}) };
        const scoped = { ...(overrides[env] ?? {}) };
        if (args.value === null) delete scoped[field];
        else scoped[field] = args.value;
        overrides[env] = scoped;
        return { ...n, data: { ...n.data, envOverrides: overrides } };
      });
      return { ok: true, doc: withParts(doc, nodes), result: { id, env, field } };
    }

    case 'env.enable': {
      const id = requireString('id');
      const env = parseEnv(args.env);
      if (!id || !findNode(doc, id)) return { ok: false, error: `resource ${id} not found`, status: 404 };
      if (!env) return { ok: false, error: `env must be one of ${ENV_IDS.join(', ')}`, status: 400 };
      if (typeof args.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false', status: 400 };

      const nodes = nodesOf(doc).map((n) =>
        n.id === id ? { ...n, data: { ...n.data, envEnabled: { ...(n.data.envEnabled ?? {}), [env]: args.enabled } } } : n
      );
      return { ok: true, doc: withParts(doc, nodes), result: { id, env, enabled: args.enabled as boolean } };
    }

    case 'lambda.code': {
      const id = requireString('id');
      const node = id ? findNode(doc, id) : null;
      if (!node) return { ok: false, error: `resource ${id} not found`, status: 404 };
      if (node.data.serviceType !== 'aws_lambda_function') {
        return { ok: false, error: `${id} is a ${node.data.serviceType}, not a Lambda`, status: 400 };
      }
      const hasInline = typeof args.inline === 'string';
      const hasSource = typeof args.sourceDir === 'string';
      if (!hasInline && !hasSource && args.handler === undefined && args.runtime === undefined) {
        return { ok: false, error: 'Provide inline code, a sourceDir, handler and/or runtime', status: 400 };
      }
      if (hasInline && hasSource) return { ok: false, error: 'inline and sourceDir are mutually exclusive', status: 400 };

      const data = { ...node.data };
      if (hasInline) {
        data.inlineCode = args.inline as string;
        data.sourceDir = undefined;
      }
      if (hasSource) {
        data.sourceDir = args.sourceDir as string;
        data.inlineCode = undefined;
      }
      const baseConfig = { ...data.baseConfig };
      if (args.handler !== undefined) baseConfig.handler = String(args.handler);
      if (args.runtime !== undefined) baseConfig.runtime = String(args.runtime);
      data.baseConfig = baseConfig;

      const nodes = nodesOf(doc).map((n) => (n.id === id ? { ...n, data } : n));
      return { ok: true, doc: withParts(doc, nodes), result: { id, ...(hasInline ? { inline: true } : {}), ...(hasSource ? { sourceDir: args.sourceDir } : {}) } };
    }

    case 'extra_hcl.set': {
      const id = requireString('id');
      const node = id ? findNode(doc, id) : null;
      if (!node) return { ok: false, error: `resource ${id} not found`, status: 404 };
      if (typeof args.hcl !== 'string') return { ok: false, error: 'hcl is required (empty string clears it)', status: 400 };
      const env = args.env === undefined ? null : parseEnv(args.env);
      if (args.env !== undefined && !env) return { ok: false, error: `env must be one of ${ENV_IDS.join(', ')}`, status: 400 };

      const hcl = args.hcl.trim() ? args.hcl : null;
      const nodes = nodesOf(doc).map((n) => {
        if (n.id !== id) return n;
        if (env) {
          const overrides = { ...(n.data.envOverrides ?? {}) };
          const scoped = { ...(overrides[env] ?? {}) };
          if (hcl) scoped[EXTRA_HCL_KEY] = hcl;
          else delete scoped[EXTRA_HCL_KEY];
          overrides[env] = scoped;
          return { ...n, data: { ...n.data, envOverrides: overrides } };
        }
        const baseConfig = { ...n.data.baseConfig };
        if (hcl) baseConfig[EXTRA_HCL_KEY] = hcl;
        else delete baseConfig[EXTRA_HCL_KEY];
        return { ...n, data: { ...n.data, baseConfig } };
      });
      return { ok: true, doc: withParts(doc, nodes), result: { id, ...(env ? { env } : {}) } };
    }

    case 'template.apply': {
      const templateId = requireString('templateId');
      const template = ARCHITECTURE_TEMPLATES.find((t) => t.id === templateId);
      if (!template) {
        return { ok: false, error: `Unknown template ${templateId}. Valid: ${ARCHITECTURE_TEMPLATES.map((t) => t.id).join(', ')}`, status: 400 };
      }
      const nodes = normalizeNodes(structuredClone(template.nodes));
      const edges = structuredClone(template.edges) as CloudEdge[];
      return { ok: true, doc: withParts(doc, nodes, edges), result: { template: template.id, nodes: nodes.length, edges: edges.length } };
    }

    case 'import.terraform': {
      if (typeof args.hcl !== 'string' || !args.hcl.trim()) return { ok: false, error: 'hcl is required', status: 400 };
      const imported = parseTerraformHclToCanvas(args.hcl);
      const nodes = normalizeNodes(imported.nodes);
      return {
        ok: true,
        doc: withParts(doc, nodes, imported.edges),
        result: {
          imported: imported.importedCount,
          extraHclArguments: imported.extraArgCount,
          skipped: imported.skippedResources,
          warnings: imported.warnings,
        },
      };
    }

    case 'project.validate': {
      const env = parseEnv(args.env) ?? 'dev';
      const findings = runArchitectureLinter(nodesOf(doc), edgesOf(doc), env);
      return {
        ok: true,
        doc,
        result: { env, findings },
      };
    }

    default:
      return { ok: false, error: `Unknown op ${op}`, status: 400 };
  }
}

/** The ops route only versions mutations; validate is read-only. */
export function opMutates(op: string): boolean {
  return op !== 'project.validate';
}
