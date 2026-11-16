import { describe, expect, it } from 'vitest';
import { diffDocs } from '../server/services/projectStore';
import type { ProjectFile } from '../src/utils/projectFile';
import { nodeFor } from './fixtures';

const doc = (patch: Partial<ProjectFile> = {}): ProjectFile => ({
  version: '2.0.0',
  environments: { dev: { region: 'us-east-1' }, prod: { region: 'us-west-2' } } as never,
  nodes: [nodeFor('aws_lambda_function', 'api', { memory_size: 256 }), nodeFor('aws_dynamodb_table', 'orders')],
  edges: [{ id: 'e1', source: 'n-api', target: 'n-orders', data: { relationshipType: 'iam_grant' } }],
  ...patch,
});

describe('diffDocs', () => {
  it('lists each changed value with its before and after', () => {
    const a = doc();
    const b = doc();
    b.nodes[0].data.baseConfig.memory_size = 1024;
    b.nodes[0].data.envOverrides = { prod: { timeout: 60 } };
    b.nodes[0].data.envEnabled = { ...b.nodes[0].data.envEnabled, dev: false };
    const changed = diffDocs(a, b).nodes.changed[0];
    expect(changed.label).toBe('api');
    expect(changed.fields).toEqual(
      expect.arrayContaining([
        { field: 'memory_size', from: 256, to: 1024 },
        { field: 'timeout', env: 'prod', from: undefined, to: 60 },
        { field: 'deployed', env: 'dev', from: true, to: false },
      ])
    );
  });

  it('treats a missing on/off entry as on', () => {
    const a = doc();
    const b = doc();
    b.nodes[0].data.envEnabled = {};
    a.nodes[0].data.envEnabled = { dev: true };
    expect(diffDocs(a, b).nodes.changed).toEqual([]);
  });

  it('names connections by their ends, and reports environments and scenarios', () => {
    const b = doc({
      edges: [],
      environments: { dev: { region: 'eu-west-1' }, prod: { region: 'us-west-2' }, qa: {} } as never,
      scenarios: [{ id: 's1', name: 'smoke', steps: [] }],
    });
    const diff = diffDocs(doc(), b);
    expect(diff.edges.removed).toEqual([expect.objectContaining({ sourceLabel: 'api', targetLabel: 'orders' })]);
    expect(diff.environmentChanges).toEqual([
      { id: 'dev', change: 'changed', fields: [{ field: 'region', from: 'us-east-1', to: 'eu-west-1' }] },
      { id: 'qa', change: 'added', fields: [] },
    ]);
    expect(diff.environments).toEqual(['dev', 'qa']);
    expect(diff.scenarios.added).toEqual(['smoke']);
  });
});

describe('summarizeDiff', () => {
  it('says what a change did in one line', async () => {
    const { summarizeDiff } = await import('../server/services/projectStore');
    const a = doc();
    const b = doc();
    b.nodes[0].data.baseConfig.memory_size = 1024;
    expect(summarizeDiff(diffDocs(a, b))).toBe('Changed memory_size on api');

    const c = doc();
    c.nodes[0].data.label = 'Orders API';
    expect(summarizeDiff(diffDocs(a, c))).toBe('Renamed api to Orders API');

    const d = doc({ edges: [], environments: { ...a.environments, qa: {} } as never });
    expect(summarizeDiff(diffDocs(a, d))).toBe('Disconnected api from orders; Added environment qa');
    expect(summarizeDiff(diffDocs(a, doc()))).toBe('Rearranged the canvas');
  });
});
