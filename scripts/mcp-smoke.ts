import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Boots a real backend, then drives the MCP server (`localcloud-studio mcp`) over stdio through a
 * realistic agent loop: list tools → inspect the project → design on the ops path → validate →
 * compile. Terraform/docker are not needed for this pass; run/deploy are exercised by the e2e and
 * emulator suites.
 *
 *   DATABASE_URL=... npm run mcp:smoke
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (docker compose up -d postgres)');
  process.exit(1);
}

const PORT = 8791;
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-smoke-'));

function post(p: string, body?: any): Promise<any> {
  return fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json() as Promise<any>);
}

const assert = (cond: unknown, message: string) => {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
};

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
function mcpClient() {
  const child = spawn(process.execPath, ['dist-server/cli.cjs', 'mcp', '--url', `http://127.0.0.1:${PORT}`], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    async initialize() {
      const res = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0.0.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return res;
    },
    listTools: () => send('tools/list', {}),
    callTool: (name: string, args: any) => send('tools/call', { name, arguments: args }),
    close: () => child.kill(),
  };
}

async function main() {
  // 1. backend
  const server = spawn(process.execPath, ['dist-server/cli.cjs', projectDir, '--port', String(PORT)], {
    env: { ...process.env, DATABASE_URL },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await post('/api/projects');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('backend did not come up');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const mcp = mcpClient();
  const init = await mcp.initialize();
  assert(init?.result?.serverInfo?.name === 'localcloud-studio', 'initialize handshake');

  const tools = await mcp.listTools();
  const names = (tools?.result?.tools || []).map((t: any) => t.name);
  assert(names.length >= 20, `tools/list exposes ${names.length} tools`);
  assert(
    ['resource_add', 'connection_create', 'terraform_run', 'explore', 'environment_add', 'scenario_save', 'scenario_run', 'runs_list'].every((n) => names.includes(n)),
    'key tools present'
  );

  const call = async (name: string, args: any) => {
    const res = await mcp.callTool(name, args);
    const text = res?.result?.content?.[0]?.text;
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // plain error text
    }
    return { isError: res?.result?.isError === true, text, json, raw: res };
  };

  // 2. the fresh project has no design yet: reads say so, and template_apply is how a design starts
  const empty = await call('project_get', {});
  assert(empty.isError && /no design yet/i.test(empty.text), 'empty project explains itself');

  const template = await call('template_apply', { templateId: 'serverless-ecommerce' });
  assert(!template.isError && template.json.version === 1, `template_apply started the design at v${template.json?.version}`);

  const project = await call('project_get', {});
  assert(!project.isError && project.json.version >= 1 && project.json.nodes.length > 0, `project_get: ${project.json?.nodes?.length} nodes at v${project.json?.version}`);

  const added = await call('resource_add', { type: 'aws_dynamodb_table', name: 'sessions' });
  assert(!added.isError && added.json.result.resourceName === 'sessions', `resource_add → ${added.json?.result?.id}`);

  const badField = await call('resource_configure', { id: added.json.result.id, fields: { nope: 1 } });
  assert(badField.isError && /Unknown field nope/.test(badField.text), 'unknown field refused with the reason');

  const afterAdd = await call('project_get', {});
  const lambdaId = afterAdd.json.nodes.find((n: any) => n.serviceType === 'aws_lambda_function').id;
  const queue = await call('resource_add', { type: 'aws_sqs_queue', name: 'events' });
  const trigger = await call('connection_create', { from: queue.json.result.id, to: lambdaId });
  assert(!trigger.isError && trigger.json.result.relationshipType === 'event_trigger', 'queue → lambda is an event_trigger');

  const refused = await call('connection_create', { from: added.json.result.id, to: queue.json.result.id });
  assert(refused.isError && /refused/i.test(refused.text), `meaningless connection refused: ${refused.text?.slice(0, 80)}`);

  // 4. env scoping + validate + sync (server-side compile)
  const override = await call('env_override', { id: added.json.result.id, env: 'prod', field: 'billing_mode', value: 'PAY_PER_REQUEST' });
  assert(!override.isError, `env_override → v${override.json?.version}`);

  const lint = await call('project_validate', { env: 'dev' });
  assert(!lint.isError && Array.isArray(lint.json.result.findings), `project_validate: ${lint.json?.result?.findings?.length} findings`);

  // 4b. a custom environment: added, overridden, compiled to its own folder
  const qa = await call('environment_add', { id: 'qa', copyFrom: 'testing' });
  assert(!qa.isError && qa.json.result.emulatorPort === 9301, `environment_add qa on port ${qa.json?.result?.emulatorPort}`);
  const qaOverride = await call('env_override', { id: added.json.result.id, env: 'qa', field: 'point_in_time_recovery', value: true });
  assert(!qaOverride.isError, 'env_override accepts the new environment');
  const badEnv = await call('env_enable', { id: added.json.result.id, env: 'nope', enabled: false });
  assert(badEnv.isError && /env must be one of .*qa/.test(badEnv.text), 'an unknown environment is refused with the valid list');

  // 4c. a scenario, saved with the design
  const scenario = await call('scenario_save', {
    scenario: {
      name: 'queue reaches the worker',
      steps: [
        { service: 'sqs', operation: 'send_message', nodeId: queue.json.result.id, input: { body: '{"ping":1}' } },
        { service: 'lambda', operation: 'logs', nodeId: lambdaId, expect: { contains: ['ping'] }, retrySeconds: 10 },
      ],
    },
  });
  assert(!scenario.isError && scenario.json.result.steps === 2, `scenario_save → ${scenario.json?.result?.id}`);
  const listed = await call('scenarios_list', {});
  assert(listed.json?.scenarios?.length === 1, 'scenarios_list returns it');
  const run = await call('scenario_run', { env: 'qa' });
  assert(run.isError && /emulator is not running/.test(run.text), `scenario_run explains a stopped emulator: ${run.text?.slice(0, 70)}`);

  const synced = await call('sync', { target: 'emulator' });
  assert(!synced.isError && synced.json.writtenFiles.length > 10, `sync wrote ${synced.json?.writtenFiles?.length} files`);
  assert(
    fs.existsSync(path.join(projectDir, 'terraform-out', 'environments', 'dev', 'main.tf')),
    'terraform compiled into the working dir'
  );
  assert(
    fs.existsSync(path.join(projectDir, 'terraform-out', 'environments', 'qa', 'qa.tfvars')),
    'the custom environment compiled into its own folder'
  );

  // 5. history
  const versions = await call('versions_list', {});
  assert(versions.json.versions.length >= 5, `versions_list: ${versions.json?.versions?.length} versions`);
  const diff = await call('project_diff', { from: project.json.version, to: versions.json.versions[0].version });
  assert(
    !diff.isError && diff.json.diff.environmentChanges.some((c: any) => c.id === 'qa' && c.change === 'added'),
    'project_diff reports the added environment'
  );
  const restored = await call('version_restore', { version: project.json.version });
  assert(!restored.isError, `version_restore → v${restored.json?.version}`);

  const events = await call('events_list', {});
  assert(events.json?.events?.some((e: any) => e.action === 'design.environment.add'), 'events_list records the environment change');
  const runs = await call('runs_list', {});
  assert(!runs.isError && Array.isArray(runs.json.runs), `runs_list: ${runs.json?.runs?.length} runs`);

  // 6. materialized file matches head (UI can open the same project)
  const head = await post(`/api/projects/${project.json.project.id}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, 'localcloud.json'), 'utf-8'));
  assert(
    JSON.stringify(head.doc) === JSON.stringify(onDisk),
    'localcloud.json materialized to the working dir matches the head version'
  );

  // 7. every design mutation was recorded with the mcp actor
  const mcpVersions = versions.json.versions.filter((v: any) => v.actor === 'mcp').length;
  assert(mcpVersions >= 5, `${mcpVersions} versions recorded with actor 'mcp'`);

  mcp.close();
  // Before stopping the server, which is what serves the delete
  await fetch(`http://127.0.0.1:${PORT}/api/projects/${project.json.project.id}`, { method: 'DELETE' }).catch(() => {});
  server.kill();
  fs.rmSync(projectDir, { recursive: true, force: true });

  console.log(process.exitCode ? 'MCP SMOKE FAILED' : 'MCP SMOKE PASSED');
  process.exit(process.exitCode ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
