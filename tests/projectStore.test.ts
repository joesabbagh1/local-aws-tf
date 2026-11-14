import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSql, migrate, type Sql } from '../server/db';
import {
  PROJECT_FILE,
  deleteProject,
  diffDocs,
  ensureProject,
  getHead,
  listVersions,
  reconcileFile,
  restoreVersion,
  saveDoc,
  type ProjectFile,
} from '../server/services/projectStore';

/**
 * projectStore against a real Postgres. Requires DATABASE_URL (docker compose up -d postgres);
 * skipped entirely when it is not set so plain `npm test` stays usable without a database.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('projectStore', () => {
  let sql: Sql;
  let workingDir: string;
  let projectId: string;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await migrate(sql);
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-project-'));
    const project = await ensureProject(sql, { workingDir, name: 'test-project' });
    projectId = project.id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM projects WHERE id = ${projectId}`.catch(() => {});
      await sql.end();
    }
  });

  const docWithLabel = (label: string): ProjectFile =>
    ({
      version: '2.0.0',
      environments: {},
      nodes: [
        {
          id: 'n1',
          type: 'awsNode',
          position: { x: 0, y: 0 },
          data: {
            label,
            resourceName: 'api',
            serviceType: 'aws_lambda_function',
            baseConfig: {},
            envOverrides: {},
            envEnabled: { dev: true, testing: true, staging: true, prod: true },
            tags: {},
          },
        },
      ],
      edges: [],
    }) as unknown as ProjectFile;

  it('creates a project row and its working dir idempotently', async () => {
    const again = await ensureProject(sql, { workingDir });
    expect(again.id).toBe(projectId);
    expect(fs.existsSync(workingDir)).toBe(true);
  });

  it('saves versions with optimistic concurrency and dedupes no-op saves', async () => {
    const first = await saveDoc(sql, projectId, docWithLabel('v1'), { baseVersion: 0, actor: 'ui' });
    expect(first).toEqual({ ok: true, version: 1, noop: false });

    const sameAgain = await saveDoc(sql, projectId, docWithLabel('v1'), { baseVersion: 1, actor: 'ui' });
    expect(sameAgain).toEqual({ ok: true, version: 1, noop: true });

    const second = await saveDoc(sql, projectId, docWithLabel('v2'), { baseVersion: 1, actor: 'mcp:test' });
    expect(second).toEqual({ ok: true, version: 2, noop: false });

    // A writer on a stale base version gets the conflict plus the winning document
    const stale = await saveDoc(sql, projectId, docWithLabel('loser'), { baseVersion: 1, actor: 'ui' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.currentVersion).toBe(2);
      expect(stale.doc.nodes[0].data.label).toBe('v2');
    }

    // Only real saves become version rows
    const versions = await listVersions(sql, projectId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].actor).toBe('mcp:test');
  });

  it('materializes localcloud.json into the working dir on every save', async () => {
    const head = await getHead(sql, projectId);
    expect(head?.version).toBe(2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(workingDir, PROJECT_FILE), 'utf-8'));
    expect(onDisk.nodes[0].data.label).toBe('v2');
  });

  it('folds an externally changed file back in as an import version', async () => {
    const external = docWithLabel('from-git-pull');
    fs.writeFileSync(path.join(workingDir, PROJECT_FILE), JSON.stringify(external, null, 2) + '\n');
    const row = {
      id: projectId,
      name: 'test-project',
      working_dir: workingDir,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const version = await reconcileFile(sql, row);
    expect(version).toBe(3);
    const head = await getHead(sql, projectId);
    expect(head?.doc.nodes[0].data.label).toBe('from-git-pull');
    expect(head?.actor).toBe('import');
  });

  it('restores by appending a copy, never rewriting history', async () => {
    const restored = await restoreVersion(sql, projectId, 1, 'ui');
    expect(restored.ok).toBe(true);
    const head = await getHead(sql, projectId);
    expect(head?.version).toBe(4);
    expect(head?.doc.nodes[0].data.label).toBe('v1');
    // the original v1 row is untouched
    const versions = await listVersions(sql, projectId);
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('diffs two versions structurally', () => {
    const a = docWithLabel('v1');
    const b = docWithLabel('v2');
    b.nodes.push({
      id: 'n2',
      type: 'awsNode',
      position: { x: 10, y: 10 },
      data: { label: 'Table', resourceName: 'table', serviceType: 'aws_dynamodb_table', baseConfig: {}, envOverrides: {}, envEnabled: {}, tags: {} },
    } as never);
    const diff = diffDocs(a, b);
    expect(diff.nodes.added.map((n) => n.id)).toEqual(['n2']);
    expect(diff.nodes.changed.map((n) => n.id)).toEqual(['n1']);
    expect(diff.nodes.changed[0].changes).toContain('name');
  });

  it('deletes a project with its history', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-gone-'));
    const temp = await ensureProject(sql, { workingDir: gone, name: 'gone' });
    await saveDoc(sql, temp.id, docWithLabel('x'), { baseVersion: 0, actor: 'ui' });
    expect(await deleteProject(sql, temp.id)).toBe(true);
    expect(await getHead(sql, temp.id)).toBeNull();
  });
});
