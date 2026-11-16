import { describe, expect, it } from 'vitest';
import { applyDesignOp } from '../server/services/designOps';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import type { ProjectFile } from '../src/utils/projectFile';
import { IMPORT_FIXTURE_HCL, nodeFor } from './fixtures';

/** A minimal valid design document the ops mutate. */
function doc(nodes: ProjectFile['nodes'] = [], edges: ProjectFile['edges'] = []): ProjectFile {
  return {
    version: '2.0.0',
    environments: Object.fromEntries(
      Object.entries(DEFAULT_ENVIRONMENTS).map(([id, { color: _c, badgeClass: _b, ...profile }]) => [id, profile])
    ) as ProjectFile['environments'],
    nodes,
    edges,
  };
}

const lambda = () => nodeFor('aws_lambda_function', 'handler');

describe('applyDesignOp', () => {
  it('adds a resource with catalog defaults, numbering, and optional parent nesting', () => {
    const base = doc([lambda()]);
    const added = applyDesignOp('resource.add', base, { type: 'aws_sqs_queue', name: 'Orders' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const node = added.doc.nodes.find((n) => n.data.label === 'Orders')!;
    expect(node.data.baseConfig).toHaveProperty('visibility_timeout_seconds'); // catalog default present
    expect(node.data.resourceName).toBe('orders');
    expect(added.doc.nodes).toHaveLength(2);
  });

  it('sets and changes a connection\'s access level, and refuses one that does not apply', () => {
    const fn = lambda();
    const table = nodeFor('aws_dynamodb_table', 'orders');
    const topic = nodeFor('aws_sns_topic', 'alerts');
    const created = applyDesignOp('connection.create', doc([fn, table, topic]), { from: fn.id, to: table.id, access: 'read' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = (created.result as { id: string }).id;
    expect(created.doc.edges[0].data?.access).toBe('read');

    const changed = applyDesignOp('connection.configure', created.doc, { id, access: 'write', label: 'orders' });
    expect(changed.ok && changed.doc.edges[0].data).toMatchObject({ access: 'write', label: 'orders' });
    if (!changed.ok) return;
    const cleared = applyDesignOp('connection.configure', changed.doc, { id, access: null });
    expect(cleared.ok && cleared.doc.edges[0].data?.access).toBeUndefined();
    const relabelled = applyDesignOp('connection.configure', changed.doc, { id, label: 'x' });
    expect(relabelled.ok && relabelled.doc.edges[0].data?.access).toBe('write');

    const bad = applyDesignOp('connection.configure', created.doc, { id, access: 'admin' });
    expect(!bad.ok && bad.error).toBe('access must be one of read (Read), write (Write), readwrite (Read and write)');
    const none = applyDesignOp('connection.create', doc([fn, topic]), { from: fn.id, to: topic.id, access: 'read' });
    expect(!none.ok && none.error).toMatch(/no access levels to choose/);
  });

  it('refuses unknown service types and unknown fields, naming the valid ones', () => {
    const bad = applyDesignOp('resource.add', doc(), { type: 'aws_nope' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toMatch(/Unknown service type aws_nope/);

    const deprecated = applyDesignOp('resource.add', doc(), { type: 'aws_bedrock_agent' });
    expect(deprecated.ok).toBe(false);
    if (deprecated.ok) return;
    expect(deprecated.error).toMatch(/can't be added to new designs.*Claude model/);

    const fielded = applyDesignOp('resource.add', doc(), { type: 'aws_sqs_queue', fields: { nonsense: 1 } });
    expect(fielded.ok).toBe(false);
    if (fielded.ok) return;
    expect(fielded.error).toMatch(/Unknown field nonsense/);
    expect(fielded.error).toMatch(/Valid fields: /); // the valid list is included
  });

  it('configures base values vs one environment override, and clears overrides with null', () => {
    const base = doc([lambda()]);
    const all = applyDesignOp('resource.configure', base, { id: 'n-handler', fields: { runtime: 'nodejs20.x' } });
    expect(all.ok).toBe(true);
    if (!all.ok) return;

    const prod = applyDesignOp('env.override', all.doc, { id: 'n-handler', env: 'prod', field: 'runtime', value: 'nodejs22.x' });
    expect(prod.ok).toBe(true);
    if (!prod.ok) return;
    expect(prod.doc.nodes[0].data.envOverrides.prod).toEqual({ runtime: 'nodejs22.x' });

    const cleared = applyDesignOp('env.override', prod.doc, { id: 'n-handler', env: 'prod', field: 'runtime', value: null });
    expect(cleared.ok && cleared.doc.nodes[0].data.envOverrides.prod).toEqual({});
  });

  it('enforces the canvas connection rules with the refusal reason', () => {
    const base = doc([lambda(), nodeFor('aws_dynamodb_table', 'orders')]);
    const trigger = applyDesignOp('connection.create', base, { from: 'n-orders', to: 'n-handler' });
    // table changes → lambda is an event trigger in the rules (TARGETS: dynamodb → lambda)
    if (!trigger.ok) throw new Error(trigger.error);
    expect(trigger.result.relationshipType).toBe('event_trigger');

    // Lambda → table is legal (compute may use data); table → anything is not — tables only receive
    const legal = applyDesignOp('connection.create', base, { from: 'n-handler', to: 'n-orders' });
    expect(legal.ok).toBe(true);
    const queue = applyDesignOp('resource.add', base, { type: 'aws_sqs_queue' });
    if (!queue.ok) throw new Error(queue.error);
    const backwards = applyDesignOp('connection.create', queue.doc, {
      from: 'n-orders',
      to: (queue.result as { id: string }).id,
    });
    expect(backwards.ok).toBe(false);
    if (backwards.ok) return;
    expect(backwards.error).toMatch(/refused/i);
  });

  it('removes a resource with its connections and releases container children', () => {
    const withTable = applyDesignOp('resource.add', doc([lambda()]), { type: 'aws_dynamodb_table' });
    if (!withTable.ok) throw new Error(withTable.error);
    const tableId = (withTable.result as { id: string }).id;
    const linked = applyDesignOp('connection.create', withTable.doc, { from: tableId, to: 'n-handler' });
    if (!linked.ok) throw new Error(linked.error);

    const removed = applyDesignOp('resource.remove', linked.doc, { id: tableId });
    expect(removed.ok && removed.doc.nodes).toHaveLength(1); // the lambda stays
    expect(removed.ok && removed.doc.edges).toHaveLength(0); // its connection went with the table
  });

  it('moves a resource into a container and back to the root', () => {
    const vpc = applyDesignOp('resource.add', doc(), { type: 'aws_vpc' });
    if (!vpc.ok) throw new Error(vpc.error);
    const vpcId = (vpc.result as { id: string }).id;
    const added = applyDesignOp('resource.add', vpc.doc, { type: 'aws_lambda_function', parent: vpcId });
    expect(added.ok && added.doc.nodes.find((n) => n.data.serviceType === 'aws_lambda_function')!.parentId).toBe(vpcId);

    const rooted = applyDesignOp('resource.move', added.ok ? added.doc : doc(), {
      id: (added.ok ? (added.result as { id: string }).id : ''),
      parent: null,
    });
    expect(rooted.ok && rooted.doc.nodes.find((n) => n.data.serviceType === 'aws_lambda_function')!.parentId).toBeUndefined();
  });

  it('replaces the design with a template', () => {
    const out = applyDesignOp('template.apply', doc(), { templateId: 'vpc-ecs-rds-ha' });
    expect(out.ok && out.doc.nodes.length).toBeGreaterThan(3);
    const bad = applyDesignOp('template.apply', doc(), { templateId: 'nope' });
    expect(bad.ok).toBe(false);
  });

  it('imports Terraform HCL and reports what it kept', () => {
    const out = applyDesignOp('import.terraform', doc(), { hcl: IMPORT_FIXTURE_HCL });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.result as { imported: number }).imported).toBeGreaterThan(0);
    expect(out.doc.nodes.length).toBeGreaterThan(0);
  });

  it('validates without creating a version-worthy change', () => {
    const base = doc([lambda()]);
    const out = applyDesignOp('project.validate', base, { env: 'dev' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Array.isArray((out.result as { findings: unknown }).findings)).toBe(true);
    expect(out.doc).toBe(base); // untouched
  });

  it('refuses ops on missing resources with 404-style errors', () => {
    const out = applyDesignOp('resource.configure', doc(), { id: 'ghost', fields: { a: 1 } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
  });

  it('adds, updates and removes environments, and accepts them in env-scoped ops', () => {
    const base = doc([lambda()]);
    const added = applyDesignOp('environment.add', base, { id: 'qa', copyFrom: 'testing' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(Object.keys(added.doc.environments)).toContain('qa');
    expect(added.result).toMatchObject({ id: 'qa', emulatorPort: 9301, copiedFrom: 'testing' });

    const override = applyDesignOp('env.override', added.doc, { id: 'n-handler', env: 'qa', field: 'memory_size', value: 2048 });
    expect(override.ok && override.doc.nodes[0].data.envOverrides.qa).toEqual({ memory_size: 2048 });

    const dup = applyDesignOp('environment.add', added.doc, { id: 'qa' });
    expect(dup.ok).toBe(false);

    const taken = applyDesignOp('environment.update', added.doc, { id: 'qa', emulatorPort: 9297 });
    expect(!taken.ok && taken.error).toMatch(/already used by dev/);

    const updated = applyDesignOp('environment.update', added.doc, { id: 'qa', production: true, region: 'eu-west-1' });
    expect(updated.ok && updated.doc.environments.qa).toMatchObject({ production: true, region: 'eu-west-1' });

    if (!override.ok) return;
    const removed = applyDesignOp('environment.remove', override.doc, { id: 'qa' });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(Object.keys(removed.doc.environments)).not.toContain('qa');
    expect(removed.doc.nodes[0].data.envOverrides).not.toHaveProperty('qa');

    // An environment the project doesn't have is refused by name
    const unknown = applyDesignOp('env.enable', removed.doc, { id: 'n-handler', env: 'qa', enabled: false });
    expect(!unknown.ok && unknown.error).toMatch(/env must be one of dev, testing, staging, prod/);
  });

  it('saves, replaces and removes scenarios', () => {
    const base = doc([lambda()]);
    const saved = applyDesignOp('scenario.save', base, {
      scenario: { name: 'smoke', steps: [{ service: 'lambda', operation: 'invoke', nodeId: 'n-handler' }] },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const id = saved.result.id as string;
    expect(saved.doc.scenarios).toHaveLength(1);

    const replaced = applyDesignOp('scenario.save', saved.doc, { scenario: { id, name: 'smoke 2', steps: [] } });
    expect(replaced.ok && replaced.doc.scenarios?.map((s) => s.name)).toEqual(['smoke 2']);

    const missing = applyDesignOp('scenario.save', base, {
      scenario: { name: 'x', steps: [{ service: 'lambda', operation: 'invoke', nodeId: 'n-gone' }] },
    });
    expect(!missing.ok && missing.error).toMatch(/n-gone not found/);

    if (!replaced.ok) return;
    const removed = applyDesignOp('scenario.remove', replaced.doc, { id });
    expect(removed.ok && removed.doc).not.toHaveProperty('scenarios');
  });
});
