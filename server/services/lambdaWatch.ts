import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudNode, EnvironmentId } from '../../src/types/cloud';
import { resolveNodeConfigForEnv, sanitizeIdentifier } from '../../src/utils/terraformCompiler';
import { liveResourceName } from '../../src/utils/terraformNames';

/**
 * Lambda watch mode: while it is on for an environment, a function whose code changes (its code
 * folder, or the inline code on the canvas) is re-zipped and pushed to that environment's emulator
 * with UpdateFunctionCode a second later, without a plan. Only code: a change to the runtime,
 * handler, memory or anything else still needs Apply.
 *
 * It polls instead of using fs.watch: projects are often bind-mounted into the app's container,
 * where file events don't arrive reliably.
 */

export interface WatchUpdate {
  nodeId: string;
  label: string;
  functionName: string;
  at: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface WatchStatus {
  envId: EnvironmentId;
  port: number;
  since: string;
  updates: WatchUpdate[];
}

export interface LambdaWatchDeps {
  /** The project's current design and working dir, or null when it no longer exists. */
  loadDesign: (projectId: string) => Promise<{ nodes: CloudNode[]; workingDir: string } | null>;
  /** Zips one Lambda into <envDir>/artifacts/<name>.zip, the file Terraform deploys. */
  buildArtifact: (
    envDir: string,
    projectDir: string,
    art: { envId: string; resourceName: string; runtime: string; handler: string; code?: string; sourceDir?: string }
  ) => Promise<{ zipPath?: string; error?: string }>;
  updateCode: (port: number, region: string, functionName: string, zip: Buffer) => Promise<void>;
  /** Runs `fn` holding the environment's Terraform lock; resolves false (without running it) when a run holds it. */
  withEnvLock: (projectId: string, envId: EnvironmentId, fn: () => Promise<void>) => Promise<boolean>;
  onUpdate?: (projectId: string, envId: EnvironmentId, update: WatchUpdate) => void;
  intervalMs?: number;
}

const KEEP_UPDATES = 10;

/** Changes when anything that goes into the zip changes. node_modules counts by its own mtime only: walking it every second is too slow. */
export function codeFingerprint(node: CloudNode, envId: EnvironmentId, projectDir: string): string {
  const cfg = resolveNodeConfigForEnv(node, envId);
  const hash = crypto.createHash('sha256');
  hash.update(`${cfg.runtime ?? ''}\u0000${cfg.handler ?? ''}\u0000`);
  const sourceDir = String(node.data.sourceDir || '').trim();
  if (!sourceDir) {
    hash.update(`inline\u0000${node.data.inlineCode || ''}`);
    return hash.digest('hex');
  }
  const root = path.resolve(projectDir, sourceDir);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      hash.update(`missing:${dir}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      hash.update(`${path.relative(root, full)}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000`);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
    }
  };
  walk(root);
  return hash.digest('hex');
}

export function createLambdaWatcher(deps: LambdaWatchDeps) {
  interface Watch extends WatchStatus {
    projectId: string;
    region: string;
    timer: ReturnType<typeof setInterval>;
    busy: boolean;
    /** The tick in flight, so a check can wait for it. */
    pending: Promise<void>;
    fingerprints: Map<string, string>;
  }
  const watches = new Map<string, Watch>();
  const keyOf = (projectId: string, envId: EnvironmentId) => `${projectId}:${envId}`;

  async function tick(watch: Watch) {
    if (watch.busy) return;
    watch.busy = true;
    try {
      const design = await deps.loadDesign(watch.projectId);
      if (!design) {
        stop(watch.projectId, watch.envId);
        return;
      }
      const lambdas = design.nodes.filter(
        (n) => n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[watch.envId] !== false
      );
      const changed: { node: CloudNode; fingerprint: string }[] = [];
      for (const node of lambdas) {
        const fingerprint = codeFingerprint(node, watch.envId, design.workingDir);
        const before = watch.fingerprints.get(node.id);
        // The first look is the baseline: watching doesn't redeploy code that was already applied
        if (before === undefined) watch.fingerprints.set(node.id, fingerprint);
        else if (before !== fingerprint) changed.push({ node, fingerprint });
      }
      if (changed.length === 0) return;

      // Never while Terraform runs for this environment: it may be zipping or applying the same file. Retried next tick.
      await deps.withEnvLock(watch.projectId, watch.envId, async () => {
        const envDir = path.join(design.workingDir, 'terraform-out', 'environments', watch.envId);
        for (const { node, fingerprint } of changed) {
          const started = Date.now();
          const cfg = resolveNodeConfigForEnv(node, watch.envId);
          const functionName = liveResourceName(node, watch.envId);
          let error: string | undefined;
          try {
            const built = await deps.buildArtifact(envDir, design.workingDir, {
              envId: watch.envId,
              resourceName: sanitizeIdentifier(node.data.resourceName || node.data.label),
              runtime: String(cfg.runtime || 'nodejs20.x'),
              handler: String(cfg.handler || 'index.handler'),
              code: node.data.inlineCode,
              sourceDir: node.data.sourceDir,
            });
            if (built.error || !built.zipPath) throw new Error(built.error || 'no zip was built');
            await deps.updateCode(watch.port, watch.region, functionName, fs.readFileSync(built.zipPath));
          } catch (err: any) {
            error = /ResourceNotFound/.test(String(err?.name)) ? `${functionName} is not deployed in ${watch.envId}. Apply first.` : String(err?.message || err);
          }
          // Recorded either way: a failed update is retried on the next change, not every second
          watch.fingerprints.set(node.id, fingerprint);
          const update: WatchUpdate = {
            nodeId: node.id,
            label: node.data.label,
            functionName,
            at: new Date().toISOString(),
            ok: !error,
            durationMs: Date.now() - started,
            ...(error ? { error } : {}),
          };
          watch.updates = [update, ...watch.updates].slice(0, KEEP_UPDATES);
          deps.onUpdate?.(watch.projectId, watch.envId, update);
        }
      });
    } catch {
      // A database or file hiccup: try again next tick
    } finally {
      watch.busy = false;
    }
  }

  function start(projectId: string, envId: EnvironmentId, port: number, region: string): WatchStatus {
    stop(projectId, envId);
    const watch: Watch = {
      projectId,
      envId,
      port,
      region,
      since: new Date().toISOString(),
      updates: [],
      busy: false,
      fingerprints: new Map(),
      pending: Promise.resolve(),
      timer: setInterval(() => {
        watch.pending = tick(watch);
      }, deps.intervalMs ?? 1000),
    };
    watch.timer.unref?.();
    watches.set(keyOf(projectId, envId), watch);
    watch.pending = tick(watch);
    return publicStatus(watch);
  }

  function stop(projectId: string, envId?: EnvironmentId) {
    for (const [key, watch] of watches) {
      if (watch.projectId !== projectId || (envId && watch.envId !== envId)) continue;
      clearInterval(watch.timer);
      watches.delete(key);
    }
  }

  const publicStatus = (w: Watch): WatchStatus => ({ envId: w.envId, port: w.port, since: w.since, updates: w.updates });

  return {
    start,
    stop,
    status: (projectId: string): WatchStatus[] => [...watches.values()].filter((w) => w.projectId === projectId).map(publicStatus),
    /** Runs one check now (tests). */
    check: async (projectId: string, envId: EnvironmentId) => {
      const watch = watches.get(keyOf(projectId, envId));
      if (!watch) return;
      await watch.pending;
      watch.pending = tick(watch);
      await watch.pending;
    },
    stopAll: () => [...watches.values()].forEach((w) => stop(w.projectId)),
  };
}
