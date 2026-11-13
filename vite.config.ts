import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';

function checkEmulatorHealth(port: number): Promise<{ running: boolean; status: string; caExists: boolean }> {
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

function readJsonBody(req: any): Promise<any> {
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

function runShellCommand(
  cmd: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
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

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-cloud-emulator-api',
      configureServer(server) {
        // 1. Live Health Status for all 4 environment ports
        server.middlewares.use('/api/emulator/status', async (req, res) => {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const portsParam = url.searchParams.get('ports') || '9297,9298,9299,9300';
            const ports = portsParam
              .split(',')
              .map((p) => parseInt(p.trim(), 10))
              .filter((p) => !isNaN(p));

            const statuses: Record<number, { running: boolean; status: string; caExists: boolean }> = {};
            await Promise.all(
              ports.map(async (port) => {
                statuses[port] = await checkEmulatorHealth(port);
              })
            );

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, statuses }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err?.message || 'Error checking status' }));
          }
        });

        // 2. Export Terraform files + package Lambda zip artifacts
        server.middlewares.use('/api/terraform/export', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
            return;
          }

          try {
            const payload = await readJsonBody(req);
            const outDir = path.resolve(process.cwd(), 'terraform-out');
            fs.mkdirSync(outDir, { recursive: true });

            const writtenFiles: string[] = [];
            if (payload.files && typeof payload.files === 'object') {
              for (const [relPath, content] of Object.entries(payload.files)) {
                const safePath = path.resolve(outDir, relPath);
                if (!safePath.startsWith(outDir)) continue;
                fs.mkdirSync(path.dirname(safePath), { recursive: true });
                fs.writeFileSync(safePath, String(content), 'utf-8');
                if (relPath.endsWith('.sh')) {
                  fs.chmodSync(safePath, 0o755);
                }
                writtenFiles.push(safePath);
              }
            }

            // Package any Lambda function artifacts into .zip files in each environment folder
            if (Array.isArray(payload.lambdaArtifacts)) {
              for (const art of payload.lambdaArtifacts) {
                const { envId, resourceName, runtime, code } = art;
                const envDir = path.join(outDir, 'environments', envId);
                const artDir = path.join(envDir, 'artifacts');
                const srcDir = path.join(artDir, `${resourceName}_src`);
                fs.mkdirSync(srcDir, { recursive: true });

                const ext = String(runtime).startsWith('python') ? 'py' : 'mjs';
                const entryFile = path.join(srcDir, `index.${ext}`);
                const defaultHandlerCode =
                  ext === 'py'
                    ? `import json\ndef handler(event, context):\n    return {"statusCode": 200, "body": json.dumps({"ok": True, "resource": "${resourceName}", "env": "${envId}"})}\n`
                    : `export const handler = async (event) => {\n  return {\n    statusCode: 200,\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ ok: true, resource: "${resourceName}", env: "${envId}", event }),\n  };\n};\n`;

                fs.writeFileSync(entryFile, code || defaultHandlerCode, 'utf-8');
                const zipPath = path.join(artDir, `${resourceName}.zip`);
                await runShellCommand(`zip -j -q "${zipPath}" "${entryFile}"`, {
                  cwd: srcDir,
                });
                writtenFiles.push(zipPath);
              }
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: true,
                outDir,
                writtenFiles,
                timestamp: new Date().toISOString(),
              })
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err?.message || 'Failed to write Terraform files' }));
          }
        });

        // 3. One-Click AWS Emulator Container Lifecycle Manager (build / start / stop)
        server.middlewares.use('/api/emulator/control', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
            return;
          }

          try {
            const { action, envId = 'dev', port = 9297 } = await readJsonBody(req);
            const containerName = `localcloud-aws-emulator-${envId}`;
            const home = os.homedir();
            const emulatorHostDir = path.join(home, '.aws', 'emulator');
            fs.mkdirSync(emulatorHostDir, { recursive: true });

            if (action === 'stop') {
              const result = await runShellCommand(`docker rm -f ${containerName}`);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, action, output: result.stdout || result.stderr }));
              return;
            }

            if (action === 'start') {
              // Ensure Dockerfile.emulator exists
              const outDir = path.resolve(process.cwd(), 'terraform-out');
              fs.mkdirSync(outDir, { recursive: true });
              const dockerfilePath = path.join(outDir, 'Dockerfile.emulator');
              const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
              const dockerfileContent = `FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-${arch}.rpm /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \\
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE ${port}
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
`;
              fs.writeFileSync(dockerfilePath, dockerfileContent, 'utf-8');

              // Check if image exists; if not, build it
              const imgCheck = await runShellCommand(`docker image inspect aws-emulator:local`);
              let buildLogs = '';
              if (!imgCheck.ok) {
                const buildRes = await runShellCommand(
                  `docker build -t aws-emulator:local -f "${dockerfilePath}" "${outDir}"`,
                  { timeout: 180000 }
                );
                buildLogs = buildRes.stdout + '\n' + buildRes.stderr;
                if (!buildRes.ok) {
                  res.setHeader('Content-Type', 'application/json');
                  res.end(
                    JSON.stringify({
                      ok: false,
                      error: 'Docker build failed (is Docker Desktop running?)',
                      output: buildLogs,
                    })
                  );
                  return;
                }
              }

              // Remove any stopped container with same name, then run
              await runShellCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
              const runCmd = `docker run -d --rm --name ${containerName} --memory=2g --memory-swap=2g -p 127.0.0.1:${port}:${port} -e HOME="${home}" -v "${emulatorHostDir}:${emulatorHostDir}" aws-emulator:local -p ${port} --telemetry off`;
              const runRes = await runShellCommand(runCmd);

              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: runRes.ok,
                  containerName,
                  port,
                  output: (buildLogs ? buildLogs + '\n' : '') + (runRes.stdout || runRes.stderr),
                })
              );
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err?.message }));
          }
        });

        // 4. Live Terraform Runner (init / validate / plan / apply / destroy)
        server.middlewares.use('/api/terraform/run', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
            return;
          }

          try {
            const { command = 'plan', envId = 'dev', port = 9297, region = 'us-east-1' } =
              await readJsonBody(req);
            const envDir = path.resolve(process.cwd(), 'terraform-out', 'environments', envId);

            if (!fs.existsSync(envDir)) {
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Environment directory not found at ${envDir}. Click "Sync Terraform" first.`,
                })
              );
              return;
            }

            const awsEnv = getEmulatorAwsEnv(port, region);
            let cmdStr = '';
            if (command === 'init') {
              cmdStr = 'terraform init -no-color';
            } else if (command === 'validate') {
              cmdStr = 'terraform validate -no-color';
            } else if (command === 'plan') {
              cmdStr = `terraform init -no-color && terraform plan -var-file="${envId}.tfvars" -no-color`;
            } else if (command === 'apply') {
              cmdStr = `terraform init -no-color && terraform apply -var-file="${envId}.tfvars" -auto-approve -no-color`;
            } else if (command === 'destroy') {
              cmdStr = `terraform destroy -var-file="${envId}.tfvars" -auto-approve -no-color`;
            } else {
              res.end(JSON.stringify({ ok: false, error: 'Unsupported terraform command' }));
              return;
            }

            const result = await runShellCommand(cmdStr, {
              cwd: envDir,
              env: awsEnv,
              timeout: 120000,
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: result.ok,
                code: result.code,
                command: cmdStr,
                cwd: envDir,
                output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
              })
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err?.message }));
          }
        });

        // 5. Live Data-Plane Resource Explorer against AWS Emulator (S3, DynamoDB, SQS, Lambda)
        server.middlewares.use('/api/emulator/explore', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
            return;
          }

          try {
            const {
              port = 9297,
              region = 'us-east-1',
              service,
              operation,
              resourceIdentifier,
              payload,
            } = await readJsonBody(req);

            const health = await checkEmulatorHealth(port);
            const awsEnv = getEmulatorAwsEnv(port, region);

            let cliCmd = '';
            if (service === 's3') {
              if (operation === 'list_buckets') {
                cliCmd = 'aws s3api list-buckets --output json';
              } else if (operation === 'list_objects') {
                cliCmd = `aws s3api list-objects-v2 --bucket "${resourceIdentifier}" --output json`;
              } else if (operation === 'create_bucket') {
                cliCmd = `aws s3api create-bucket --bucket "${resourceIdentifier}" --output json`;
              }
            } else if (service === 'dynamodb') {
              if (operation === 'list_tables') {
                cliCmd = 'aws dynamodb list-tables --output json';
              } else if (operation === 'scan') {
                cliCmd = `aws dynamodb scan --table-name "${resourceIdentifier}" --max-items 25 --output json`;
              } else if (operation === 'put_item' && payload) {
                const escapedItem = JSON.stringify(payload).replace(/'/g, "'\\''");
                cliCmd = `aws dynamodb put-item --table-name "${resourceIdentifier}" --item '${escapedItem}' --output json`;
              }
            } else if (service === 'sqs') {
              if (operation === 'list_queues') {
                cliCmd = 'aws sqs list-queues --output json';
              } else if (operation === 'send_message') {
                const msg = typeof payload === 'string' ? payload : JSON.stringify(payload || { ping: 'hello' });
                cliCmd = `aws sqs send-message --queue-url "${resourceIdentifier}" --message-body '${msg.replace(/'/g, '')}' --output json`;
              } else if (operation === 'receive_message') {
                cliCmd = `aws sqs receive-message --queue-url "${resourceIdentifier}" --max-number-of-messages 5 --output json`;
              }
            } else if (service === 'lambda') {
              if (operation === 'list_functions') {
                cliCmd = 'aws lambda list-functions --output json';
              } else if (operation === 'invoke') {
                const outFile = path.join(os.tmpdir(), `lc-lambda-out-${Date.now()}.json`);
                const eventStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
                cliCmd = `aws lambda invoke --function-name "${resourceIdentifier}" --payload '${eventStr.replace(/'/g, '')}' "${outFile}" --output json && cat "${outFile}"`;
              }
            }

            if (!cliCmd) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, error: 'Unsupported service operation' }));
              return;
            }

            if (!health.running) {
              // Provide simulated local preview response + exact AWS CLI command when emulator container isn't started yet
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  ok: true,
                  emulatorOnline: false,
                  cliCommand: `AWS_ENDPOINT_URL=https://127.0.0.1:${port} ${cliCmd}`,
                  simulatedResponse: {
                    _note: `AWS Emulator on port ${port} is currently in standby. Start the emulator container or run the CLI command above once active.`,
                    service,
                    operation,
                    target: resourceIdentifier,
                    timestamp: new Date().toISOString(),
                  },
                })
              );
              return;
            }

            const execRes = await runShellCommand(cliCmd, { env: awsEnv, timeout: 15000 });
            let parsedData: any = execRes.stdout;
            try {
              parsedData = JSON.parse(execRes.stdout);
            } catch {
              // keep raw string
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                ok: execRes.ok,
                emulatorOnline: true,
                cliCommand: cliCmd,
                data: parsedData,
                stderr: execRes.stderr,
              })
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: err?.message }));
          }
        });
      },
    },
  ],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
