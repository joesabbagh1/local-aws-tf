/**
 * Applies every blueprint (plus a canvas covering the rest of the catalog) to a fresh emulator,
 * then destroys it, and records which resource types work. The result feeds the support level the
 * UI shows per service: src/data/emulatorSupport.json.
 *
 *   npm run test:emulator -- [filter] [--env dev,prod] [--port 9397] [--keep]
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
import type { CloudEdge, CloudNode, EnvironmentId } from '../src/types/cloud';
import {
  buildLambdaArtifact,
  checkEmulatorHealth,
  getEmulatorAwsEnv,
  startEmulatorContainer,
  stopEmulatorContainer,
} from '../server/api';

const repoRoot = process.cwd();
const RESULTS_FILE = path.join(repoRoot, 'src', 'data', 'emulatorSupport.json');
const CONTAINER = 'localcloud-apply-test';

function parseArgs(argv: string[]) {
  const args = { filter: '', envs: ['dev', 'prod'] as EnvironmentId[], port: 9397, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') args.envs = argv[++i].split(',') as EnvironmentId[];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--keep') args.keep = true;
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
  const rest = AWS_SERVICES_CATALOG.filter((svc) => !covered.has(svc.typeId) && !['aws_vpc', 'aws_subnet'].includes(svc.typeId)).map(
    (svc) => node(svc.typeId, `cov_${svc.typeId.replace(/^aws_/, '')}`)
  );
  return { id: 'catalog-coverage', nodes: [...network, ...rest], edges: [] };
}

interface ResourceResult {
  address: string;
  type: string;
  applied: boolean;
  error?: string;
  destroyError?: string;
  /** Destroy refused because the config asks for it (deletion protection); not a failure. */
  destroyBlocked?: string;
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
        const text = `${msg.diagnostic.summary}${msg.diagnostic.detail ? `: ${msg.diagnostic.detail}` : ''}`.replace(/\s+/g, ' ').slice(0, 400);
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

const SECURITY_GROUP_QUIRK_NOTE =
  "The emulator doesn't create AWS's default egress rule for security groups in a VPC, so the provider's cleanup step fails. The group is created; LocalCloud marks it usable, and applying again finishes the rest.";

function isSecurityGroupEgressQuirk(message: string) {
  return /revoking default IPv[46] egress rule for Security Group/.test(message) && /InvalidPermission\.NotFound/.test(message);
}

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
    if (!(await waitForEmulator(port))) throw new Error('emulator did not become healthy');

    const tfEnv = {
      ...getEmulatorAwsEnv(port, env.region),
      // Its own provider cache: Terraform's cache is not safe to share with another process running init
      TF_PLUGIN_CACHE_DIR: path.join(repoRoot, 'node_modules', '.cache', 'localcloud', 'terraform-plugins-apply'),
      TF_IN_AUTOMATION: '1',
    };
    fs.mkdirSync(tfEnv.TF_PLUGIN_CACHE_DIR!, { recursive: true });
    execFileSync('terraform', ['init', '-input=false', '-no-color'], { cwd: workDir, env: tfEnv, stdio: 'ignore' });

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

    // Known emulator gap: security groups in a VPC are created but marked tainted. Untaint them and
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

    const results: ResourceResult[] = [...planned].map(([address, type]) => ({
      address,
      type,
      applied: apply.completed.has(address),
      error: apply.errors.get(address),
    }));

    if (!keep) {
      const destroy = await runTerraformJson(workDir, ['destroy', '-auto-approve', '-input=false', `-var-file=${envId}.tfvars`], tfEnv, 20 * 60 * 1000);
      log(`destroy exit ${destroy.code}`);
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
      if (unexplained.length === 1 && messages.length === 1) destroy.errors.set(unexplained[0], messages[0].replace(/\s+/g, ' '));
      else apply.general.push(...messages.map((g) => `destroy: ${g.slice(0, 400)}`));

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

/** Per resource type: verified only if every instance applied (and destroyed) in every run. */
function summarize(runs: RunResult[]) {
  const byType: Record<string, { status: 'verified' | 'fails'; applied: number; failed: number; errors: string[] }> = {};
  for (const run of runs) {
    for (const r of run.resources) {
      const entry = (byType[r.type] ||= { status: 'verified', applied: 0, failed: 0, errors: [] });
      const error = r.error || r.destroyError;
      if (r.applied && !r.destroyError) entry.applied++;
      else if (error) {
        entry.failed++;
        entry.status = 'fails';
        const msg = `${r.destroyError && !r.error ? 'destroy: ' : ''}${error}`;
        if (entry.errors.length < 3 && !entry.errors.includes(msg)) entry.errors.push(msg);
      }
      // Neither applied nor errored: skipped because something it depends on failed; says nothing about this type
    }
  }
  for (const [type, entry] of Object.entries(byType)) if (entry.applied === 0 && entry.failed === 0) delete byType[type];
  return byType;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const canvases = [
    ...ARCHITECTURE_TEMPLATES.map((t) => ({ id: t.id, nodes: normalizeNodes(structuredClone(t.nodes)), edges: t.edges })),
    coverageCanvas(),
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
    const failed = r.resources.filter((x) => x.error || x.destroyError).length;
    console.log(`${`${r.canvas}/${r.envId}`.padEnd(38)}${(r.ok && !failed ? 'ok' : `FAIL ${failed}`).padEnd(8)}${r.durationSeconds}s`);
  }
  console.log(`\nwrote ${path.relative(repoRoot, RESULTS_FILE)}`);
  process.exit(runs.every((r) => r.ok && r.resources.every((x) => !x.error && !x.destroyError)) ? 0 : 1);
}

main();
