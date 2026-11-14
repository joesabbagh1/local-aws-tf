import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import type { CloudEdge, CloudNode, EnvironmentId } from '../src/types/cloud';
import { summarizePlan, type PlanResourceChange } from '../src/utils/planSummary';
import { version } from '../package.json';

/**
 * The LocalCloud MCP server: a thin stdio→HTTP adapter onto the backend. All state and all rules
 * (versioning, connection semantics, terraform execution, locking) live in the backend; this
 * process only translates tool calls into API calls. Never write to stdout — it is the protocol.
 */

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

class Backend {
  private projectId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly projectArg?: string
  ) {}

  headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.headers() });
    const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
    return data as T;
  }

  /** Resolve (and cache) the project tools operate on: --project id/dir, else the server default. */
  async resolveProject(explicit?: string): Promise<string> {
    const wanted = explicit || this.projectArg;
    if (wanted && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) {
      this.projectId = wanted;
      return wanted;
    }
    const list = await this.json<{ projects: { id: string; working_dir: string }[]; defaultProjectId: string }>('/api/projects');
    if (!wanted) {
      this.projectId = list.defaultProjectId || list.projects[0]?.id;
    } else {
      const abs = wanted.startsWith('/') ? wanted : `${process.cwd()}/${wanted.replace(/^\.\//, '')}`;
      this.projectId =
        list.projects.find((p) => p.working_dir === abs || p.working_dir === wanted)?.id ?? list.defaultProjectId;
    }
    if (!this.projectId) throw new ApiError('No projects exist yet on the backend', 404);
    return this.projectId;
  }

  async projectDoc(explicit?: string): Promise<{ projectId: string; doc: any; version: number; project: any }> {
    const projectId = await this.resolveProject(explicit);
    const data = await this.json<any>(`/api/projects/${projectId}`);
    if (!data.exists) {
      throw new ApiError('The project has no design yet. Call template_apply or resource_add first.', 409);
    }
    return { projectId, doc: data.doc, version: data.version, project: data.project };
  }

  /** Consume a streamed terraform run to its sentinel; return the outcome plus a log tail. */
  async terraformRun(body: Record<string, unknown>): Promise<{
    exitCode: number;
    log: string;
    planChanges: PlanResourceChange[] | null;
    stale: boolean;
  }> {
    const res = await fetch(`${this.baseUrl}/api/projects/${body.projectId}/terraform/run`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.body) throw new ApiError(`HTTP ${res.status}`, res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let exitCode = 1;
    let stale = false;
    let planChanges: PlanResourceChange[] | null = null;
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const exit = line.match(/^__LC_EXIT__:(-?\d+)$/);
        if (exit) exitCode = Number(exit[1]);
        else if (line === '__LC_PLAN_STALE__') stale = true;
        else if (line.startsWith('__LC_PLAN__:')) {
          try {
            planChanges = JSON.parse(line.slice('__LC_PLAN__:'.length));
          } catch {
            planChanges = null;
          }
        } else full += line + '\n';
      }
      if (done) break;
    }
    return { exitCode, log: full.length > 8000 ? full.slice(-8000) : full, planChanges, stale };
  }
}

const ENV_IDS = ['dev', 'testing', 'staging', 'prod'] as const;

/**
 * Environment profile for port/region lookups. Designs created headlessly (resource_add on an
 * empty project) may carry no environments section — the app defaults fill in ports 9297-9300.
 */
function envProfile(doc: any, env: string): { emulatorPort: number; region: string } | undefined {
  const fallback = (DEFAULT_ENVIRONMENTS as Record<string, any>)[env];
  const saved = doc?.environments?.[env];
  if (!fallback && !saved) return undefined;
  return { ...fallback, ...saved };
}

export async function runMcpServer(argv: string[]): Promise<void> {
  const opts: { url: string; token?: string; project?: string } = {
    url: process.env.LOCALCLOUD_URL || 'http://127.0.0.1:5173',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a.startsWith('--url=')) opts.url = a.slice('--url='.length);
    else if (a === '--token') opts.token = argv[++i];
    else if (a.startsWith('--token=')) opts.token = a.slice('--token='.length);
    else if (a === '--project') opts.project = argv[++i];
    else if (a.startsWith('--project=')) opts.project = a.slice('--project='.length);
  }
  opts.token = opts.token || process.env.LOCALCLOUD_TOKEN;

  const api = new Backend(opts.url, opts.token, opts.project);
  const server = new McpServer({ name: 'localcloud-studio', version }, { capabilities: { tools: {} } });

  const ACTOR = 'mcp';
  const projectId = z.string().optional().describe('Optional project id (defaults to the --project / server default project)');
  const envField = z.enum(ENV_IDS);

  const designOp = (op: string) => async (args: Record<string, any>) => {
    // resolveProject, not projectDoc: template_apply / resource_add / import_terraform must be
    // able to start a design on an empty project; the backend enforces the rest.
    const id = await api.resolveProject(args?.projectId);
    const { projectId: _drop, ...cleanArgs } = args ?? {};
    return api.json(`/api/projects/${id}/ops`, {
      method: 'POST',
      body: JSON.stringify({ op, args: cleanArgs, actor: ACTOR }),
    });
  };

  const runTerraform = async (args: Record<string, any>) => {
    const projectId = await api.resolveProject(args.projectId);
    const { doc } = await api.projectDoc(args.projectId);
    const env = args.env as EnvironmentId;
    const profile = envProfile(doc, env);
    if (!profile) throw new ApiError(`No environment profile for ${env}`, 400);

    const outcome = await api.terraformRun({
      projectId,
      command: args.command,
      envId: env,
      port: profile.emulatorPort,
      region: profile.region,
      usePlan: args.usePlan === true,
      destroy: args.command === 'plan' && args.destroyPlan === true,
      actor: ACTOR,
    });

    const summary =
      outcome.planChanges && Array.isArray(outcome.planChanges)
        ? summarizePlan(outcome.planChanges, doc.nodes as CloudNode[], env)
        : null;
    return {
      exitCode: outcome.exitCode,
      stale: outcome.stale || undefined,
      ...(summary ? { plan: summary } : {}),
      log: outcome.log,
    };
  };

  const controlEmulator = async (action: 'start' | 'stop', args: Record<string, any>) => {
    const env = args.env as EnvironmentId;
    const { doc, projectId } = await api.projectDoc(args.projectId);
    const profile = envProfile(doc, env);
    if (!profile) throw new ApiError(`No environment profile for ${env}`, 400);
    return api.json('/api/emulator/control', {
      method: 'POST',
      body: JSON.stringify({ action, envId: env, port: profile.emulatorPort, projectId, actor: ACTOR }),
    });
  };

  /**
   * Every tool returns its payload as JSON text; a thrown error becomes the tool error the agent
   * reads. Handlers stay plain async functions over the backend API.
   */
  const register = (
    name: string,
    config: { description: string; inputSchema: Record<string, any> },
    handler: (args: any) => Promise<unknown>
  ) =>
    server.registerTool(name, config as any, async (args: any) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(args), null, 1) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: err?.message || String(err) }], isError: true };
      }
    });

  // ── read ────────────────────────────────────────────────────────────────────────────────
  register('projects_list', {
    description: 'List LocalCloud projects (id, name, working dir, current version).',
    inputSchema: {},
  }, () => api.json('/api/projects'));

  register('project_get', {
    description:
      'Get a project design: version, nodes (id, label, service type, parent, per-env enablement), edges, environment profiles.',
    inputSchema: { projectId },
  }, async (args: Record<string, any>) => {
    const { doc, version, project } = await api.projectDoc(args.projectId);
    return {
      project: { id: project.id, name: project.name, workingDir: project.working_dir },
      version,
      environments: doc.environments,
      nodes: (doc.nodes as CloudNode[]).map((n) => ({
        id: n.id,
        label: n.data.label,
        resourceName: n.data.resourceName,
        serviceType: n.data.serviceType,
        parent: n.parentId ?? null,
        envEnabled: n.data.envEnabled,
        hasInlineCode: !!n.data.inlineCode,
        sourceDir: n.data.sourceDir ?? null,
      })),
      edges: (doc.edges as CloudEdge[]).map((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        relationshipType: e.data?.relationshipType,
      })),
    };
  });

  register('catalog_list', {
    description:
      'The AWS service catalog: every service with its field schema (key, type, default, options), emulator support level, and the blueprint templates.',
    inputSchema: {},
  }, () => api.json('/api/catalog'));

  register('project_validate', {
    description: 'Architecture lint findings for one environment (severity, category, message).',
    inputSchema: { env: envField.optional(), projectId },
  }, designOp('project.validate'));

  register('versions_list', {
    description: 'Version history of a project (version, actor, summary, timestamp).',
    inputSchema: { limit: z.number().optional(), projectId },
  }, async (args: Record<string, any>) =>
    api.json(`/api/projects/${await api.resolveProject(args.projectId)}/versions?limit=${args.limit ?? 50}`)
  );

  register('version_get', {
    description: 'One full design document as saved at a version.',
    inputSchema: { version: z.number(), projectId },
  }, async (args: Record<string, any>) =>
    api.json(`/api/projects/${await api.resolveProject(args.projectId)}/versions/${args.version}`)
  );

  register('version_restore', {
    description: 'Restore an old version by appending it as a new head (history is never rewritten).',
    inputSchema: { version: z.number(), projectId },
  }, async (args: Record<string, any>) =>
    api.json(`/api/projects/${await api.resolveProject(args.projectId)}/versions/${args.version}/restore`, {
      method: 'POST',
      body: JSON.stringify({ actor: ACTOR }),
    })
  );

  register('project_diff', {
    description: 'Structural diff between two versions: nodes/edges added, removed, changed.',
    inputSchema: { from: z.number(), to: z.number(), projectId },
  }, async (args: Record<string, any>) =>
    api.json(`/api/projects/${await api.resolveProject(args.projectId)}/diff?from=${args.from}&to=${args.to}`)
  );

  // ── design mutations (one version + audit event each) ──────────────────────────────────
  register('resource_add', {
    description:
      'Add a service to the canvas from its catalog typeId, with catalog defaults. Optional name, field values, and a parent container (VPC/Subnet id) to nest into.',
    inputSchema: {
      type: z.string().describe('Catalog typeId, e.g. aws_lambda_function (see catalog_list)'),
      name: z.string().optional().describe('Display name; the resource name is derived from it'),
      fields: z.record(z.string(), z.unknown()).optional().describe('Field values keyed by schema key'),
      parent: z.string().optional().describe('Node id of a VPC/Subnet to place the resource in'),
      projectId,
    },
  }, designOp('resource.add'));

  register('resource_configure', {
    description:
      "Set field values on a resource, either for all environments or as one environment's override. Unknown field keys are refused with the valid list.",
    inputSchema: {
      id: z.string(),
      fields: z.record(z.string(), z.unknown()),
      env: envField.optional(),
      projectId,
    },
  }, designOp('resource.configure'));

  register('resource_move', {
    description:
      'Move a resource into a VPC/Subnet container (nesting drives vpc_id/subnet_ids), or to the canvas root with parent: null.',
    inputSchema: {
      id: z.string(),
      parent: z.string().nullable().describe('Container node id, or null for the root'),
      projectId,
    },
  }, designOp('resource.move'));

  register('resource_remove', {
    description: 'Remove a resource and its connections; its children are released to the canvas root.',
    inputSchema: { id: z.string(), projectId },
  }, designOp('resource.remove'));

  register('connection_create', {
    description:
      'Connect two resources. The canvas rules apply: only meaningful relationships (a queue triggering a Lambda, an LB in front of a service, …) are accepted; anything else is refused with the reason.',
    inputSchema: { from: z.string(), to: z.string(), projectId },
  }, designOp('connection.create'));

  register('connection_remove', {
    description: 'Remove a connection by id.',
    inputSchema: { id: z.string(), projectId },
  }, designOp('connection.remove'));

  register('env_override', {
    description: "Set one field's value for one environment only (null clears the override).",
    inputSchema: {
      id: z.string(),
      env: envField,
      field: z.string(),
      value: z.unknown(),
      projectId,
    },
  }, designOp('env.override'));

  register('env_enable', {
    description: 'Switch a resource on or off for one environment.',
    inputSchema: { id: z.string(), env: envField, enabled: z.boolean(), projectId },
  }, designOp('env.enable'));

  register('lambda_code_set', {
    description:
      "Set a Lambda's code: inline (one file, no dependencies) or a project-relative sourceDir (zipped as-is), plus optional handler and runtime.",
    inputSchema: {
      id: z.string(),
      inline: z.string().optional(),
      sourceDir: z.string().optional(),
      handler: z.string().optional(),
      runtime: z.string().optional(),
      projectId,
    },
  }, designOp('lambda.code'));

  register('extra_hcl_set', {
    description: 'Set Extra HCL on a resource for arguments the form does not model (empty string clears it).',
    inputSchema: { id: z.string(), hcl: z.string(), env: envField.optional(), projectId },
  }, designOp('extra_hcl.set'));

  register('template_apply', {
    description: 'Replace the canvas with a blueprint template (see catalog_list for ids).',
    inputSchema: { templateId: z.string(), projectId },
  }, designOp('template.apply'));

  register('import_terraform', {
    description:
      'Import Terraform HCL onto the canvas, replacing the design. Modeled arguments become fields; the rest becomes Extra HCL; anything unloadable is listed in the result.',
    inputSchema: { hcl: z.string(), projectId },
  }, designOp('import.terraform'));

  // ── run / deploy ────────────────────────────────────────────────────────────────────────
  register('sync', {
    description:
      'Compile the head design to Terraform and write it (plus Lambda zips) to the project working dir. target "emulator" → terraform-out, "aws" → terraform-aws export.',
    inputSchema: { target: z.enum(['emulator', 'aws']).optional(), projectId },
  }, async (args: Record<string, any>) => {
    const id = await api.resolveProject(args.projectId);
    return api.json(`/api/projects/${id}/terraform/sync`, {
      method: 'POST',
      body: JSON.stringify({ target: args.target === 'aws' ? 'aws' : 'emulator', actor: ACTOR }),
    });
  });

  register('emulator_status', {
    description: 'Health of the emulator ports (one container per environment).',
    inputSchema: { ports: z.string().optional().describe('Comma-separated, default all four env ports') },
  }, (args: Record<string, any>) => api.json(`/api/emulator/status?ports=${args.ports || '9297,9298,9299,9300'}`));

  register('emulator_start', {
    description: 'Start the AWS Emulator container for one environment (needs Docker).',
    inputSchema: { env: envField, projectId },
  }, (args: Record<string, any>) => controlEmulator('start', args));

  register('emulator_stop', {
    description: 'Stop the emulator container for one environment.',
    inputSchema: { env: envField, projectId },
  }, (args: Record<string, any>) => controlEmulator('stop', args));

  register('terraform_run', {
    description:
      'Run terraform (init/validate/plan/apply/destroy) for one environment against its emulator. Returns the exit code, a log tail and — for plan — the per-resource changes. A plan is saved; apply it with apply_plan.',
    inputSchema: {
      command: z.enum(['init', 'validate', 'plan', 'apply', 'destroy']),
      env: envField,
      destroyPlan: z.boolean().optional().describe('With command=plan: make a destroy plan'),
      projectId,
    },
  }, runTerraform);

  register('apply_plan', {
    description:
      'Apply the saved, reviewed plan for an environment — exactly what was planned; refuses (stale) if Terraform inputs or Lambda code changed since the plan.',
    inputSchema: { env: envField, projectId },
  }, (args: Record<string, any>) => runTerraform({ ...args, command: 'apply', usePlan: true }));

  register('state_get', {
    description: 'What actually exists in one environment (or all), from its Terraform state: resources and outputs.',
    inputSchema: { env: envField.optional(), projectId },
  }, async (args: Record<string, any>) => {
    const id = await api.resolveProject(args.projectId);
    if (args.env) return api.json(`/api/projects/${id}/terraform/state?envId=${args.env}`);
    const all = await Promise.all(
      ENV_IDS.map(async (env) => [env, await api.json(`/api/projects/${id}/terraform/state?envId=${env}`)])
    );
    return Object.fromEntries(all);
  });

  // ── data plane ──────────────────────────────────────────────────────────────────────────
  register('explore', {
    description:
      'Poke the deployed resources on the emulator: s3 list_buckets/list_objects/put_object/get_object, dynamodb list_tables/scan/put_item, sqs list_queues/send_message/receive_message, lambda list_functions/invoke.',
    inputSchema: {
      service: z.enum(['s3', 'dynamodb', 'sqs', 'lambda']),
      operation: z.string(),
      target: z.string().optional().describe('Bucket / table / queue / function name, where applicable'),
      input: z.record(z.string(), z.unknown()).optional().describe('Operation input (e.g. {message, queueUrl}, {payload})'),
      env: envField.optional().describe("Which environment's emulator (default dev)"),
      projectId,
    },
  }, async (args: Record<string, any>) => {
    const env: string = ENV_IDS.includes(args.env) ? args.env : 'dev';
    const { doc } = await api.projectDoc(args.projectId);
    const profile = envProfile(doc, env);
    if (!profile) throw new ApiError(`No environment profile for ${env}`, 400);
    const port = profile.emulatorPort;
    const region = profile.region;
    return api.json('/api/emulator/explore', {
      method: 'POST',
      body: JSON.stringify({
        port,
        region,
        service: args.service,
        operation: args.operation,
        target: args.target || '',
        input: args.input && typeof args.input === 'object' ? args.input : {},
        actor: ACTOR,
      }),
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`localcloud-studio mcp ${version} → ${opts.url}\n`);
}
