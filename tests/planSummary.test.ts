import { describe, expect, it } from 'vitest';
import { classifyPlanActions, planHasChanges, summarizePlan, type PlanResourceChange } from '../src/utils/planSummary';
import type { CloudNode } from '../src/types/cloud';

const node = (id: string, resourceName: string, serviceType: string, devEnabled = true): CloudNode => ({
  id,
  type: 'awsNode',
  position: { x: 0, y: 0 },
  data: {
    label: resourceName,
    resourceName,
    serviceType,
    baseConfig: {},
    envOverrides: {},
    envEnabled: { dev: devEnabled, testing: true, staging: true, prod: true },
    tags: {},
  },
});

const change = (type: string, name: string, actions: string[]): PlanResourceChange => ({
  address: `${type}.${name}`,
  type,
  name,
  actions,
});

describe('classifyPlanActions', () => {
  it.each([
    [['create'], 'create'],
    [['update'], 'update'],
    [['delete'], 'delete'],
    [['delete', 'create'], 'replace'],
    [['create', 'delete'], 'replace'],
    [['no-op'], null],
    [['read'], null],
  ])('%j → %s', (actions, expected) => {
    expect(classifyPlanActions(actions)).toBe(expected);
  });
});

describe('summarizePlan', () => {
  const nodes = [
    node('fn', 'orders_api', 'aws_lambda_function'),
    node('fn2', 'orders_api_v2', 'aws_lambda_function'),
    node('table', 'orders', 'aws_dynamodb_table'),
    node('off', 'audit_bucket', 'aws_s3_bucket', false),
  ];

  it('groups helper resources under their node and counts like terraform', () => {
    const summary = summarizePlan(
      [
        change('aws_iam_role', 'orders_api_exec_role', ['create']),
        change('aws_lambda_function', 'orders_api', ['create']),
        change('aws_lambda_function', 'orders_api_v2', ['update']),
        change('aws_dynamodb_table', 'orders', ['delete', 'create']),
        change('aws_sqs_queue', 'removed_queue', ['delete']),
        change('aws_kms_key', 'untouched', ['no-op']),
      ],
      nodes,
      'dev'
    );

    expect(summary.counts).toEqual({ add: 3, change: 1, destroy: 2 });
    expect(summary.byNode).toEqual({ fn: 'create', fn2: 'update', table: 'replace' });
    expect(summary.changesByNode.fn.map((c) => c.address)).toEqual([
      'aws_iam_role.orders_api_exec_role',
      'aws_lambda_function.orders_api',
    ]);
    expect(summary.other).toEqual([{ address: 'aws_sqs_queue.removed_queue', action: 'delete' }]);
    expect(planHasChanges(summary)).toBe(true);
  });

  it('prefers the longest matching resource name', () => {
    const summary = summarizePlan([change('aws_iam_role', 'orders_api_v2_exec_role', ['create'])], nodes, 'dev');
    expect(Object.keys(summary.byNode)).toEqual(['fn2']);
  });

  it('lists resources of a node switched off in this environment as not on the canvas', () => {
    const summary = summarizePlan([change('aws_s3_bucket', 'audit_bucket', ['delete'])], nodes, 'dev');
    expect(summary.byNode).toEqual({});
    expect(summary.other).toHaveLength(1);
  });

  it('reports a mixed set of actions on one node as a change', () => {
    const summary = summarizePlan(
      [change('aws_lambda_function', 'orders_api', ['update']), change('aws_iam_role', 'orders_api_exec_role', ['create'])],
      nodes,
      'dev'
    );
    expect(summary.byNode.fn).toBe('update');
  });

  it('has no changes for an all no-op plan', () => {
    expect(planHasChanges(summarizePlan([change('aws_kms_key', 'k', ['no-op'])], nodes, 'dev'))).toBe(false);
  });
});
