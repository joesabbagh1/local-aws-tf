import { execFile, spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import crypto from 'node:crypto';
import { S3Client, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, ListTablesCommand, ScanCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, ListQueuesCommand, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, ListFunctionsCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { DEFAULT_ENVIRONMENTS, AWS_CATEGORIES, AWS_SERVICES_CATALOG } from '../src/data/awsCatalog';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import type { CloudNode, CloudEdge, EnvironmentId, EnvironmentProfile } from '../src/types/cloud';
import { buildTerraformFiles } from '../src/utils/terraformBundle';
import { emulatorSupport } from '../src/utils/emulatorSupport';
import type { ProjectFile } from '../src/utils/projectFile';
import { applyDesignOp, opMutates } from './services/designOps';
import { BusyError, DbReady, createSql, withAdvisoryLock, type Sql } from './db';
import {
  PROJECT_FILE,
  deleteProject,
  diffDocs,
  ensureProject,
  getHead,
  getProject,
  getVersion,
  isValidDoc,
  listProjects,
  listVersions,
  reconcileFile,
  renameProject,
  restoreVersion,
  saveDoc,
  type ProjectRow,
} from './services/projectStore';

export { PROJECT_FILE };

/**
 * Local API used by the UI: emulator control, Terraform runner, project file and data explorer.
 * Mounted by the Vite dev server (vite.config.ts) and by the standalone CLI (server/cli.ts).
 */

/** Output folders per compile target: terraform-out runs on the emulator, terraform-aws is the export. */
const OUTPUT_DIRS = { emulator: 'terraform-out', aws: 'terraform-aws' } as const;
const PLAN_FILE = '.localcloud.tfplan';
/** Hash of what a saved plan was made from, so a stale plan is never applied. */
const PLAN_INPUTS_FILE = '.localcloud.tfplan.inputs';

/**
 * Everything a plan is made from: the Terraform files and the Lambda zips (whose contents can change
 * without the canvas changing, e.g. a Lambda code folder). Zips are deterministic, so equal hash
 * means equal inputs.
 */
export function planInputsHash(envDir: string): string {
  const hash = crypto.createHash('sha256');
  const files = fs
    .readdirSync(envDir)
    .filter((f) => f.endsWith('.tf') || f.endsWith('.tfvars'))
    .map((f) => path.join(envDir, f));
  const artifacts = path.join(envDir, 'artifacts');
  if (fs.existsSync(artifacts)) {
    files.push(...fs.readdirSync(artifacts).filter((f) => f.endsWith('.zip')).map((f) => path.join(artifacts, f)));
  }
  for (const file of files.sort()) {
    hash.update(path.relative(envDir, file));
    hash.update('\u0000');
    hash.update(fs.readFileSync(file));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

const ENV_IDS = new Set(['dev', 'testing', 'staging', 'prod']);
const TERRAFORM_COMMANDS = new Set(['init', 'validate', 'plan', 'apply', 'destroy']);

export type EmulatorHealth = { running: boolean; status: string; caExists: boolean };

/**
 * Where the emulator's per-port credentials and CA live, and the dir mounted into emulator
 * containers. Overridable with LOCALCLOUD_EMULATOR_DIR when the backend itself runs in a
 * container and must share the host's dir at the same absolute path (see docker-compose.yml).
 */
function emulatorDataDir(): string {
  return process.env.LOCALCLOUD_EMULATOR_DIR || path.join(os.homedir(), '.aws', 'emulator');
}

export function checkEmulatorHealth(port: number): Promise<EmulatorHealth> {
  return new Promise((resolve) => {
    const caPath = path.join(emulatorDataDir(), String(port), 'ca.pem');
    const caExists = fs.existsSync(caPath);

    const req = https.get(
      `https://127.0.0.1:${port}/__admin/health`,
      {
        rejectUnauthorized: false,
        timeout: 1200,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            running: res.statusCode === 200,
            status: body.trim() || `HTTP ${res.statusCode}`,
            caExists,
          });
        });
      }
    );

    req.on('error', () => {
      resolve({ running: false, status: 'offline', caExists });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, status: 'timeout', caExists });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, payload: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function parsePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function parseEnvId(value: unknown): string | null {
  return typeof value === 'string' && ENV_IDS.has(value) ? value : null;
}

/** Runs a binary with an argument list (no shell), so request values can never be interpreted as shell syntax. */
function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        timeout: options.timeout || 60000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || (err ? err.message : ''),
        });
      }
    );
  });
}

export function getEmulatorAwsEnv(port: number, region = 'us-east-1'): NodeJS.ProcessEnv {
  const baseDir = path.join(emulatorDataDir(), String(port));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ENDPOINT_URL: `https://127.0.0.1:${port}`,
    AWS_SHARED_CREDENTIALS_FILE: path.join(baseDir, 'emulator_credentials'),
    AWS_CONFIG_FILE: path.join(baseDir, 'config'),
    AWS_CA_BUNDLE: path.join(baseDir, 'ca.pem'),
    NODE_EXTRA_CA_CERTS: path.join(baseDir, 'ca.pem'),
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    EMULATOR_TELEMETRY: 'off',
  };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  return env;
}

/** SDK client config for one emulator port, using the credentials and CA the emulator writes to ~/.aws/emulator/<port>/. */
function getEmulatorClientConfig(port: number, region: string) {
  const baseDir = path.join(emulatorDataDir(), String(port));
  const ini = fs.readFileSync(path.join(baseDir, 'emulator_credentials'), 'utf-8');
  const read = (key: string) => ini.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'm'))?.[1] || '';
  return {
    region,
    endpoint: `https://127.0.0.1:${port}`,
    credentials: {
      accessKeyId: read('aws_access_key_id'),
      secretAccessKey: read('aws_secret_access_key'),
    },
    disableHostPrefix: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({ ca: fs.readFileSync(path.join(baseDir, 'ca.pem')) }),
    }),
  };
}

const MAX_PAYLOAD_CHARS = 64 * 1024;

function parseMaybeJson(text: string): unknown {
  const clipped = text.slice(0, MAX_PAYLOAD_CHARS);
  try {
    return JSON.parse(clipped);
  } catch {
    return clipped;
  }
}

function stripMetadata<T extends object>(output: T): Omit<T, '$metadata'> {
  const { $metadata: _meta, ...rest } = output as T & { $metadata?: unknown };
  return rest;
}

/** Runs one data-plane operation against the emulator. Returns null for unsupported operations. */
async function runExplorerOperation(
  port: number,
  region: string,
  service: string,
  operation: string,
  target: string,
  input: Record<string, any>
): Promise<unknown | null> {
  const config = getEmulatorClientConfig(port, region);

  switch (`${service}:${operation}`) {
    case 's3:list_buckets':
      return stripMetadata(await new S3Client({ ...config, forcePathStyle: true }).send(new ListBucketsCommand({})));
    case 's3:list_objects':
      return stripMetadata(
        await new S3Client({ ...config, forcePathStyle: true }).send(
          new ListObjectsV2Command({ Bucket: target, MaxKeys: 100 })
        )
      );
    case 's3:put_object':
      return stripMetadata(
        await new S3Client({ ...config, forcePathStyle: true }).send(
          new PutObjectCommand({ Bucket: target, Key: String(input.key || ''), Body: String(input.body ?? '') })
        )
      );
    case 's3:get_object': {
      const out = await new S3Client({ ...config, forcePathStyle: true }).send(
        new GetObjectCommand({ Bucket: target, Key: String(input.key || '') })
      );
      const { Body, ...meta } = stripMetadata(out);
      return { ...meta, Payload: parseMaybeJson((await Body?.transformToString()) || '') };
    }
    case 'dynamodb:list_tables':
      return stripMetadata(await new DynamoDBClient(config).send(new ListTablesCommand({})));
    case 'dynamodb:scan':
      return stripMetadata(await new DynamoDBClient(config).send(new ScanCommand({ TableName: target, Limit: 50 })));
    case 'dynamodb:put_item':
      return stripMetadata(
        await new DynamoDBClient(config).send(new PutItemCommand({ TableName: target, Item: input.item || {} }))
      );
    case 'sqs:list_queues':
      return stripMetadata(await new SQSClient(config).send(new ListQueuesCommand({})));
    case 'sqs:send_message':
      return stripMetadata(
        await new SQSClient(config).send(
          new SendMessageCommand({ QueueUrl: target, MessageBody: String(input.body ?? '') })
        )
      );
    case 'sqs:receive_message':
      return stripMetadata(
        await new SQSClient(config).send(
          new ReceiveMessageCommand({ QueueUrl: target, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 })
        )
      );
    case 'lambda:list_functions':
      return stripMetadata(await new LambdaClient(config).send(new ListFunctionsCommand({})));
    case 'lambda:invoke': {
      const out = await new LambdaClient(config).send(
        new InvokeCommand({
          FunctionName: target,
          Payload: Buffer.from(JSON.stringify(input.event ?? {})),
        })
      );
      const { Payload, ...meta } = stripMetadata(out);
      return { ...meta, Payload: parseMaybeJson(Buffer.from(Payload || []).toString('utf-8')) };
    }
    default:
      return null;
  }
}


export interface LambdaArtifactRequest {
  envId: string;
  resourceName: string;
  runtime: string;
  handler: string;
  /** Inline handler source, used when sourceDir is empty. */
  code?: string;
  /** Folder (relative to the project) zipped as-is: handler files plus any dependencies. */
  sourceDir?: string;
}

const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');
const ZIP_EXCLUDES = new Set(['.git', '.DS_Store', '.terraform']);

/** Copies a folder, skipping VCS / OS clutter, with every mtime fixed so the zip depends on content only. */
function copyNormalized(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ZIP_EXCLUDES.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyNormalized(src, dst);
    else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
      fs.utimesSync(dst, FIXED_MTIME, FIXED_MTIME);
    }
    // symlinks are skipped: Lambda zips should be self-contained
  }
  fs.utimesSync(to, FIXED_MTIME, FIXED_MTIME);
}

/**
 * Writes <envDir>/artifacts/<name>_src and zips it to <envDir>/artifacts/<name>.zip, the file
 * main.tf points at. Identical input always gives a byte-identical zip, so source_code_hash only
 * changes when the code does. Returns an error message instead of throwing.
 */
export async function buildLambdaArtifact(
  envDir: string,
  projectDir: string,
  art: LambdaArtifactRequest
): Promise<{ zipPath?: string; error?: string }> {
  const resourceName = String(art.resourceName || '');
  if (!/^[a-z0-9_]+$/.test(resourceName)) return { error: `Invalid Lambda resource name "${resourceName}"` };

  const artDir = path.join(envDir, 'artifacts');
  const srcDir = path.join(artDir, `${resourceName}_src`);
  fs.rmSync(srcDir, { recursive: true, force: true });

  const sourceDir = String(art.sourceDir || '').trim();
  if (sourceDir) {
    const from = path.resolve(projectDir, sourceDir);
    if (from !== projectDir && !from.startsWith(projectDir + path.sep)) {
      return { error: `${resourceName}: code folder "${sourceDir}" is outside the project` };
    }
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
      return { error: `${resourceName}: code folder "${sourceDir}" does not exist` };
    }
    copyNormalized(from, srcDir);
  } else {
    fs.mkdirSync(srcDir, { recursive: true });
    // The handler setting (e.g. "dist/orders.handler") decides where the entry file lives in the zip
    const ext = String(art.runtime).startsWith('python') ? 'py' : 'mjs';
    const handlerModule = String(art.handler || 'index.handler').split('.').slice(0, -1).join('.');
    const modulePath = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(handlerModule) ? handlerModule : 'index';
    const entryFile = path.join(srcDir, `${modulePath}.${ext}`);
    fs.mkdirSync(path.dirname(entryFile), { recursive: true });
    const defaultHandlerCode =
      ext === 'py'
        ? `import json\ndef handler(event, context):\n    return {"statusCode": 200, "body": json.dumps({"ok": True, "resource": "${resourceName}", "env": "${art.envId}"})}\n`
        : `export const handler = async (event) => {\n  return {\n    statusCode: 200,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ ok: true, resource: "${resourceName}", env: "${art.envId}", event }),\n  };\n};\n`;
    fs.writeFileSync(entryFile, art.code || defaultHandlerCode, 'utf-8');
    fs.utimesSync(entryFile, FIXED_MTIME, FIXED_MTIME);
    for (let dir = path.dirname(entryFile); dir.startsWith(srcDir); dir = path.dirname(dir)) {
      fs.utimesSync(dir, FIXED_MTIME, FIXED_MTIME);
    }
  }

  const zipPath = path.join(artDir, `${resourceName}.zip`);
  fs.rmSync(zipPath, { force: true });
  const zipped = await runCommand('zip', ['-q', '-X', '-r', zipPath, '.'], { cwd: srcDir, timeout: 300000 });
  if (!zipped.ok) return { error: `${resourceName}: zip failed: ${zipped.stderr.trim()}` };
  return { zipPath };
}

export const EMULATOR_IMAGE = 'aws-emulator:local';

/** Builds the emulator image if needed and (re)starts one container on 127.0.0.1:<port>. */
export async function startEmulatorContainer(
  containerName: string,
  port: number,
  workDir: string
): Promise<{ ok: boolean; output: string; error?: string }> {
  const emulatorHostDir = emulatorDataDir();
  // The emulator writes its credentials under $HOME/.aws/emulator; with the default dir that is
  // this process's home, with an override it is the home that owns the overridden path.
  const home = path.dirname(path.dirname(emulatorHostDir));
  fs.mkdirSync(emulatorHostDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const dockerfilePath = path.join(workDir, 'Dockerfile.emulator');
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  fs.writeFileSync(
    dockerfilePath,
    `FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-${arch}.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \\
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`,
    'utf-8'
  );

  let buildLogs = '';
  const imgCheck = await runCommand('docker', ['image', 'inspect', EMULATOR_IMAGE]);
  if (!imgCheck.ok) {
    const buildRes = await runCommand('docker', ['build', '-t', EMULATOR_IMAGE, '-f', dockerfilePath, workDir], {
      timeout: 300000,
    });
    buildLogs = `${buildRes.stdout}\n${buildRes.stderr}`;
    if (!buildRes.ok) {
      return { ok: false, output: buildLogs, error: 'Docker build failed (is Docker Desktop running?)' };
    }
  }

  await runCommand('docker', ['rm', '-f', containerName]);
  // Run as the current user: the emulator writes its credentials into the mounted ~/.aws/emulator, which
  // on Linux belongs to this uid (Docker Desktop on macOS hides the mismatch, Linux doesn't)
  const asUser = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
  const runRes = await runCommand('docker', [
    'run', '-d', '--rm',
    ...asUser,
    '--name', containerName,
    '--memory=2g', '--memory-swap=2g',
    '-p', `127.0.0.1:${port}:${port}`,
    '-e', `HOME=${home}`,
    '-v', `${emulatorHostDir}:${emulatorHostDir}`,
    EMULATOR_IMAGE,
    '-p', String(port),
    '--telemetry', 'off',
  ]);
  return { ok: runRes.ok, output: (buildLogs ? `${buildLogs}\n` : '') + (runRes.stdout || runRes.stderr) };
}

/** The last lines a container logged, to explain why it isn't answering. */
export async function emulatorContainerLogs(containerName: string, lines = 40): Promise<string> {
  const res = await runCommand('docker', ['logs', '--tail', String(lines), containerName]);
  return `${res.stdout}${res.stderr}`.trim();
}

export async function stopEmulatorContainer(containerName: string) {
  return runCommand('docker', ['rm', '-f', containerName]);
}

/**
 * Known emulator gap (aws/aws-emulator#46): the emulator stores a VPC security group's default egress
 * rule without ports, so the provider's request to remove it (ports 0-0) doesn't match, and Terraform
 * marks the (existing) group tainted.
 * Returns the addresses of groups that failed only for that reason, from plain-text apply output.
 */
export function securityGroupEgressQuirks(applyOutput: string): string[] {
  const addresses = new Set<string>();
  for (const chunk of applyOutput.split(/(?=Error: )/)) {
    if (!/^Error: revoking default IPv[46] egress rule for Security Group/.test(chunk)) continue;
    if (!/InvalidPermission\.NotFound/.test(chunk)) continue;
    const addr = /\bwith (aws_security_group\.[A-Za-z0-9_-]+)/.exec(chunk)?.[1];
    if (addr) addresses.add(addr);
  }
  return [...addresses];
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The API runs terraform and docker, so only the local UI may call it: the Host must be a
 * loopback name (DNS rebinding) and a browser Origin, when sent, must match it (cross-site requests).
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host || '';
  const hostname = host.replace(/:\d+$/, '');
  if (!LOCAL_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface PlanResourceChange {
  address: string;
  type: string;
  name: string;
  actions: string[];
}

/** Reads the resource changes out of a saved plan file. */
async function readPlanChanges(envDir: string, env: NodeJS.ProcessEnv): Promise<PlanResourceChange[] | null> {
  const shown = await new Promise<string | null>((resolve) => {
    execFile(
      'terraform',
      ['show', '-json', PLAN_FILE],
      { cwd: envDir, env, maxBuffer: 256 * 1024 * 1024, timeout: 60000 },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
  if (!shown) return null;
  try {
    const parsed = JSON.parse(shown);
    return (parsed.resource_changes || [])
      .filter((rc: any) => rc?.mode !== 'data')
      .map((rc: any) => ({
        address: String(rc.address),
        type: String(rc.type),
        name: String(rc.name),
        actions: Array.isArray(rc.change?.actions) ? rc.change.actions.map(String) : [],
      }));
  } catch {
    return null;
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown> | unknown;
type ParamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: Record<string, string>
) => Promise<unknown> | unknown;
interface ParamRoute {
  method: string;
  parts: string[];
  handler: ParamHandler;
}

/** Thrown by handlers; the dispatcher turns it into a JSON error with its status. */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * When LOCALCLOUD_TOKEN is set, programmatic clients (no browser Origin — e.g. the MCP server or
 * curl) must present it as a bearer token. Same-origin browser requests stay open: the local page
 * has no way to learn the token.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.LOCALCLOUD_TOKEN;
  if (!token) return true;
  if (req.headers.origin) return true; // already gated by isLocalRequest's same-origin check
  return req.headers.authorization === `Bearer ${token}`;
}

/** Runs tail-capped at 512KB per row: applies can be chatty, the table is for audit not archive. */
const RUN_LOG_MAX_CHARS = 512 * 1024;

export function createApiMiddleware(options: { databaseUrl?: string; defaultProjectDir?: string; projectDir?: string } = {}) {
  const sql = options.databaseUrl ? createSql(options.databaseUrl) : null;
  const dbReady = sql ? new DbReady(sql) : null;
  const defaultProjectDir = options.defaultProjectDir
    ? path.resolve(options.defaultProjectDir)
    : path.resolve(options.projectDir || process.cwd());

  /** DB handle for a request; every project route needs it, so gate with a clear setup error. */
  const requireDb = (): Sql => {
    if (!sql || !dbReady) {
      throw new HttpError(
        503,
        'No database configured. Start Postgres (docker compose up -d postgres) and set DATABASE_URL, e.g. postgres://localcloud:localcloud@127.0.0.1:5432/localcloud'
      );
    }
    return sql;
  };

  const requireProject = async (db: Sql, id: string): Promise<ProjectRow> => {
    const project = await getProject(db, id);
    if (!project) throw new HttpError(404, 'Project not found');
    return project;
  };

  /** The actor tag recorded on versions/events: explicit for programmatic clients, 'ui' for the page. */
  const actorOf = (body: any): string =>
    typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 64) : 'ui';

  const recordEvent = async (
    db: Sql,
    projectId: string | null,
    actor: string,
    action: string,
    payload?: unknown
  ) => {
    await db`INSERT INTO events (project_id, actor, action, payload)
      VALUES (${projectId}, ${actor}, ${action}, ${payload === undefined ? null : JSON.stringify(payload)}::jsonb)`;
  };

  /** The project file strips presentation-only profile fields; re-merge the app defaults over the saved ones. */
  function mergeEnvironments(envs: ProjectFile['environments'] | undefined): Record<EnvironmentId, EnvironmentProfile> {
    const out = {} as Record<EnvironmentId, EnvironmentProfile>;
    for (const id of Object.keys(DEFAULT_ENVIRONMENTS) as EnvironmentId[]) {
      const saved = (envs as Record<string, unknown> | null)?.[id];
      out[id] = { ...DEFAULT_ENVIRONMENTS[id], ...(saved && typeof saved === 'object' ? saved : {}) } as EnvironmentProfile;
    }
    return out;
  }

  /** Write a compiled bundle into a working dir: .tf files, emulator scripts, deterministic Lambda zips. */
  async function writeTerraformOutput(
    target: 'emulator' | 'aws',
    project: ProjectRow,
    payload: { files: Record<string, string>; filesIfMissing?: Record<string, string>; lambdaArtifacts?: unknown[] }
  ) {
    const baseDir = path.join(project.working_dir, OUTPUT_DIRS[target]);
    fs.mkdirSync(baseDir, { recursive: true });

    const writtenFiles: string[] = [];
    const keptFiles: string[] = [];
    const writeFiles = (files: unknown, onlyIfMissing: boolean) => {
      if (!files || typeof files !== 'object') return;
      for (const [relPath, content] of Object.entries(files)) {
        const safePath = path.resolve(baseDir, relPath);
        if (!safePath.startsWith(baseDir + path.sep)) continue;
        if (onlyIfMissing && fs.existsSync(safePath)) {
          keptFiles.push(path.relative(project.working_dir, safePath));
          continue;
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, String(content), 'utf-8');
        if (relPath.endsWith('.sh')) fs.chmodSync(safePath, 0o755);
        writtenFiles.push(safePath);
      }
    };
    writeFiles(payload.files, false);
    // Files the user edits after the first export (backend settings) are created once, then left alone
    writeFiles(payload.filesIfMissing, true);

    const errors: string[] = [];
    if (Array.isArray(payload.lambdaArtifacts)) {
      for (const art of payload.lambdaArtifacts as LambdaArtifactRequest[]) {
        const envId = parseEnvId(art.envId);
        if (!envId) continue;
        const built = await buildLambdaArtifact(path.join(baseDir, 'environments', envId), project.working_dir, art);
        if (built.zipPath) writtenFiles.push(built.zipPath);
        if (built.error) errors.push(`[${envId}] ${built.error}`);
      }
    }
    return { writtenFiles, keptFiles, errors, outDir: OUTPUT_DIRS[target] };
  }

  // Routes without path parameters. The emulator endpoints are global: one container per
  // environment serves every project on that port.
  const exactRoutes: Record<string, Handler> = {
    // 1. Live health status for all environment ports
    '/api/emulator/status': async (_req, res, url) => {
      const ports = (url.searchParams.get('ports') || '9297,9298,9299,9300')
        .split(',')
        .map(parsePort)
        .filter((p): p is number => p !== null);

      const statuses: Record<number, EmulatorHealth> = {};
      await Promise.all(
        ports.map(async (port) => {
          statuses[port] = await checkEmulatorHealth(port);
        })
      );
      sendJson(res, { ok: true, statuses });
    },

    // 2. AWS Emulator container lifecycle (build / start / stop). Global: one container per env
    //    serves every project; body.projectId only routes the audit event.
    '/api/emulator/control': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      try {
        const body = await readJsonBody(req);
        const envId = parseEnvId(body.envId);
        const port = parsePort(body.port);
        if (!envId || !port) return sendJson(res, { ok: false, error: 'Invalid envId or port' }, 400);
        const action = body.action === 'stop' ? 'stop' : body.action === 'start' ? 'start' : null;
        if (!action) return sendJson(res, { ok: false, error: `Unknown action: ${body.action}` }, 400);

        // The Dockerfile.emulator build context lives with the requesting project when known
        let workDir = path.join(defaultProjectDir, OUTPUT_DIRS.emulator);
        if (typeof body.projectId === 'string' && body.projectId && sql) {
          const project = await getProject(sql, body.projectId);
          if (project) workDir = path.join(project.working_dir, OUTPUT_DIRS.emulator);
        }

        const containerName = `localcloud-aws-emulator-${envId}`;
        const result =
          action === 'stop'
            ? { ok: true, output: (await stopEmulatorContainer(containerName)).stdout }
            : await startEmulatorContainer(containerName, port, workDir).then((r) => ({
                ok: r.ok,
                output: r.output,
                error: r.error,
              }));

        if (sql && result.ok && typeof body.projectId === 'string' && body.projectId) {
          await recordEvent(sql, body.projectId, actorOf(body), `emulator.${action}`, { envId, port }).catch(() => {});
        }
        sendJson(res, { ok: result.ok, action, containerName, port, output: result.output, error: (result as any).error });
      } catch (err: any) {
        sendJson(res, { ok: false, error: err?.message }, 500);
      }
    },

    // 3. Data-plane explorer against the emulator (S3, DynamoDB, SQS, Lambda)
    '/api/emulator/explore': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      try {
        const body = await readJsonBody(req);
        const port = parsePort(body.port);
        const region = /^[a-z]{2}(-[a-z]+)+-\d$/.test(String(body.region)) ? String(body.region) : 'us-east-1';
        const input: Record<string, any> = body.input && typeof body.input === 'object' ? body.input : {};
        if (!port) return sendJson(res, { ok: false, error: 'Invalid port' }, 400);

        const health = await checkEmulatorHealth(port);
        if (!health.running) {
          return sendJson(res, {
            ok: false,
            emulatorOnline: false,
            error: `AWS Emulator is not running on port ${port}. Start it from the Run tab.`,
          });
        }

        const data = await runExplorerOperation(
          port,
          region,
          String(body.service || ''),
          String(body.operation || ''),
          String(body.target || ''),
          input
        );
        if (data === null) {
          return sendJson(res, { ok: false, error: `Unsupported operation ${body.service}:${body.operation}` }, 400);
        }
        sendJson(res, { ok: true, emulatorOnline: true, data });
      } catch (err: any) {
        sendJson(res, { ok: false, emulatorOnline: true, error: `${err?.name || 'Error'}: ${err?.message}` });
      }
    },
  };

  // Routes with path parameters. Everything that touches a design, its Terraform or its history
  // is scoped to one project row.
  const paramRoutes: ParamRoute[] = [];
  const on = (method: string, pattern: string, handler: ParamHandler) => {
    paramRoutes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  };

  on('GET', '/api/projects', async (_req, res) => {
    const db = requireDb();
    await dbReady!.once();
    // The folder the server was started in is always a project (adopting an existing
    // localcloud.json on open), so `npx localcloud-studio ./infra` keeps working.
    const defaultProject = await ensureProject(db, { workingDir: defaultProjectDir });
    const projects = await listProjects(db);
    sendJson(res, { ok: true, projects, defaultProjectId: defaultProject.id });
  });

  on('POST', '/api/projects', async (req, res) => {
    const db = requireDb();
    await dbReady!.once();
    const body = await readJsonBody(req);
    if (typeof body.workingDir !== 'string' || !body.workingDir.trim()) {
      throw new HttpError(400, 'workingDir is required (the folder for terraform-out and Lambda code)');
    }
    const project = await ensureProject(db, {
      workingDir: body.workingDir.trim(),
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
    });
    await recordEvent(db, project.id, actorOf(body), 'project.create', {
      name: project.name,
      workingDir: project.working_dir,
    });
    sendJson(res, { ok: true, project });
  });

  on('GET', '/api/projects/:id', async (_req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);
    await reconcileFile(db, project);
    const head = await getHead(db, project.id);
    if (!head) return sendJson(res, { ok: true, project, version: 0, exists: false, file: PROJECT_FILE });
    sendJson(res, { ok: true, project, version: head.version, exists: true, file: PROJECT_FILE, doc: head.doc });
  });

  on('PATCH', '/api/projects/:id', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const body = await readJsonBody(req);
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
    const renamed = await renameProject(db, params.id, body.name.trim());
    if (!renamed) throw new HttpError(404, 'Project not found');
    await recordEvent(db, renamed.id, actorOf(body), 'project.rename', { name: renamed.name });
    sendJson(res, { ok: true, project: renamed });
  });

  on('DELETE', '/api/projects/:id', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const body = await readJsonBody(req).catch(() => ({}));
    const deleted = await deleteProject(db, params.id);
    if (!deleted) throw new HttpError(404, 'Project not found');
    await recordEvent(db, null, actorOf(body), 'project.delete', { projectId: params.id });
    sendJson(res, { ok: true });
  });

  // Versioned save. baseVersion must match the head; a second writer (another tab, the MCP
  // server) makes the head move and this returns 409 with the winning document.
  on('POST', '/api/projects/:id/doc', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);
    const body = await readJsonBody(req);
    if (!isValidDoc(body.doc)) throw new HttpError(400, 'Invalid project document');
    const baseVersion = Number(body.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new HttpError(400, 'Invalid baseVersion');

    const result = await saveDoc(db, project.id, body.doc, {
      baseVersion,
      actor: actorOf(body),
      summary: typeof body.summary === 'string' ? body.summary : undefined,
    });
    if (!result.ok) {
      return sendJson(res, {
        ok: false,
        conflict: true,
        currentVersion: result.currentVersion,
        doc: result.doc,
        error: 'The project changed while you were editing. Reload to pick up the newer version.',
      }, 409);
    }
    sendJson(res, { ok: true, version: result.version, noop: result.noop, file: PROJECT_FILE });
  });

  on('GET', '/api/projects/:id/versions', async (_req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    await requireProject(db, params.id);
    sendJson(res, { ok: true, versions: await listVersions(db, params.id) });
  });

  on('GET', '/api/projects/:id/versions/:version', async (_req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    await requireProject(db, params.id);
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'Invalid version');
    const row = await getVersion(db, params.id, version);
    if (!row) throw new HttpError(404, `Version ${version} not found`);
    sendJson(res, { ok: true, version: row });
  });

  on('POST', '/api/projects/:id/versions/:version/restore', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    await requireProject(db, params.id);
    const body = await readJsonBody(req).catch(() => ({}));
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, 'Invalid version');
    const result = await restoreVersion(db, params.id, version, actorOf(body));
    if (!result.ok) throw new HttpError(409, 'Project changed while restoring; try again');
    sendJson(res, { ok: true, version: result.version });
  });

  on('GET', '/api/projects/:id/diff', async (_req, res, url, params) => {
    const db = requireDb();
    await dbReady!.once();
    await requireProject(db, params.id);
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new HttpError(400, 'from and to version numbers are required');
    const fromRow = await getVersion(db, params.id, from);
    const toRow = await getVersion(db, params.id, to);
    if (!fromRow || !toRow) throw new HttpError(404, 'Version not found');
    sendJson(res, { ok: true, diff: diffDocs(fromRow.doc, toRow.doc) });
  });

  // Server-side compile: head doc → Terraform files + Lambda zips in the project working dir.
  on('POST', '/api/projects/:id/terraform/sync', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);
    const body = await readJsonBody(req);
    const target = body.target === 'aws' ? 'aws' : 'emulator';

    const head = await getHead(db, project.id);
    if (!head) throw new HttpError(409, 'The project has no design yet. Add resources first.');

    const bundle = buildTerraformFiles(
      {
        nodes: head.doc.nodes as CloudNode[],
        edges: head.doc.edges as CloudEdge[],
        environments: mergeEnvironments(head.doc.environments),
      },
      target
    );
    const result = await writeTerraformOutput(target, project, bundle);
    await recordEvent(db, project.id, actorOf(body), 'terraform.sync', {
      target,
      written: result.writtenFiles.length,
      errors: result.errors.length,
    });
    sendJson(res, { ok: result.errors.length === 0, version: head.version, ...result, timestamp: new Date().toISOString() });
  });

  // Streaming Terraform runner, scoped to the project's working dir. Plain-text chunks,
  // terminated by "__LC_EXIT__:<code>". A successful plan also emits one "__LC_PLAN__:<json>"
  // line with its resource changes; applying a plan whose inputs changed since review emits
  // "__LC_PLAN_STALE__" and stops. `destroy: true` with `plan` makes a destroy plan.
  // One terraform run per project+env at a time: an advisory lock, and every run is recorded.
  on('POST', '/api/projects/:id/terraform/run', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      res.write('Invalid JSON body\n');
      res.end('\n__LC_EXIT__:1\n');
      return;
    }

    const envId = parseEnvId(body.envId);
    const port = parsePort(body.port);
    const command = String(body.command || 'plan');
    const region = /^[a-z]{2}(-[a-z]+)+-\d$/.test(String(body.region)) ? String(body.region) : 'us-east-1';
    const actor = actorOf(body);
    const finish = (code: number) => res.end(`\n__LC_EXIT__:${code}\n`);

    if (!envId || !port || !TERRAFORM_COMMANDS.has(command)) {
      res.write('Invalid envId, port or command\n');
      return finish(1);
    }

    const envDir = path.join(project.working_dir, OUTPUT_DIRS.emulator, 'environments', envId);
    if (!fs.existsSync(envDir)) {
      res.write(`Environment directory not found at ${envDir}. Sync first.\n`);
      return finish(1);
    }

    try {
      await withAdvisoryLock(db, `${project.id}:tf:${envId}`, async () => {
        const [run] = await db`
          INSERT INTO runs (project_id, env, command, status, actor)
          VALUES (${project.id}, ${envId}, ${command}, 'running', ${actor})
          RETURNING id
        `;
        const runId = Number(run.id);
        let log = '';
        const tee = (chunk: string | Buffer) => {
          res.write(chunk);
          log = (log + String(chunk)).slice(-RUN_LOG_MAX_CHARS);
        };
        const finishRun = async (status: string, code: number, planJson: unknown = null) => {
          await db`
            UPDATE runs SET status = ${status}, exit_code = ${code}, log = ${log},
              plan_json = ${planJson ? JSON.stringify(planJson) : null}::jsonb, finished_at = now()
            WHERE id = ${runId}
          `.catch(() => {});
        };

        const planPath = path.join(envDir, PLAN_FILE);
        const planInputsPath = path.join(envDir, PLAN_INPUTS_FILE);
        const discardPlan = () => {
          fs.rmSync(planPath, { force: true });
          fs.rmSync(planInputsPath, { force: true });
        };
        // Applying the saved plan runs exactly what was reviewed on the canvas
        const applySavedPlan = command === 'apply' && body.usePlan === true && fs.existsSync(planPath);
        if (command !== 'apply' || !applySavedPlan) discardPlan();

        // The canvas can't see inside Lambda code folders; refuse a plan whose inputs changed since review
        if (applySavedPlan) {
          const reviewed = fs.existsSync(planInputsPath) ? fs.readFileSync(planInputsPath, 'utf-8').trim() : '';
          if (reviewed !== planInputsHash(envDir)) {
            discardPlan();
            tee('The Terraform files or Lambda code changed since this plan was reviewed. Nothing was applied; plan again.\n');
            res.write('\n__LC_PLAN_STALE__\n');
            await finishRun('stale-plan', 1);
            return finish(1);
          }
        }

        const varFile = `-var-file=${envId}.tfvars`;
        const steps: string[][] = [['init', '-no-color', '-input=false']];
        if (command === 'validate') steps.push(['validate', '-no-color']);
        if (command === 'plan') {
          steps.push([
            'plan',
            ...(body.destroy === true ? ['-destroy'] : []),
            varFile,
            `-out=${PLAN_FILE}`,
            '-no-color',
            '-input=false',
          ]);
        }
        if (command === 'apply') {
          steps.push(
            applySavedPlan
              ? ['apply', '-no-color', '-input=false', PLAN_FILE]
              : ['apply', varFile, '-auto-approve', '-no-color', '-input=false']
          );
        }
        if (command === 'destroy') steps.push(['destroy', varFile, '-auto-approve', '-no-color', '-input=false']);

        const awsEnv = getEmulatorAwsEnv(port, region);
        let active: ReturnType<typeof spawn> | null = null;
        let aborted = false;
        res.on('close', () => {
          aborted = true;
          active?.kill('SIGINT');
        });

        let applyOutput = '';
        for (const args of steps) {
          if (aborted) {
            await finishRun('aborted', 130);
            return;
          }
          tee(`$ terraform ${args.join(' ')}\n`);
          const code = await new Promise<number>((resolve) => {
            const child = spawn('terraform', args, { cwd: envDir, env: awsEnv });
            active = child;
            const forward = (chunk: Buffer) => {
              tee(chunk);
              if (args[0] === 'apply') applyOutput += chunk.toString();
            };
            child.stdout.on('data', forward);
            child.stderr.on('data', forward);
            child.on('error', (err) => {
              tee(`${err.message}\n`);
              resolve(127);
            });
            child.on('close', (c) => resolve(c ?? 1));
          });
          active = null;
          if (code !== 0) {
            if (command === 'apply') {
              discardPlan();
              const quirks = securityGroupEgressQuirks(applyOutput);
              for (const addr of quirks) {
                const untainted = await runCommand('terraform', ['untaint', '-no-color', addr], { cwd: envDir, env: awsEnv });
                tee(
                  untainted.ok
                    ? `\nNote: ${addr} exists, but an emulator bug (aws/aws-emulator#46) made Terraform mark it failed. LocalCloud marked it usable again. Apply again to create the rest.\n`
                    : `\nCould not untaint ${addr}: ${untainted.stderr.trim()}\n`
                );
              }
            }
            await finishRun('failed', code);
            return finish(code);
          }
        }

        let planChanges: PlanResourceChange[] | null = null;
        if (command === 'plan') {
          fs.writeFileSync(planInputsPath, planInputsHash(envDir));
          planChanges = await readPlanChanges(envDir, awsEnv);
          if (planChanges) res.write(`\n__LC_PLAN__:${JSON.stringify(planChanges)}\n`);
        }
        if (command === 'apply') discardPlan();
        await finishRun('succeeded', 0, planChanges);
        finish(0);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (err instanceof BusyError) {
        res.write(`Another terraform run for ${envId} is already active. Wait for it to finish and try again.\n`);
        return finish(1);
      }
      if (!res.headersSent) {
        res.removeHeader('Content-Type');
        sendJson(res, { ok: false, error: message }, 500);
      } else {
        res.write(`${message}\n`);
        finish(1);
      }
    }
  });

  // What exists in an environment, from its local Terraform state: resources and outputs.
  // Read straight from terraform.tfstate, so it works without terraform or a running emulator.
  on('GET', '/api/projects/:id/terraform/state', async (_req, res, url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);
    const envId = parseEnvId(url.searchParams.get('envId'));
    if (!envId) return sendJson(res, { ok: false, error: 'Invalid envId' }, 400);

    const statePath = path.join(project.working_dir, OUTPUT_DIRS.emulator, 'environments', envId, 'terraform.tfstate');
    if (!fs.existsSync(statePath)) return sendJson(res, { ok: true, exists: false, resources: [], outputs: {} });
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const resources = (state.resources || [])
        .filter((r: any) => r?.mode === 'managed' && Array.isArray(r.instances) && r.instances.length > 0)
        .map((r: any) => ({ type: String(r.type), name: String(r.name) }));
      const outputs = Object.fromEntries(
        Object.entries<any>(state.outputs || {}).map(([name, out]) => [
          name,
          out?.sensitive ? '(sensitive)' : typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value),
        ])
      );
      sendJson(res, { ok: true, exists: true, resources, outputs });
    } catch (err: any) {
      sendJson(res, { ok: false, error: `Could not read ${envId} state: ${err?.message}` });
    }
  });

  // One headless design mutation: load head, apply the op (canvas rules enforced), save as a new
  // version. The MCP server's design tools and any programmatic client use exactly this path.
  on('POST', '/api/projects/:id/ops', async (req, res, _url, params) => {
    const db = requireDb();
    await dbReady!.once();
    const project = await requireProject(db, params.id);
    const body = await readJsonBody(req);
    const op = String(body.op || '');
    if (!op) throw new HttpError(400, 'op is required');

    // These ops can start a design from nothing; everything else needs an existing one
    const SEED_OPS = new Set(['resource.add', 'template.apply', 'import.terraform']);
    const head = await getHead(db, project.id);
    if (!head && !SEED_OPS.has(op)) {
      throw new HttpError(409, 'The project has no design yet. Start with template_apply, import_terraform or resource_add.');
    }
    const baseDoc: ProjectFile = head?.doc ?? {
      version: '2.0.0',
      environments: {} as ProjectFile['environments'],
      nodes: [],
      edges: [],
    };

    const outcome = applyDesignOp(op, baseDoc, (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>);
    if (!outcome.ok) throw new HttpError(outcome.status ?? 400, outcome.error);

    if (opMutates(op)) {
      const actor = actorOf(body);
      const saved = await saveDoc(db, project.id, outcome.doc, { baseVersion: head?.version ?? 0, actor, summary: op });
      if (!saved.ok) throw new HttpError(409, 'The project changed while applying this operation; retry it');
      await recordEvent(db, project.id, actor, `design.${op}`, body.args ?? {}).catch(() => {});
      return sendJson(res, { ok: true, version: saved.version, result: outcome.result });
    }
    sendJson(res, { ok: true, version: head?.version ?? 0, result: outcome.result });
  });

  // The catalog as data: services with their field schemas, blueprint ids, emulator support.
  // tfExpression functions are not serializable; output names are.
  on('GET', '/api/catalog', async (_req, res) => {
    sendJson(res, {
      ok: true,
      categories: AWS_CATEGORIES,
      templates: ARCHITECTURE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, subtitle: t.subtitle, description: t.description })),
      services: AWS_SERVICES_CATALOG.map((svc) => ({
        typeId: svc.typeId,
        name: svc.name,
        shortName: svc.shortName,
        category: svc.category,
        description: svc.description,
        terraformResourceType: svc.terraformResourceType,
        isContainer: svc.isContainer ?? false,
        emulatorSupport: emulatorSupport(svc).level,
        fields: svc.schema.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          defaultValue: f.defaultValue,
          description: f.description,
          options: f.options?.map((o) => o.value),
          group: f.group,
          envConfigurable: f.envConfigurable ?? false,
        })),
        outputs: svc.outputs.map((o) => o.name),
      })),
    });
  });

  return function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {    const url = new URL(req.url || '', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    if (!isLocalRequest(req) || !isAuthorized(req)) return sendJson(res, { ok: false, error: 'Forbidden' }, 403);

    const respond = (err: unknown) => {
      if (err instanceof HttpError && !res.headersSent) return sendJson(res, { ok: false, error: err.message }, err.status);
      if (!res.headersSent) sendJson(res, { ok: false, error: (err as any)?.message || 'Internal error' }, 500);
      else res.end();
    };

    const exact = exactRoutes[url.pathname];
    if (exact) return void Promise.resolve(exact(req, res, url)).catch(respond);

    const parts = url.pathname.split('/').filter(Boolean);
    for (const route of paramRoutes) {
      if (route.method !== req.method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i++) {
        const pattern = route.parts[i];
        if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(parts[i]);
        else if (pattern !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      return void Promise.resolve(route.handler(req, res, url, params)).catch(respond);
    }
    sendJson(res, { ok: false, error: 'Not found' }, 404);
  };
}
