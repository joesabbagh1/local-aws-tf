import { ARCHITECTURE_TEMPLATES } from '../../src/data/templates';
import { SERVICE_BY_TYPE } from '../../src/data/awsCatalog';
import type { CloudEdge, CloudNode, EnvironmentId } from '../../src/types/cloud';
import { EXTRA_HCL_KEY } from '../../src/utils/terraformCompiler';
import { checkConnection } from '../../src/utils/connectionRules';
import { accessLevelsFor, callWiring } from '../../src/utils/wiringCatalog';
import { createServiceNode } from '../../src/utils/nodeFactory';
import { normalizeNodes, releaseChildren, reparentNode } from '../../src/utils/canvasLayout';
import { parseTerraformHclToCanvas } from '../../src/utils/hclImporter';
import { runArchitectureLinter } from '../../src/utils/architectureValidator';
import { toProjectEnvironments, type ProjectFile } from '../../src/utils/projectFile';
import {
  addEnvironment,
  envIdsOf,
  removeEnvironment,
  resolveEnvironments,
  validateEnvId,
} from '../../src/utils/environments';
import { parseScenario } from '../../src/utils/scenarios';

/**
 * Headless design mutations, one op = one function over the design document. The ops route loads
 * the head version, applies one of these, and saves atomically — so the MCP server, like the UI,
 * can only produce designs the canvas rules allow (invalid connections and unknown fields are
 * refused with the reason).
 */

export type DesignOpResult =
  | { ok: true; doc: ProjectFile; result: Record<string, unknown> }
  | { ok: false; error: string; status?: number };

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

/** The project's own environments (the four defaults unless it added or removed some). */
function envsOf(doc: ProjectFile) {
  return resolveEnvironments(doc.environments);
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

/**
 * A connection's access level: read or write only, where the target offers it (see
 * accessLevelsFor). Undefined input keeps the full grant.
 */
function parseAccess(source: CloudNode, target: CloudNode, value: unknown): { value?: 'read' | 'write' | 'readwrite'; error?: string } {
  if (value === undefined) return {};
  const levels = accessLevelsFor(target.data.serviceType);
  if (!callWiring(source.data.serviceType, target.data.serviceType)?.grant || levels.length === 0) {
    return { error: `A ${source.data.serviceType} → ${target.data.serviceType} connection has no access levels to choose` };
  }
  const match = levels.find((l) => l.value === value);
  if (!match) return { error: `access must be one of ${levels.map((l) => `${l.value} (${l.label})`).join(', ')}` };
  return { value: match.value };
}

export function applyDesignOp(op: string, doc: ProjectFile, args: DesignOpArgs): DesignOpResult {
  const requireString = (key: string): string | null => {
    const v = args[key];
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const ENV_IDS = envIdsOf(envsOf(doc));
  const parseEnv = (value: unknown): EnvironmentId | null =>
    typeof value === 'string' && ENV_IDS.includes(value) ? value : null;

  switch (op) {
    case 'resource.add': {
      const serviceType = requireString('type');
      if (!serviceType) return { ok: false, error: 'type is required (a catalog typeId, e.g. aws_lambda_function)', status: 400 };
      const parent = requireString('parent');
      const parentNode = parent ? findNode(doc, parent) : null;
      if (parent && !parentNode) return { ok: false, error: `parent ${parent} not found`, status: 404 };

      const deprecated = SERVICE_BY_TYPE[serviceType]?.deprecated;
      if (deprecated) return { ok: false, error: `${serviceType} can't be added to new designs. ${deprecated}`, status: 400 };
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
      const access = parseAccess(source, target, args.access);
      if (access.error) return { ok: false, error: access.error, status: 400 };

      const edge: CloudEdge = {
        id: `edge-${from}-${to}-${nowId()}`,
        source: from!,
        target: to!,
        animated: check.relationshipType !== 'network_attachment',
        data: { relationshipType: check.relationshipType, label: check.label, ...(access.value ? { access: access.value } : {}) },
      };
      return {
        ok: true,
        doc: withParts(doc, nodesOf(doc), [...edgesOf(doc), edge]),
        result: {
          id: edge.id,
          from: from!,
          to: to!,
          relationshipType: check.relationshipType,
          label: check.label,
          ...(access.value ? { access: access.value } : {}),
        },
      };
    }

    case 'connection.configure': {
      const id = requireString('id');
      const edge = id ? edgesOf(doc).find((e) => e.id === id) : undefined;
      if (!edge) return { ok: false, error: `connection ${id} not found`, status: 404 };
      if (args.access === undefined && args.label === undefined) {
        return { ok: false, error: 'Provide access and/or label', status: 400 };
      }
      const source = findNode(doc, edge.source);
      const target = findNode(doc, edge.target);
      if (!source || !target) return { ok: false, error: 'the connection points at a resource that no longer exists', status: 404 };
      const access = args.access === null ? { value: undefined } : parseAccess(source, target, args.access);
      if (access.error) return { ok: false, error: access.error, status: 400 };
      if (args.label !== undefined && typeof args.label !== 'string') return { ok: false, error: 'label must be a string', status: 400 };

      const { access: _previous, ...rest } = edge.data ?? ({} as NonNullable<CloudEdge['data']>);
      const data = {
        ...rest,
        relationshipType: edge.data?.relationshipType ?? 'data_flow',
        ...(args.label !== undefined ? { label: String(args.label) } : {}),
        // null clears it back to the full grant; leaving it out keeps what was there
        ...(args.access === undefined ? (edge.data?.access ? { access: edge.data.access } : {}) : access.value ? { access: access.value } : {}),
      };
      const edges = edgesOf(doc).map((e) => (e.id === id ? { ...e, data } : e));
      return { ok: true, doc: withParts(doc, nodesOf(doc), edges), result: { id, ...data } };
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
        n.id === id ? { ...n, data: { ...n.data, envEnabled: { ...(n.data.envEnabled ?? {}), [env]: args.enabled as boolean } } } : n
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

    case 'environment.add': {
      const id = requireString('id');
      if (!id) return { ok: false, error: 'id is required (e.g. "qa")', status: 400 };
      const problem = validateEnvId(id, ENV_IDS);
      if (problem) return { ok: false, error: problem, status: 400 };
      const copyFrom = args.copyFrom === undefined ? undefined : parseEnv(args.copyFrom);
      if (args.copyFrom !== undefined && !copyFrom) {
        return { ok: false, error: `copyFrom must be one of ${ENV_IDS.join(', ')}`, status: 400 };
      }
      const next = addEnvironment({ nodes: nodesOf(doc), environments: envsOf(doc) }, id, {
        name: requireString('name') ?? undefined,
        region: requireString('region') ?? undefined,
        copyFrom: copyFrom ?? undefined,
      });
      const profile = next.environments[id];
      return {
        ok: true,
        doc: { ...doc, nodes: next.nodes, environments: toProjectEnvironments(next.environments) },
        result: { id, name: profile.name, region: profile.region, emulatorPort: profile.emulatorPort, ...(copyFrom ? { copiedFrom: copyFrom } : {}) },
      };
    }

    case 'environment.update': {
      const id = parseEnv(args.id);
      if (!id) return { ok: false, error: `id must be one of ${ENV_IDS.join(', ')}`, status: 400 };
      const environments = envsOf(doc);
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) {
        if (!requireString('name')) return { ok: false, error: 'name must be a non-empty string', status: 400 };
        patch.name = (args.name as string).trim();
      }
      if (args.region !== undefined) {
        if (typeof args.region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(args.region)) {
          return { ok: false, error: 'region must look like us-east-1', status: 400 };
        }
        patch.region = args.region;
      }
      if (args.emulatorPort !== undefined) {
        const port = Number(args.emulatorPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'emulatorPort must be 1024–65535', status: 400 };
        const taken = Object.values(environments).find((e) => e.id !== id && e.emulatorPort === port);
        if (taken) return { ok: false, error: `Port ${port} is already used by ${taken.id}`, status: 400 };
        patch.emulatorPort = port;
        patch.emulatorEndpoint = `https://127.0.0.1:${port}`;
      }
      if (args.production !== undefined) {
        if (typeof args.production !== 'boolean') return { ok: false, error: 'production must be true or false', status: 400 };
        patch.production = args.production;
      }
      if (args.usage !== undefined) {
        if (!args.usage || typeof args.usage !== 'object') return { ok: false, error: 'usage must be an object', status: 400 };
        const usage = { ...environments[id].usage };
        for (const key of ['requestsMillions', 'dataTransferGb', 'storageGb', 'logsGb'] as const) {
          const value = (args.usage as Record<string, unknown>)[key];
          if (value === undefined) continue;
          if (typeof value !== 'number' || !(value >= 0)) return { ok: false, error: `usage.${key} must be a number ≥ 0`, status: 400 };
          usage[key] = value;
        }
        patch.usage = usage;
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: 'Provide name, region, emulatorPort, production and/or usage', status: 400 };
      }
      const next = { ...environments, [id]: { ...environments[id], ...patch } };
      return { ok: true, doc: { ...doc, environments: toProjectEnvironments(next) }, result: { id, updated: Object.keys(patch) } };
    }

    case 'environment.remove': {
      const id = parseEnv(args.id);
      if (!id) return { ok: false, error: `id must be one of ${ENV_IDS.join(', ')}`, status: 400 };
      if (ENV_IDS.length <= 1) return { ok: false, error: 'A project needs at least one environment', status: 400 };
      const next = removeEnvironment({ nodes: nodesOf(doc), environments: envsOf(doc) }, id);
      return {
        ok: true,
        doc: { ...doc, nodes: next.nodes, environments: toProjectEnvironments(next.environments) },
        result: { id, removed: true, note: `terraform-out/environments/${id} and its state are left on disk; destroy it first if resources are still applied.` },
      };
    }

    case 'scenario.save': {
      const parsed = parseScenario(args.scenario, () => `sc-${nowId()}-${Math.random().toString(36).slice(2, 6)}`);
      if ('error' in parsed) return { ok: false, error: parsed.error, status: 400 };
      const missing = parsed.scenario.steps.find((step) => step.nodeId && !findNode(doc, step.nodeId));
      if (missing) return { ok: false, error: `step resource ${missing.nodeId} not found`, status: 404 };
      const existing = doc.scenarios ?? [];
      const scenarios = existing.some((sc) => sc.id === parsed.scenario.id)
        ? existing.map((sc) => (sc.id === parsed.scenario.id ? parsed.scenario : sc))
        : [...existing, parsed.scenario];
      return { ok: true, doc: { ...doc, scenarios }, result: { id: parsed.scenario.id, name: parsed.scenario.name, steps: parsed.scenario.steps.length } };
    }

    case 'scenario.remove': {
      const id = requireString('id');
      const existing = doc.scenarios ?? [];
      if (!id || !existing.some((sc) => sc.id === id)) return { ok: false, error: `scenario ${id} not found`, status: 404 };
      const scenarios = existing.filter((sc) => sc.id !== id);
      const { scenarios: _drop, ...rest } = doc;
      return { ok: true, doc: scenarios.length ? { ...doc, scenarios } : rest, result: { id, removed: true } };
    }

    case 'project.validate': {
      const env = parseEnv(args.env) ?? ENV_IDS[0];
      const findings = runArchitectureLinter(nodesOf(doc), edgesOf(doc), env, envsOf(doc));
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
