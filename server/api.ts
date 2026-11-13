import { execFile, spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { S3Client, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, ListTablesCommand, ScanCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, ListQueuesCommand, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, ListFunctionsCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/**
 * Local API used by the UI: emulator control, Terraform runner, project file and data explorer.
 * Mounted by the Vite dev server (vite.config.ts) and by the standalone CLI (server/cli.ts).
 */

export const PROJECT_FILE = 'localcloud.json';
const PLAN_FILE = '.localcloud.tfplan';

const ENV_IDS = new Set(['dev', 'testing', 'staging', 'prod']);
const TERRAFORM_COMMANDS = new Set(['init', 'validate', 'plan', 'apply', 'destroy']);

type EmulatorHealth = { running: boolean; status: string; caExists: boolean };

function checkEmulatorHealth(port: number): Promise<EmulatorHealth> {
  return new Promise((resolve) => {
    const caPath = path.join(os.homedir(), '.aws', 'emulator', String(port), 'ca.pem');
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

function getEmulatorAwsEnv(port: number, region = 'us-east-1'): NodeJS.ProcessEnv {
  const home = os.homedir();
  const baseDir = path.join(home, '.aws', 'emulator', String(port));
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
  const baseDir = path.join(os.homedir(), '.aws', 'emulator', String(port));
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

export function createApiMiddleware(options: { projectDir?: string } = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const OUT_DIR = path.join(projectDir, 'terraform-out');
  const projectFilePath = path.join(projectDir, PROJECT_FILE);

  const routes: Record<string, Handler> = {
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

    // 2. Project file: the canvas saved next to the Terraform it generates
    '/api/project': async (req, res) => {
      if (req.method === 'GET') {
        if (!fs.existsSync(projectFilePath)) {
          return sendJson(res, { ok: true, exists: false, file: PROJECT_FILE, projectDir });
        }
        try {
          const project = JSON.parse(fs.readFileSync(projectFilePath, 'utf-8'));
          return sendJson(res, { ok: true, exists: true, file: PROJECT_FILE, projectDir, project });
        } catch (err: any) {
          return sendJson(res, { ok: false, exists: true, file: PROJECT_FILE, error: `${PROJECT_FILE} is not valid JSON: ${err?.message}` });
        }
      }
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      try {
        const body = await readJsonBody(req);
        const project = body.project;
        if (!project || !Array.isArray(project.nodes) || !Array.isArray(project.edges)) {
          return sendJson(res, { ok: false, error: 'Invalid project' }, 400);
        }
        // Write-then-rename so a crash mid-write never leaves a truncated project file
        const tmpPath = `${projectFilePath}.tmp`;
        fs.writeFileSync(tmpPath, `${JSON.stringify(project, null, 2)}\n`, 'utf-8');
        fs.renameSync(tmpPath, projectFilePath);
        sendJson(res, { ok: true, file: PROJECT_FILE });
      } catch (err: any) {
        sendJson(res, { ok: false, error: err?.message || 'Failed to save project' }, 500);
      }
    },

    // 3. Write Terraform files + package Lambda zip artifacts
    '/api/terraform/export': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      try {
        const payload = await readJsonBody(req);
        fs.mkdirSync(OUT_DIR, { recursive: true });

        const writtenFiles: string[] = [];
        if (payload.files && typeof payload.files === 'object') {
          for (const [relPath, content] of Object.entries(payload.files)) {
            const safePath = path.resolve(OUT_DIR, relPath);
            if (!safePath.startsWith(OUT_DIR + path.sep)) continue;
            fs.mkdirSync(path.dirname(safePath), { recursive: true });
            fs.writeFileSync(safePath, String(content), 'utf-8');
            if (relPath.endsWith('.sh')) fs.chmodSync(safePath, 0o755);
            writtenFiles.push(safePath);
          }
        }

        if (Array.isArray(payload.lambdaArtifacts)) {
          for (const art of payload.lambdaArtifacts) {
            const envId = parseEnvId(art.envId);
            const resourceName = String(art.resourceName || '');
            if (!envId || !/^[a-z0-9_]+$/.test(resourceName)) continue;

            const artDir = path.join(OUT_DIR, 'environments', envId, 'artifacts');
            const srcDir = path.join(artDir, `${resourceName}_src`);
            fs.rmSync(srcDir, { recursive: true, force: true });
            fs.mkdirSync(srcDir, { recursive: true });

            // The handler setting (e.g. "dist/orders.handler") decides where the entry file lives in the zip
            const ext = String(art.runtime).startsWith('python') ? 'py' : 'mjs';
            const handlerModule = String(art.handler || 'index.handler').split('.').slice(0, -1).join('.');
            const modulePath =
              /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(handlerModule) ? handlerModule : 'index';
            const entryFile = path.join(srcDir, `${modulePath}.${ext}`);
            fs.mkdirSync(path.dirname(entryFile), { recursive: true });
            const defaultHandlerCode =
              ext === 'py'
                ? `import json\ndef handler(event, context):\n    return {"statusCode": 200, "body": json.dumps({"ok": True, "resource": "${resourceName}", "env": "${envId}"})}\n`
                : `export const handler = async (event) => {\n  return {\n    statusCode: 200,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ ok: true, resource: "${resourceName}", env: "${envId}", event }),\n  };\n};\n`;

            fs.writeFileSync(entryFile, art.code || defaultHandlerCode, 'utf-8');
            // A fixed mtime and no extra attributes keep the zip byte-identical for identical code,
            // so source_code_hash only changes when the handler does
            const epoch = new Date('2000-01-01T00:00:00Z');
            fs.utimesSync(entryFile, epoch, epoch);
            for (let dir = path.dirname(entryFile); dir.startsWith(srcDir); dir = path.dirname(dir)) {
              fs.utimesSync(dir, epoch, epoch);
            }
            const zipPath = path.join(artDir, `${resourceName}.zip`);
            fs.rmSync(zipPath, { force: true });
            await runCommand('zip', ['-q', '-X', '-r', zipPath, '.'], { cwd: srcDir });
            writtenFiles.push(zipPath);
          }
        }

        sendJson(res, { ok: true, outDir: OUT_DIR, writtenFiles, timestamp: new Date().toISOString() });
      } catch (err: any) {
        sendJson(res, { ok: false, error: err?.message || 'Failed to write Terraform files' }, 500);
      }
    },

    // 4. AWS Emulator container lifecycle (build / start / stop)
    '/api/emulator/control': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      try {
        const body = await readJsonBody(req);
        const envId = parseEnvId(body.envId);
        const port = parsePort(body.port);
        if (!envId || !port) return sendJson(res, { ok: false, error: 'Invalid envId or port' }, 400);

        const containerName = `localcloud-aws-emulator-${envId}`;
        const home = os.homedir();
        const emulatorHostDir = path.join(home, '.aws', 'emulator');
        fs.mkdirSync(emulatorHostDir, { recursive: true });

        if (body.action === 'stop') {
          const result = await runCommand('docker', ['rm', '-f', containerName]);
          return sendJson(res, { ok: true, action: 'stop', output: result.stdout || result.stderr });
        }

        if (body.action !== 'start') {
          return sendJson(res, { ok: false, error: `Unknown action: ${body.action}` }, 400);
        }

        fs.mkdirSync(OUT_DIR, { recursive: true });
        const dockerfilePath = path.join(OUT_DIR, 'Dockerfile.emulator');
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
        const imgCheck = await runCommand('docker', ['image', 'inspect', 'aws-emulator:local']);
        if (!imgCheck.ok) {
          const buildRes = await runCommand(
            'docker',
            ['build', '-t', 'aws-emulator:local', '-f', dockerfilePath, OUT_DIR],
            { timeout: 300000 }
          );
          buildLogs = `${buildRes.stdout}\n${buildRes.stderr}`;
          if (!buildRes.ok) {
            return sendJson(res, {
              ok: false,
              error: 'Docker build failed (is Docker Desktop running?)',
              output: buildLogs,
            });
          }
        }

        await runCommand('docker', ['rm', '-f', containerName]);
        const runRes = await runCommand('docker', [
          'run', '-d', '--rm',
          '--name', containerName,
          '--memory=2g', '--memory-swap=2g',
          '-p', `127.0.0.1:${port}:${port}`,
          '-e', `HOME=${home}`,
          '-v', `${emulatorHostDir}:${emulatorHostDir}`,
          'aws-emulator:local',
          '-p', String(port),
          '--telemetry', 'off',
        ]);

        sendJson(res, {
          ok: runRes.ok,
          containerName,
          port,
          output: (buildLogs ? `${buildLogs}\n` : '') + (runRes.stdout || runRes.stderr),
        });
      } catch (err: any) {
        sendJson(res, { ok: false, error: err?.message }, 500);
      }
    },

    // 5. Streaming Terraform runner. Plain-text chunks, terminated by "__LC_EXIT__:<code>".
    //    A successful plan also emits one "__LC_PLAN__:<json>" line with its resource changes.
    '/api/terraform/run': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { ok: false, error: 'Method not allowed' }, 405);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const finish = (code: number) => res.end(`\n__LC_EXIT__:${code}\n`);

      let body: any;
      try {
        body = await readJsonBody(req);
      } catch {
        res.write('Invalid JSON body\n');
        return finish(1);
      }

      const envId = parseEnvId(body.envId);
      const port = parsePort(body.port);
      const command = String(body.command || 'plan');
      const region = /^[a-z]{2}(-[a-z]+)+-\d$/.test(String(body.region)) ? String(body.region) : 'us-east-1';
      if (!envId || !port || !TERRAFORM_COMMANDS.has(command)) {
        res.write('Invalid envId, port or command\n');
        return finish(1);
      }

      const envDir = path.join(OUT_DIR, 'environments', envId);
      if (!fs.existsSync(envDir)) {
        res.write(`Environment directory not found at ${envDir}. Sync first.\n`);
        return finish(1);
      }

      const planPath = path.join(envDir, PLAN_FILE);
      // Applying the saved plan runs exactly what was reviewed on the canvas
      const applySavedPlan = command === 'apply' && body.usePlan === true && fs.existsSync(planPath);
      if (command !== 'apply' || !applySavedPlan) fs.rmSync(planPath, { force: true });

      const varFile = `-var-file=${envId}.tfvars`;
      const steps: string[][] = [['init', '-no-color', '-input=false']];
      if (command === 'validate') steps.push(['validate', '-no-color']);
      if (command === 'plan') steps.push(['plan', varFile, `-out=${PLAN_FILE}`, '-no-color', '-input=false']);
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

      for (const args of steps) {
        if (aborted) return;
        res.write(`$ terraform ${args.join(' ')}\n`);
        const code = await new Promise<number>((resolve) => {
          const child = spawn('terraform', args, { cwd: envDir, env: awsEnv });
          active = child;
          child.stdout.on('data', (chunk) => res.write(chunk));
          child.stderr.on('data', (chunk) => res.write(chunk));
          child.on('error', (err) => {
            res.write(`${err.message}\n`);
            resolve(127);
          });
          child.on('close', (c) => resolve(c ?? 1));
        });
        active = null;
        if (code !== 0) {
          if (command === 'apply') fs.rmSync(planPath, { force: true });
          return finish(code);
        }
      }

      if (command === 'plan') {
        const changes = await readPlanChanges(envDir, awsEnv);
        if (changes) res.write(`\n__LC_PLAN__:${JSON.stringify(changes)}\n`);
      }
      if (command === 'apply') fs.rmSync(planPath, { force: true });
      finish(0);
    },

    // 6. Terraform outputs for an applied environment
    '/api/terraform/outputs': async (_req, res, url) => {
      const envId = parseEnvId(url.searchParams.get('envId'));
      if (!envId) return sendJson(res, { ok: false, error: 'Invalid envId' }, 400);

      const result = await runCommand('terraform', ['output', '-json'], {
        cwd: path.join(OUT_DIR, 'environments', envId),
      });
      try {
        sendJson(res, { ok: result.ok, outputs: JSON.parse(result.stdout || '{}') });
      } catch {
        sendJson(res, { ok: false, error: result.stderr });
      }
    },

    // 7. Data-plane explorer against the emulator (S3, DynamoDB, SQS, Lambda)
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

  return function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url || '', 'http://localhost');
    const handler = routes[url.pathname];
    if (!handler) return url.pathname.startsWith('/api/') ? sendJson(res, { ok: false, error: 'Not found' }, 404) : next();
    if (!isLocalRequest(req)) return sendJson(res, { ok: false, error: 'Forbidden' }, 403);

    Promise.resolve(handler(req, res, url)).catch((err) => {
      if (!res.headersSent) sendJson(res, { ok: false, error: err?.message || 'Internal error' }, 500);
      else res.end();
    });
  };
}
