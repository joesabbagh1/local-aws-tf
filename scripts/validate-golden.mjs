#!/usr/bin/env node
// Runs `terraform validate` on every golden Terraform root in tests/golden/<target>/<blueprint>/<env>/.
// Usage: node scripts/validate-golden.mjs [filter]   e.g. "aws/" or "vpc-ecs-rds-ha/prod"
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenRoot = path.join(repoRoot, 'tests', 'golden');
const filter = process.argv[2] || '';
const CONCURRENCY = Number(process.env.VALIDATE_CONCURRENCY) || 4;

// One shared provider download instead of one per directory
const pluginCache =
  process.env.TF_PLUGIN_CACHE_DIR || path.join(repoRoot, 'node_modules', '.cache', 'terraform-plugins');
fs.mkdirSync(pluginCache, { recursive: true });
const env = { ...process.env, TF_PLUGIN_CACHE_DIR: pluginCache, TF_IN_AUTOMATION: '1' };

const subdirs = (dir) => fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
const roots = subdirs(goldenRoot)
  .flatMap((target) =>
    subdirs(path.join(goldenRoot, target)).flatMap((blueprint) =>
      subdirs(path.join(goldenRoot, target, blueprint)).map((envId) => `${target}/${blueprint}/${envId}`)
    )
  )
  .filter((rel) => rel.includes(filter))
  .sort();

if (roots.length === 0) {
  console.error(`No golden directories match "${filter}"`);
  process.exit(1);
}

const terraform = (cwd, args) => execFileAsync('terraform', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });

// Every root pins the same provider, so install it once and share it; `validate` only reads it,
// which is safe in parallel (concurrent `init` runs against one plugin cache are not)
const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localcloud-provider-'));
const firstRoot = path.join(goldenRoot, roots[0]);
fs.copyFileSync(path.join(firstRoot, 'provider.tf'), path.join(providerDir, 'provider.tf'));
fs.writeFileSync(path.join(providerDir, 'variables.tf'), 'variable "aws_region" {}\nvariable "default_tags" {}\n');
try {
  await terraform(providerDir, ['init', '-backend=false', '-input=false', '-no-color']);
} catch (err) {
  console.error(`terraform init failed:\n${err.stderr || err.message}`);
  process.exit(1);
}

async function validate(rel) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localcloud-golden-'));
  try {
    fs.cpSync(path.join(goldenRoot, rel), workDir, { recursive: true });
    fs.symlinkSync(path.join(providerDir, '.terraform'), path.join(workDir, '.terraform'));
    fs.copyFileSync(path.join(providerDir, '.terraform.lock.hcl'), path.join(workDir, '.terraform.lock.hcl'));

    // main.tf hashes its Lambda zips at validate time; any file at that path will do
    const mainTf = fs.readFileSync(path.join(workDir, 'main.tf'), 'utf-8');
    for (const [, zipPath] of mainTf.matchAll(/filename\s*=\s*"(artifacts\/[^"]+\.zip)"/g)) {
      fs.mkdirSync(path.dirname(path.join(workDir, zipPath)), { recursive: true });
      fs.writeFileSync(path.join(workDir, zipPath), 'placeholder');
    }

    await terraform(workDir, ['validate', '-no-color']);
    return { rel, ok: true };
  } catch (err) {
    return { rel, ok: false, output: String(err.stdout || '') + String(err.stderr || err.message) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const results = [];
const queue = [...roots];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let rel = queue.shift(); rel; rel = queue.shift()) results.push(await validate(rel));
  })
);
fs.rmSync(providerDir, { recursive: true, force: true });

results.sort((a, b) => a.rel.localeCompare(b.rel));
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.rel}`);
  if (!r.ok) console.log(r.output);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${roots.length - failed}/${roots.length} golden Terraform roots are valid`);
process.exit(failed ? 1 : 0);
