import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTestArgs, runTestCommand } from '../server/testCommand';
import { nodeFor } from './fixtures';

describe('localcloud-studio test', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses environments, scenarios, the port and flags', () => {
    const args = parseTestArgs(['infra', '--env', 'dev,staging', '--scenario', 'A', '--scenario=B', '--port=9500', '--keep', '--verbose']);
    expect(args).toMatchObject({
      projectDir: path.resolve('infra'),
      envs: ['dev', 'staging'],
      scenarios: ['A', 'B'],
      port: 9500,
      keep: true,
      verbose: true,
    });
    expect(parseTestArgs([])).toMatchObject({ envs: [], scenarios: [], port: 9398, keep: false });
  });

  it('refuses unknown options, missing values and bad ports with the usage', () => {
    expect(parseTestArgs(['--nope'])).toMatch(/^Unknown option: --nope[\s\S]*Usage:/);
    expect(parseTestArgs(['--env'])).toMatch(/^--env needs a value/);
    expect(parseTestArgs(['--port', '80'])).toMatch(/--port must be/);
  });

  it('exits 2 without running anything when the project, environment or scenario is not there', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-testcmd-'));
    expect(await runTestCommand([dir])).toBe(2);

    const bucket = nodeFor('aws_s3_bucket', 'uploads');
    fs.writeFileSync(
      path.join(dir, 'localcloud.json'),
      JSON.stringify({ version: '2.0.0', nodes: [bucket], edges: [], scenarios: [{ id: 'sc-1', name: 'Round trip', steps: [] }] })
    );
    expect(await runTestCommand([dir, '--env', 'qa'])).toBe(2);
    expect(await runTestCommand([dir, '--scenario', 'Other'])).toBe(2);
    expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^No localcloud.json in /),
      'The project has no environment "qa". It has: dev, testing, staging, prod.',
      expect.stringMatching(/^No scenario named "Other"/),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
