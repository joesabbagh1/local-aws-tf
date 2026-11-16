/**
 * Applies every blueprint (plus a canvas covering the rest of the catalog) to a fresh emulator,
 * then destroys it, and records which resource types work. The result feeds the support level the
 * UI shows per service: src/data/emulatorSupport.json.
 *
 *   npm run test:emulator -- [filter] [--env dev,prod] [--port 9397] [--keep] [--report-only]
 *
 * Exit codes: 0 all clean, 1 some resource failed, 2 the run itself broke (no canvas could run).
 * With --report-only, resource failures still exit 0: for scheduled runs that record results.
 *
 * Needs Docker and Terraform. Uses its own port and container, so it never touches the emulators
 * the app runs.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { AWS_SERVICES_CATALOG, DEFAULT_ENVIRONMENTS, getDefaultConfigForService } from '../src/data/awsCatalog';
import { compileTerraformForEnvironment, resolveNodeConfigForEnv, sanitizeIdentifier } from '../src/utils/terraformCompiler';
import { normalizeNodes } from '../src/utils/canvasLayout';
import { checkConnection } from '../src/utils/connectionRules';
import type { CloudEdge, CloudNode, EnvironmentId } from '../src/types/cloud';
import {
  buildLambdaArtifact,
  checkEmulatorHealth,
  emulatorContainerLogs,
  getEmulatorAwsEnv,
  startEmulatorContainer,
  stopEmulatorContainer,
} from '../server/api';
import { blockedDeletes, isSecurityGroupEgressQuirk, unimplementedDeletes } from '../server/services/emulatorQuirks';
import { EMULATOR_ADJUSTMENTS } from '../src/utils/emulatorAdjustments';

const repoRoot = process.cwd();
const RESULTS_FILE = path.join(repoRoot, 'src', 'data', 'emulatorSupport.json');
const CONTAINER = 'localcloud-apply-test';

function parseArgs(argv: string[]) {
  const args = { filter: '', envs: ['dev', 'prod'] as EnvironmentId[], port: 9397, keep: false, reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') args.envs = argv[++i].split(',') as EnvironmentId[];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--keep') args.keep = true;
    else if (a === '--report-only') args.reportOnly = true;
    else args.filter = a;
  }
  return args;
}

/** Every catalog service no blueprint uses, inside one VPC with two subnets so networked ones resolve. */
function coverageCanvas(): { id: string; nodes: CloudNode[]; edges: CloudEdge[] } {
  const covered = new Set(ARCHITECTURE_TEMPLATES.flatMap((t) => t.nodes.map((n) => n.data.serviceType)));
  const node = (typeId: string, name: string, config: Record<string, unknown> = {}): CloudNode => ({
    id: `cov-${name}`,
    type: 'awsNode',
    position: { x: 0, y: 0 },
    data: {
      label: name,
      resourceName: name,
      serviceType: typeId,
      baseConfig: { ...getDefaultConfigForService(typeId), ...config },
      envOverrides: {},
      envEnabled: { dev: true, testing: true, staging: true, prod: true },
      tags: {},
    },
  });
  const network = [
    node('aws_vpc', 'cov_vpc'),
    node('aws_subnet', 'cov_subnet_a', { cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a' }),
    node('aws_subnet', 'cov_subnet_b', { cidr_block: '10.0.2.0/24', availability_zone: 'us-east-1b' }),
  ];
  // Region-correct zones for environments outside us-east-1
  for (const subnet of network.slice(1)) {
    for (const envId of ['staging', 'prod'] as const) {
      const az = String(subnet.data.baseConfig.availability_zone).replace('us-east-1', DEFAULT_ENVIRONMENTS[envId].region);
      subnet.data.envOverrides[envId] = { availability_zone: az };
    }
  }
  const rest = AWS_SERVICES_CATALOG.filter((svc) => !svc.deprecated && !covered.has(svc.typeId) && !['aws_vpc', 'aws_subnet'].includes(svc.typeId)).map(
    (svc) => node(svc.typeId, `cov_${svc.typeId.replace(/^aws_/, '')}`)
  );
  return { id: 'catalog-coverage', nodes: [...network, ...rest], edges: [] };
}

/**
 * The event and permission wiring connections generate: one function reached from every kind of
 * entry point (API, queue, topic, bus, bucket, table stream, state machine, load balancer, CDN,
 * user pool), and calling a table, bucket, queue, topic and secret. Built through the canvas
 * rules, so every connection here is one a user can draw.
 */
function connectionsCanvas(): { id: string; nodes: CloudNode[]; edges: CloudEdge[] } {
  const node = (typeId: string, name: string, config: Record<string, unknown> = {}, extra: Partial<CloudNode['data']> = {}): CloudNode => ({
    id: `con-${name}`,
    type: 'awsNode',
    position: { x: 0, y: 0 },
    data: {
      label: name,
      resourceName: name,
      serviceType: typeId,
      baseConfig: { ...getDefaultConfigForService(typeId), ...config },
      envOverrides: {},
      envEnabled: {},
      tags: {},
      ...extra,
    },
  });
  const fn = node('aws_lambda_function', 'con_fn', {}, { inlineCode: 'export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify(event).slice(0, 200) });\n' });
  const sources = [
    node('aws_apigatewayv2_api', 'con_api'),
    node('aws_sqs_queue', 'con_in_queue'),
    node('aws_sns_topic', 'con_topic'),
    node('aws_cloudwatch_event_bus', 'con_bus'),
    node('aws_s3_bucket', 'con_uploads', { bucket_prefix: 'con-uploads' }),
    node('aws_dynamodb_table', 'con_stream_table'),
    node('aws_sfn_state_machine', 'con_flow'),
    node('aws_cloudfront_distribution', 'con_cdn'),
  ];
  const targets = [
    node('aws_dynamodb_table', 'con_table'),
    node('aws_s3_bucket', 'con_media', { bucket_prefix: 'con-media' }),
    node('aws_sqs_queue', 'con_out_queue'),
    node('aws_sns_topic', 'con_alerts'),
    node('aws_secretsmanager_secret', 'con_secret'),
  ];
  const pool = node('aws_cognito_user_pool', 'con_users');
  const fanout = node('aws_sqs_queue', 'con_fanout');
  const pairs: [CloudNode, CloudNode][] = [
    ...sources.map((s): [CloudNode, CloudNode] => [s, fn]),
    ...targets.map((t): [CloudNode, CloudNode] => [fn, t]),
    [pool, sources[0]],
    [pool, fn],
    [sources[2], fanout],
    [sources[3], fanout],
  ];
  const edges: CloudEdge[] = [];
  for (const [source, target] of pairs) {
    const check = checkConnection(source, target, edges);
    if (!check.ok) throw new Error(`connections canvas: ${source.id} -> ${target.id} refused: ${check.reason}`);
    edges.push({ id: `e-${source.id}-${target.id}`, source: source.id, target: target.id, data: { relationshipType: check.relationshipType, label: check.label } });
  }
  return { id: 'connections', nodes: [fn, ...sources, ...targets, pool, fanout], edges };
}

interface ResourceResult {
  address: string;
  type: string;
  applied: boolean;
  error?: string;
  destroyError?: string;
  /** Destroy refused because the config asks for it (deletion protection); not a failure. */
  destroyBlocked?: string;
  /** The emulator can't delete it; LocalCloud dropped it from state, as the app's runner does. */
  destroyWorkaround?: string;
  /** The emulator run used a different value than the AWS export (see src/utils/emulatorAdjustments.ts). */
  adjusted?: boolean;
}

/** `type.name` of every resource block the compiler marked with an "# Emulator only:" adjustment. */
function adjustedResources(mainTf: string): Set<string> {
  const out = new Set<string>();
  const blocks = mainTf.split(/\n(?=resource ")/);
  for (const block of blocks) {
    const head = block.match(/^resource "([\w-]+)" "([\w-]+)"/);
    if (head && block.includes('# Emulator only:')) out.add(`${head[1]}.${head[2]}`);
  }
  return out;
}

/** Streams `terraform <args> -json`, collecting per-resource outcomes and error diagnostics. */
function runTerraformJson(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number; completed: Set<string>; errors: Map<string, string>; general: string[] }>((resolve) => {
    const completed = new Set<string>();
    const errors = new Map<string, string>();
    const general: string[] = [];
    const child = spawn('terraform', [args[0], '-json', ...args.slice(1)], { cwd, env });
    const timer = setTimeout(() => {
      general.push(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      child.kill('SIGINT');
    }, timeoutMs);
    let buffer = '';
    const onLine = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'apply_complete') completed.add(msg.hook?.resource?.addr);
      if (msg.type === 'apply_errored') errors.set(msg.hook?.resource?.addr, errors.get(msg.hook?.resource?.addr) || 'apply errored');
      if (msg.type === 'diagnostic' && msg.diagnostic?.severity === 'error') {
        const text = `${msg.diagnostic.summary}${msg.diagnostic.detail ? `: ${msg.diagnostic.detail}` : ''}`.replace(/\s+/g, ' ');
        if (msg.diagnostic.address) errors.set(msg.diagnostic.address, text);
        else general.push(text);
      }
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    child.stderr.on('data', (chunk) => general.push(String(chunk).trim()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) onLine(buffer);
      resolve({ code: code ?? 1, completed, errors, general });
    });
  });
}

/** Emulator gaps already reported upstream (github.com/aws/aws-emulator/issues/<n>), by resource type. */
const UPSTREAM_ISSUES: Record<string, number> = {
  aws_security_group: 46,
  aws_kinesis_stream: 327,
  aws_instance: 422,
  aws_elasticache_replication_group: 355,
  aws_elasticache_cluster: 471,
};

const SECURITY_GROUP_QUIRK_NOTE =
  "The emulator stores a VPC security group's default egress rule without ports, so the provider's request to remove it (ports 0-0) doesn't match (aws/aws-emulator#46). The group is created; LocalCloud marks it usable, and applying again finishes the rest.";


async function waitForEmulator(port: number, timeoutMs = 120000) {
  const credentials = path.join(os.homedir(), '.aws', 'emulator', String(port), 'emulator_credentials');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await checkEmulatorHealth(port)).running && fs.existsSync(credentials)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function testCanvas(canvas: { id: string; nodes: CloudNode[]; edges: CloudEdge[] }, envId: EnvironmentId, port: number, keep: boolean) {
  const env = { ...DEFAULT_ENVIRONMENTS[envId], emulatorPort: port, emulatorEndpoint: `https://127.0.0.1:${port}` };
  const environments = { ...DEFAULT_ENVIRONMENTS, [envId]: env };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `localcloud-apply-${canvas.id}-${envId}-`));
  const started = Date.now();
  const log = (msg: string) => console.log(`[${canvas.id}/${envId}] ${msg}`);

  const compiled = compileTerraformForEnvironment(canvas.nodes, canvas.edges, env, environments);
  fs.writeFileSync(path.join(workDir, 'main.tf'), compiled.mainTf);
  fs.writeFileSync(path.join(workDir, 'provider.tf'), compiled.providerTf);
  fs.writeFileSync(path.join(workDir, 'variables.tf'), compiled.variablesTf);
  fs.writeFileSync(path.join(workDir, `${envId}.tfvars`), compiled.tfvars);
  fs.writeFileSync(path.join(workDir, 'outputs.tf'), compiled.outputsTf);
  for (const n of canvas.nodes) {
    if (n.data.serviceType !== 'aws_lambda_function' || n.data.envEnabled?.[envId] === false) continue;
    const cfg = resolveNodeConfigForEnv(n, envId);
    const built = await buildLambdaArtifact(workDir, repoRoot, {
      envId,
      resourceName: sanitizeIdentifier(n.data.resourceName || n.data.label),
      runtime: String(cfg.runtime || 'nodejs20.x'),
      handler: String(cfg.handler || 'index.handler'),
      code: n.data.inlineCode,
      sourceDir: n.data.sourceDir,
    });
    if (built.error) throw new Error(built.error);
  }

  // A fresh emulator per run, so results never depend on what an earlier run left behind
  fs.rmSync(path.join(os.homedir(), '.aws', 'emulator', String(port)), { recursive: true, force: true });
  const start = await startEmulatorContainer(CONTAINER, port, workDir);
  if (!start.ok) throw new Error(`emulator did not start: ${start.error || start.output}`);
  try {
    if (!(await waitForEmulator(port))) {
      const logs = await emulatorContainerLogs(CONTAINER);
      throw new Error(`emulator did not become healthy. Container log:\n${logs || '(empty)'}`);
    }

    const tfEnv = {
      ...getEmulatorAwsEnv(port, env.region),
      // Its own provider cache: Terraform's cache is not safe to share with another process running init
      TF_PLUGIN_CACHE_DIR: path.join(repoRoot, 'node_modules', '.cache', 'localcloud', 'terraform-plugins-apply'),
      TF_IN_AUTOMATION: '1',
    };
    fs.mkdirSync(tfEnv.TF_PLUGIN_CACHE_DIR!, { recursive: true });
    // init downloads from the Terraform registry; retry a network blip instead of losing the canvas
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('terraform', ['init', '-input=false', '-no-color'], { cwd: workDir, env: tfEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000 });
        break;
      } catch (err: any) {
        const reason = (String(err.stderr || '') || String(err.message)).trim().split('\n').filter(Boolean).slice(-3).join(' ');
        if (attempt >= 3) throw new Error(`terraform init failed: ${reason}`);
        log(`terraform init failed (attempt ${attempt}): ${reason}; retrying`);
        await new Promise((r) => setTimeout(r, 15000 * attempt));
      }
    }

    // Which resources this canvas declares (counts and helpers included)
    const planned = new Map<string, string>();
    // AWS-side names per resource, to attribute errors that Terraform reports without an address
    const awsNames = new Map<string, string[]>();
    try {
      execFileSync('terraform', ['plan', `-var-file=${envId}.tfvars`, '-out=tfplan', '-input=false', '-no-color'], {
        cwd: workDir,
        env: tfEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err: any) {
      // Plan errors are the useful part; keep them instead of "Command failed"
      const text = String(err.stderr || '') + String(err.stdout || '');
      const errors = [...text.matchAll(/Error: (.+)\n(?:[\s\S]*?\n)?\s*(?:with|on) ([^\n]+)/g)].map((m) => `${m[1]} (${m[2].trim()})`);
      throw new Error(`plan failed: ${(errors.length ? errors : [text.trim().slice(-600)]).slice(0, 4).join(' | ')}`);
    }
    const plan = JSON.parse(execFileSync('terraform', ['show', '-json', 'tfplan'], { cwd: workDir, env: tfEnv, maxBuffer: 256 * 1024 * 1024 }).toString());
    for (const rc of plan.resource_changes || []) {
      if (rc.mode !== 'managed') continue;
      planned.set(rc.address, rc.type);
      const after = rc.change?.after || {};
      awsNames.set(
        rc.address,
        ['name', 'identifier', 'cluster_id', 'replication_group_id', 'bucket', 'function_name', 'domain_name']
          .map((k) => after[k])
          .filter((v): v is string => typeof v === 'string' && v.length > 3)
      );
    }

    log(`applying ${planned.size} resources`);
    const apply = await runTerraformJson(workDir, ['apply', '-auto-approve', '-input=false', 'tfplan'], tfEnv, 20 * 60 * 1000);
    log(`apply exit ${apply.code}: ${apply.completed.size} created, ${apply.errors.size} failed`);

    // Known emulator gap (aws/aws-emulator#46): security groups in a VPC are created but marked tainted. Untaint them and
    // apply again, so the run still measures everything that depends on them.
    const quirkAddresses = [...apply.errors].filter(([, msg]) => isSecurityGroupEgressQuirk(msg)).map(([addr]) => addr);
    if (quirkAddresses.length > 0) {
      for (const addr of quirkAddresses) execFileSync('terraform', ['untaint', addr], { cwd: workDir, env: tfEnv, stdio: 'ignore' });
      log(`untainted ${quirkAddresses.length} security group(s) (emulator default-egress gap); second apply`);
      const second = await runTerraformJson(workDir, ['apply', '-auto-approve', '-input=false', `-var-file=${envId}.tfvars`], tfEnv, 20 * 60 * 1000);
      log(`second apply exit ${second.code}: ${second.completed.size} created, ${second.errors.size} failed`);
      second.completed.forEach((addr) => apply.completed.add(addr));
      for (const [addr, msg] of second.errors) if (!apply.errors.has(addr)) apply.errors.set(addr, msg);
      apply.general.push(...second.general);
      for (const addr of quirkAddresses) apply.errors.set(addr, SECURITY_GROUP_QUIRK_NOTE);
      apply.code = second.code;
    }

    const adjusted = adjustedResources(compiled.mainTf);
    const results: ResourceResult[] = [...planned].map(([address, type]) => ({
      address,
      type,
      applied: apply.completed.has(address),
      error: apply.errors.get(address)?.slice(0, 400),
      ...(adjusted.has(address.replace(/\[[^\]]*\]$/, '')) ? { adjusted: true } : {}),
    }));

    if (!keep) {
      const runDestroy = async () => {
        const destroy = await runTerraformJson(workDir, ['destroy', '-auto-approve', '-input=false', `-var-file=${envId}.tfvars`], tfEnv, 20 * 60 * 1000);
        // Destroy diagnostics often come without an address: match them to resources by AWS name,
        // and a single leftover message to a single leftover resource
        const unexplained = [...destroy.errors].filter(([, msg]) => msg === 'apply errored').map(([addr]) => addr);
        const messages = [...destroy.general];
        for (const addr of [...unexplained]) {
          const idx = messages.findIndex((m) => (awsNames.get(addr) || []).some((n) => m.includes(n)));
          if (idx === -1) continue;
          destroy.errors.set(addr, messages[idx].replace(/\s+/g, ' '));
          messages.splice(idx, 1);
          unexplained.splice(unexplained.indexOf(addr), 1);
        }
        if (unexplained.length === 1 && messages.length === 1) {
          destroy.errors.set(unexplained[0], messages[0].replace(/\s+/g, ' '));
          messages.length = 0;
        }
        return { destroy, messages };
      };

      let { destroy, messages } = await runDestroy();
      log(`destroy exit ${destroy.code}`);

      // Known emulator gap: some deletes aren't implemented (aws/aws-emulator#355). Do what the app's runner does:
      // drop those resources from state, then whatever they still hold (a subnet group, its subnets), and destroy the rest.
      const asOutput = (errors: Map<string, string>) => [...errors].map(([address, msg]) => `Error: ${msg}\n  with ${address},\n`).join('\n');
      const leftovers = unimplementedDeletes(asOutput(destroy.errors));
      if (leftovers.length > 0) {
        const forget = (address: string) => execFileSync('terraform', ['state', 'rm', address], { cwd: workDir, env: tfEnv, stdio: 'ignore' });
        for (const { address, operation } of leftovers) {
          forget(address);
          const result = results.find((r) => r.address === address);
          if (result) result.destroyWorkaround = `The emulator has no ${operation}; LocalCloud removes it from Terraform state on destroy`;
        }
        log(`removed ${leftovers.length} resource(s) the emulator can't delete from state; destroying the rest`);
        for (let round = 0; round < 5; round++) {
          ({ destroy, messages } = await runDestroy());
          log(`destroy (round ${round + 2}) exit ${destroy.code}`);
          if (destroy.code === 0) break;
          const text = asOutput(destroy.errors);
          const held = [...unimplementedDeletes(text), ...blockedDeletes(text)].map((l) => l.address);
          if (held.length === 0) break;
          held.forEach(forget);
          log(`removed ${held.length} resource(s) still in use by them from state`);
        }
      }
      apply.general.push(...messages.map((g) => `destroy: ${g.slice(0, 400)}`));

      for (const r of results) {
        const msg = destroy.errors.get(r.address);
        if (!msg) continue;
        // Classify on the full text: the reason often comes after a long ARN
        if (/deletion protection is enabled|DeletionProtection/i.test(msg)) r.destroyBlocked = 'deletion protection';
        else r.destroyError = msg.slice(0, 400);
      }
    }

    return {
      canvas: canvas.id,
      envId,
      ok: apply.code === 0,
      durationSeconds: Math.round((Date.now() - started) / 1000),
      generalErrors: apply.general.filter(Boolean).slice(0, 5),
      resources: results,
    };
  } finally {
    if (!keep) {
      await stopEmulatorContainer(CONTAINER);
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      log(`kept emulator on :${port} and ${workDir}`);
    }
  }
}

type RunResult = Awaited<ReturnType<typeof testCanvas>>;

/** A resource that failed for real: not the security group quirk LocalCloud recovers from. */
const isFailure = (r: ResourceResult) => Boolean((r.error && r.error !== SECURITY_GROUP_QUIRK_NOTE) || r.destroyError);

/**
 * Per resource type: verified only if every instance applied (and destroyed) in every run with
 * nothing changed; adjusted if it only works with an emulator-only value or LocalCloud's destroy
 * workaround; second-apply if it needed LocalCloud's automatic second apply; otherwise fails.
 */
function summarize(runs: RunResult[]) {
  type Status = 'verified' | 'adjusted' | 'second-apply' | 'fails';
  const rank: Record<Status, number> = { verified: 0, adjusted: 1, 'second-apply': 2, fails: 3 };
  type Entry = { status: Status; applied: number; failed: number; errors: string[]; upstreamIssue?: number };
  const byType: Record<string, Entry> = {};
  // Failure messages, and notes on how a working type was helped along; errors shows whichever matches the status
  const failures = new Map<string, string[]>();
  const notes = new Map<string, string[]>();
  const push = (list: Map<string, string[]>, type: string, msg: string) => {
    const l = list.get(type) || [];
    if (l.length < 3 && !l.includes(msg)) l.push(msg);
    list.set(type, l);
  };
  const raise = (entry: Entry, status: Status) => {
    if (rank[status] > rank[entry.status]) entry.status = status;
  };
  for (const run of runs) {
    for (const r of run.resources) {
      const entry = (byType[r.type] ||= { status: 'verified', applied: 0, failed: 0, errors: [] });
      const sgQuirk = r.error === SECURITY_GROUP_QUIRK_NOTE;
      const error = (sgQuirk ? undefined : r.error) || r.destroyError;
      if (r.applied && !error) {
        entry.applied++;
        if (sgQuirk) {
          raise(entry, 'second-apply');
          push(notes, r.type, SECURITY_GROUP_QUIRK_NOTE);
        }
        if (r.adjusted || r.destroyWorkaround) {
          raise(entry, 'adjusted');
          push(notes, r.type, EMULATOR_ADJUSTMENTS[r.type]?.note || r.destroyWorkaround || 'Runs with an emulator-only adjustment.');
        }
      } else if (error) {
        entry.failed++;
        raise(entry, 'fails');
        push(failures, r.type, `${r.destroyError && !r.error ? 'destroy: ' : ''}${error}`);
      }
      // Neither applied nor errored: skipped because something it depends on failed; says nothing about this type
    }
  }
  for (const [type, entry] of Object.entries(byType)) {
    if (entry.applied === 0 && entry.failed === 0) {
      delete byType[type];
      continue;
    }
    entry.errors = (entry.status === 'fails' ? failures : notes).get(type) || [];
    if (entry.status !== 'verified' && UPSTREAM_ISSUES[type]) entry.upstreamIssue = UPSTREAM_ISSUES[type];
  }
  return byType;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const canvases = [
    ...ARCHITECTURE_TEMPLATES.map((t) => ({ id: t.id, nodes: normalizeNodes(structuredClone(t.nodes)), edges: t.edges })),
    coverageCanvas(),
    connectionsCanvas(),
  ].filter((c) => c.id.includes(args.filter));

  const runs: RunResult[] = [];
  for (const canvas of canvases) {
    for (const envId of args.envs) {
      try {
        runs.push(await testCanvas(canvas, envId, args.port, args.keep));
      } catch (err: any) {
        console.log(`[${canvas.id}/${envId}] could not run: ${err.message}`);
        runs.push({ canvas: canvas.id, envId, ok: false, durationSeconds: 0, generalErrors: [String(err.message)], resources: [] });
      }
    }
  }

  // A filtered run only updates what it tested
  const previous = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')) : { runs: [] };
  const keptRuns = (previous.runs || []).filter((r: RunResult) => !runs.some((n) => n.canvas === r.canvas && n.envId === r.envId));
  const allRuns = [...keptRuns, ...runs].sort((a, b) => `${a.canvas}/${a.envId}`.localeCompare(`${b.canvas}/${b.envId}`));

  const terraformVersion = execFileSync('terraform', ['version', '-json']).toString();
  const imageCreated = execFileSync('docker', ['image', 'inspect', '-f', '{{.Created}}', 'aws-emulator:local']).toString().trim();
  fs.writeFileSync(
    RESULTS_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        terraformVersion: JSON.parse(terraformVersion).terraform_version,
        emulatorImageCreated: imageCreated,
        byType: summarize(allRuns),
        runs: allRuns,
      },
      null,
      2
    )}\n`
  );

  console.log('\nrun                                   result  time');
  for (const r of runs) {
    const failed = r.resources.filter(isFailure).length;
    console.log(`${`${r.canvas}/${r.envId}`.padEnd(38)}${(r.ok && !failed ? 'ok' : `FAIL ${failed}`).padEnd(8)}${r.durationSeconds}s`);
  }
  console.log(`\nwrote ${path.relative(repoRoot, RESULTS_FILE)}`);
  // A run with no resources never got as far as planning (Docker, the emulator or Terraform failed)
  if (runs.length === 0 || runs.every((r) => r.resources.length === 0)) process.exit(2);
  const clean = runs.every((r) => r.ok && r.resources.every((x) => !isFailure(x)));
  process.exit(clean || args.reportOnly ? 0 : 1);
}

main();
