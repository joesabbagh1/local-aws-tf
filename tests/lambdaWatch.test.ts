import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLambdaWatcher, type LambdaWatchDeps } from '../server/services/lambdaWatch';
import type { CloudNode } from '../src/types/cloud';
import { nodeFor } from './fixtures';

/** A watcher over an in-memory design, recording what it would push. */
function setup(nodes: CloudNode[], overrides: Partial<LambdaWatchDeps> = {}) {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-watch-'));
  const design = { nodes, workingDir };
  const pushed: { functionName: string; zip: string }[] = [];
  const built: string[] = [];
  let locked = false;
  const watcher = createLambdaWatcher({
    loadDesign: async () => design,
    buildArtifact: async (envDir, _projectDir, art) => {
      built.push(art.resourceName);
      const zipPath = path.join(envDir, 'artifacts', `${art.resourceName}.zip`);
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      fs.writeFileSync(zipPath, `zip of ${art.sourceDir || art.code}`);
      return { zipPath };
    },
    updateCode: async (_port, _region, functionName, zip) => {
      pushed.push({ functionName, zip: zip.toString() });
    },
    withEnvLock: async (_p, _e, fn) => {
      if (locked) return false;
      await fn();
      return true;
    },
    intervalMs: 60_000,
    ...overrides,
  });
  return {
    watcher,
    design,
    pushed,
    built,
    workingDir,
    setLocked: (value: boolean) => {
      locked = value;
    },
  };
}

const fn = (name: string, data: Partial<CloudNode['data']> = {}) => {
  const node = nodeFor('aws_lambda_function', name);
  Object.assign(node.data, data);
  return node;
};

describe('Lambda watch mode', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => cleanup?.());

  it('pushes inline code that changes, and nothing on the first look', async () => {
    const t = setup([fn('orders', { inlineCode: 'v1' }), fn('other', { inlineCode: 'same' })]);
    cleanup = () => t.watcher.stopAll();
    t.watcher.start('p1', 'dev', 9297, 'us-east-1');
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toEqual([]);

    t.design.nodes = t.design.nodes.map((n) => (n.data.resourceName === 'orders' ? { ...n, data: { ...n.data, inlineCode: 'v2' } } : n));
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toEqual([{ functionName: 'lc-dev-orders', zip: 'zip of v2' }]);
    expect(t.built).toEqual(['orders']);

    const [status] = t.watcher.status('p1');
    expect(status).toMatchObject({ envId: 'dev', port: 9297 });
    expect(status.updates[0]).toMatchObject({ label: 'orders', functionName: 'lc-dev-orders', ok: true });
  });

  it('pushes a code folder when a file in it changes', async () => {
    const t = setup([]);
    cleanup = () => t.watcher.stopAll();
    fs.mkdirSync(path.join(t.workingDir, 'fn', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(t.workingDir, 'fn', 'index.mjs'), 'export const handler = () => 1;\n');
    t.design.nodes = [fn('worker', { sourceDir: 'fn' })];
    t.watcher.start('p1', 'dev', 9297, 'us-east-1');
    await t.watcher.check('p1', 'dev');

    // Inside node_modules: not looked at, for speed
    fs.writeFileSync(path.join(t.workingDir, 'fn', 'node_modules', 'dep', 'x.js'), '1');
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toEqual([]);

    fs.appendFileSync(path.join(t.workingDir, 'fn', 'index.mjs'), '// edited\n');
    await t.watcher.check('p1', 'dev');
    expect(t.pushed.map((p) => p.functionName)).toEqual(['lc-dev-worker']);
  });

  it('waits while Terraform holds the environment, then pushes', async () => {
    const t = setup([fn('orders', { inlineCode: 'v1' })]);
    cleanup = () => t.watcher.stopAll();
    t.watcher.start('p1', 'dev', 9297, 'us-east-1');
    await t.watcher.check('p1', 'dev');
    t.design.nodes = [fn('orders', { inlineCode: 'v2' })];

    t.setLocked(true);
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toEqual([]);

    t.setLocked(false);
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toHaveLength(1);
  });

  it('says when a function is not deployed, and does not retry until the code changes again', async () => {
    let calls = 0;
    const t = setup([fn('orders', { inlineCode: 'v1' })], {
      updateCode: async () => {
        calls++;
        throw Object.assign(new Error('Function not found'), { name: 'ResourceNotFoundException' });
      },
    });
    cleanup = () => t.watcher.stopAll();
    t.watcher.start('p1', 'dev', 9297, 'us-east-1');
    await t.watcher.check('p1', 'dev');
    t.design.nodes = [fn('orders', { inlineCode: 'v2' })];
    await t.watcher.check('p1', 'dev');
    await t.watcher.check('p1', 'dev');
    expect(calls).toBe(1);
    expect(t.watcher.status('p1')[0].updates[0]).toMatchObject({ ok: false, error: 'lc-dev-orders is not deployed in dev. Apply first.' });
  });

  it('skips functions switched off in the environment, and stops per environment', async () => {
    const off = fn('orders', { inlineCode: 'v1' });
    off.data.envEnabled = { ...off.data.envEnabled, dev: false };
    const t = setup([off]);
    cleanup = () => t.watcher.stopAll();
    t.watcher.start('p1', 'dev', 9297, 'us-east-1');
    t.watcher.start('p1', 'prod', 9300, 'eu-west-1');
    await t.watcher.check('p1', 'dev');
    t.design.nodes = [{ ...off, data: { ...off.data, inlineCode: 'v2' } }];
    await t.watcher.check('p1', 'dev');
    expect(t.pushed).toEqual([]);

    t.watcher.stop('p1', 'dev');
    expect(t.watcher.status('p1').map((w) => w.envId)).toEqual(['prod']);
  });
});
