#!/usr/bin/env node
// Runs `terraform validate` on every golden Terraform root in tests/golden/<blueprint>/<env>/.
// Usage: node scripts/validate-golden.mjs [filter]   e.g. "serverless" or "vpc-ecs-rds-ha/prod"
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenRoot = path.join(repoRoot, 'tests', 'golden');
const filter = process.argv[2] || '';

// One shared provider download instead of one per directory
const pluginCache =
  process.env.TF_PLUGIN_CACHE_DIR || path.join(repoRoot, 'node_modules', '.cache', 'terraform-plugins');
fs.mkdirSync(pluginCache, { recursive: true });
const env = { ...process.env, TF_PLUGIN_CACHE_DIR: pluginCache, TF_IN_AUTOMATION: '1' };

const roots = fs
  .readdirSync(goldenRoot)
  .flatMap((blueprint) =>
    fs.readdirSync(path.join(goldenRoot, blueprint)).map((envId) => `${blueprint}/${envId}`)
  )
  .filter((rel) => rel.includes(filter))
  .sort();

if (roots.length === 0) {
  console.error(`No golden directories match "${filter}"`);
  process.exit(1);
}

const terraform = (cwd, args) =>
  execFileSync('terraform', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

let failed = 0;
for (const rel of roots) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localcloud-golden-'));
  try {
    fs.cpSync(path.join(goldenRoot, rel), workDir, { recursive: true });

    // main.tf hashes its Lambda zips at validate time; any file at that path will do
    const mainTf = fs.readFileSync(path.join(workDir, 'main.tf'), 'utf-8');
    for (const [, zipPath] of mainTf.matchAll(/filename\s*=\s*"(artifacts\/[^"]+\.zip)"/g)) {
      fs.mkdirSync(path.dirname(path.join(workDir, zipPath)), { recursive: true });
      fs.writeFileSync(path.join(workDir, zipPath), 'placeholder');
    }

    terraform(workDir, ['init', '-backend=false', '-input=false', '-no-color']);
    terraform(workDir, ['validate', '-no-color']);
    console.log(`ok    ${rel}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${rel}`);
    console.log(String(err.stdout || '') + String(err.stderr || err.message));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

console.log(`\n${roots.length - failed}/${roots.length} golden Terraform roots are valid`);
process.exit(failed ? 1 : 0);
