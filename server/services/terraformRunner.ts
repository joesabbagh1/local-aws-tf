import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { alreadyExisting, blockedDeletes, failedIds, securityGroupEgressQuirks, unimplementedDeletes } from './emulatorQuirks';

/**
 * Runs Terraform against an emulator and works around the emulator gaps LocalCloud knows. Shared
 * by the app's runner (POST /api/projects/:id/terraform/run) and `localcloud-studio test`, so both
 * behave the same.
 */

/** Runs a binary with an argument list (no shell), so request values can never be interpreted as shell syntax. */
export function runCommand(
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

/** One environment's Terraform folder, the emulator credentials to run it with, and where its output goes. */
export interface TerraformSession {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `-var-file=<env>.tfvars` */
  varFile: string;
  write: (chunk: string | Buffer) => void;
  aborted?: () => boolean;
  /** The terraform process currently running (null once it exits), so the caller can stop it. */
  onChild?: (child: ChildProcess | null) => void;
}

/** Runs one terraform command, streaming its output; resolves to its exit code and output. */
export async function runTerraform(session: TerraformSession, args: string[]): Promise<{ code: number; output: string }> {
  session.write(`$ terraform ${args.join(' ')}\n`);
  let output = '';
  const code = await new Promise<number>((resolve) => {
    const child = spawn('terraform', args, { cwd: session.cwd, env: session.env });
    session.onChild?.(child);
    const forward = (chunk: Buffer) => {
      session.write(chunk);
      output += chunk.toString();
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      session.write(`${err.message}\n`);
      resolve(127);
    });
    child.on('close', (c) => resolve(c ?? 1));
  });
  session.onChild?.(null);
  return { code, output };
}

/**
 * Resources a destroy dropped from Terraform state because the emulator couldn't delete them (or
 * what they still held). They live on in the emulator until it restarts, so a later destroy knows
 * what is holding things, and a later apply takes them back with `terraform import`.
 */
export const LEFT_IN_EMULATOR_FILE = '.localcloud.left-in-emulator.json';

export type LeftInEmulator = { address: string; id?: string };

export function readLeftInEmulator(envDir: string): LeftInEmulator[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(envDir, LEFT_IN_EMULATOR_FILE), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.address === 'string') : [];
  } catch {
    return [];
  }
}

export function writeLeftInEmulator(envDir: string, entries: LeftInEmulator[]) {
  const file = path.join(envDir, LEFT_IN_EMULATOR_FILE);
  if (entries.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * After a failed apply or destroy, works around the emulator gaps LocalCloud knows, then finishes
 * the job with more runs. Returns the new exit code, or null when no workaround applied. The
 * progress lines it prints use Terraform's wording so the canvas updates those resources.
 */
export async function recoverFromEmulatorGaps(
  session: TerraformSession,
  kind: 'apply' | 'destroy' | null,
  output: string
): Promise<number | null> {
  const { cwd: envDir, env, varFile, write: tee } = session;
  const aborted = () => session.aborted?.() ?? false;
  if (aborted() || !kind) return null;

  if (kind === 'destroy') {
    const leftovers = unimplementedDeletes(output);
    // Left behind by an earlier destroy: then what fails as "in use" is held by those
    const earlier = readLeftInEmulator(envDir);
    const held = earlier.length > 0 ? blockedDeletes(output) : [];
    if (leftovers.length === 0 && held.length === 0) return null;

    const forget = async (entry: LeftInEmulator, why: string) => {
      const removed = await runCommand('terraform', ['state', 'rm', '-no-color', entry.address], { cwd: envDir, env });
      if (!removed.ok) {
        tee(`\nCould not remove ${entry.address} from state: ${removed.stderr.trim()}\n`);
        return false;
      }
      tee(`\n${entry.address}: Destruction complete (removed from Terraform state: ${why}; restarting the emulator clears it)\n`);
      const left = readLeftInEmulator(envDir).filter((e) => e.address !== entry.address);
      writeLeftInEmulator(envDir, [...left, { address: entry.address, ...(entry.id ? { id: entry.id } : {}) }]);
      return true;
    };
    for (const leftover of leftovers) {
      if (!(await forget(leftover, `the emulator has no ${leftover.operation}, aws/aws-emulator#355`))) return null;
    }
    const stuck = [...earlier, ...leftovers].map((l) => l.address).join(', ');
    const inUse = `still in use by ${stuck}, which the emulator can't delete`;
    for (const entry of held) {
      if (!(await forget(entry, inUse))) return null;
    }
    // What the undeletable resources still use can't be deleted either (a subnet group, then its subnets and VPC)
    let code = 1;
    for (let round = 0; round < 5 && !aborted(); round++) {
      tee('\nLocalCloud is destroying the rest.\n');
      const step = await runTerraform(session, ['destroy', varFile, '-auto-approve', '-no-color', '-input=false']);
      code = step.code;
      if (code === 0) break;
      const next = [...unimplementedDeletes(step.output), ...blockedDeletes(step.output)];
      if (next.length === 0) break;
      for (const entry of next) {
        if (!(await forget(entry, inUse))) return code;
      }
    }
    return code;
  }

  let out = output;
  let code: number | null = null;
  const adoptedIds = new Set<string>();
  let settled = false;
  for (let round = 0; round < 5 && !aborted(); round++) {
    const tainted = securityGroupEgressQuirks(out);
    // Left in the emulator by an earlier destroy, under the same id: take it back instead of failing
    const left = readLeftInEmulator(envDir);
    const existing = alreadyExisting(out);
    const adopt = left.filter((e) => e.id && existing.includes(e.id));
    if (tainted.length === 0 && adopt.length === 0) {
      // The first update of a resource taken back can fail on arguments import can't read (the provider
      // re-sends a Redis auth token strategy the emulator rejects); the state is right after it, so once more
      const failed = failedIds(out);
      if (settled || adoptedIds.size === 0 || failed.length === 0 || !failed.every((id) => adoptedIds.has(id))) return code;
      settled = true;
    }

    for (const address of tainted) {
      const untainted = await runCommand('terraform', ['untaint', '-no-color', address], { cwd: envDir, env });
      if (!untainted.ok) {
        tee(`\nCould not untaint ${address}: ${untainted.stderr.trim()}\n`);
        return code;
      }
      tee(`\n${address}: Creation complete (an emulator bug, aws/aws-emulator#46, made Terraform mark it failed; LocalCloud marked it usable)\n`);
    }
    for (const entry of adopt) {
      const imported = await runCommand('terraform', ['import', varFile, '-no-color', '-input=false', entry.address, entry.id!], { cwd: envDir, env });
      if (!imported.ok) {
        tee(`\nCould not take ${entry.address} back from the emulator: ${imported.stderr.trim()}\n`);
        return code;
      }
      writeLeftInEmulator(envDir, readLeftInEmulator(envDir).filter((e) => e.address !== entry.address));
      adoptedIds.add(entry.id!);
      tee(`\n${entry.address}: Creation complete (taken back from the emulator, where an earlier destroy had to leave it)\n`);
    }
    // Same Terraform files as the first pass, so this only does what it couldn't
    tee('\nLocalCloud is applying again to finish the rest.\n');
    const step = await runTerraform(session, ['apply', varFile, '-auto-approve', '-no-color', '-input=false']);
    code = step.code;
    out = step.output;
    if (code === 0) return 0;
  }
  return code;
}
