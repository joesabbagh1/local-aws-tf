import fs from 'node:fs';
import path from 'node:path';

export const E2E_PORT = 4399;
export const E2E_PROJECT_DIR = path.resolve('node_modules/.cache/localcloud/e2e-project');

/**
 * Resets the project the server works in: the folder (no saved canvas, a Lambda code folder, dev
 * state) and its rows in Postgres, so every test starts from a version-0 project again.
 */
export async function resetProject() {
  const databaseUrl = process.env.DATABASE_URL || 'postgres://localcloud:localcloud@127.0.0.1:5432/localcloud';
  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(databaseUrl, { connect_timeout: 5, max: 1 });
    await sql`DELETE FROM projects WHERE working_dir = ${E2E_PROJECT_DIR}`;
    await sql.end();
  } catch {
    // Server startup will surface an unreachable database with its own error
  }

  fs.rmSync(E2E_PROJECT_DIR, { recursive: true, force: true });
  const fn = path.join(E2E_PROJECT_DIR, 'functions', 'orders');
  fs.mkdirSync(path.join(fn, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(fn, 'index.mjs'), 'import pad from "left-pad";\nexport const handler = async () => pad("ok", 5);\n');
  fs.writeFileSync(path.join(fn, 'node_modules', 'left-pad', 'index.js'), 'export default (s, n) => s.padStart(n);\n');

  // As if dev had been applied earlier: the orders Lambda (and its role) exist, with one output
  const devDir = path.join(E2E_PROJECT_DIR, 'terraform-out', 'environments', 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  const resource = (type: string, name: string) => ({
    mode: 'managed',
    type,
    name,
    provider: 'provider["registry.terraform.io/hashicorp/aws"]',
    instances: [{ schema_version: 0, attributes: { id: name } }],
  });
  fs.writeFileSync(
    path.join(devDir, 'terraform.tfstate'),
    JSON.stringify({
      version: 4,
      terraform_version: '1.10.5',
      serial: 1,
      lineage: 'e2e',
      outputs: {
        orders_api_handler_lambda_arn: { value: 'arn:aws:lambda:us-east-1:000000000000:function:lc-dev-orders_api_handler', type: 'string' },
      },
      resources: [resource('aws_lambda_function', 'orders_api_handler'), resource('aws_iam_role', 'orders_api_handler_exec_role')],
    })
  );
}

export const projectFile = () => JSON.parse(fs.readFileSync(path.join(E2E_PROJECT_DIR, 'localcloud.json'), 'utf-8'));
