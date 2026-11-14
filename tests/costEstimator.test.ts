import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import {
  COST_DRIVERS,
  costEstimateCsv,
  estimateArchitectureCosts,
  findCostSavings,
  projectMonthlyCost,
} from '../src/utils/costEstimator';
import { nodeFor } from './fixtures';

const sum = (d: Record<string, number>) => Object.values(d).reduce((a, b) => a + b, 0);

describe('estimateArchitectureCosts', () => {
  it('prices an EC2 instance as compute plus EBS storage', () => {
    const { items } = estimateArchitectureCosts([nodeFor('aws_instance', 'web', { instance_type: 't3.micro', root_volume_size: 20 })]);
    expect(items[0].drivers.dev.compute).toBeCloseTo(0.0104 * 730, 2);
    expect(items[0].drivers.dev.storage).toBeCloseTo(1.6, 2);
    expect(items[0].monthlyUsd.dev).toBeCloseTo(9.19, 2);
  });

  it('keeps every total equal to the sum of its drivers', () => {
    const nodes = [
      nodeFor('aws_lambda_function', 'fn'),
      nodeFor('aws_db_instance', 'db', { multi_az: true }),
      nodeFor('aws_nat_gateway', 'nat'),
      nodeFor('aws_s3_bucket', 'assets'),
      nodeFor('aws_vpc', 'vpc'),
    ];
    const estimate = estimateArchitectureCosts(nodes);
    for (const envId of ['dev', 'prod'] as const) {
      for (const item of estimate.items) expect(item.monthlyUsd[envId]).toBeCloseTo(sum(item.drivers[envId]), 1);
      expect(estimate.totalsByEnv[envId]).toBeCloseTo(sum(estimate.driversByEnv[envId]), 1);
    }
    expect(estimate.items.find((i) => i.serviceType === 'aws_vpc')!.monthlyUsd.prod).toBe(0);
  });

  it('charges nothing in an environment where the resource is disabled', () => {
    const node = nodeFor('aws_instance', 'web');
    node.data.envEnabled.dev = false;
    const { items, totalsByEnv } = estimateArchitectureCosts([node]);
    expect(items[0].monthlyUsd.dev).toBe(0);
    expect(items[0].sizingNotes.dev).toBe('Disabled');
    expect(totalsByEnv.prod).toBeGreaterThan(0);
  });

  it('scales usage-priced services with the environment usage profile', () => {
    const fn = [nodeFor('aws_lambda_function', 'fn')];
    const base = estimateArchitectureCosts(fn);
    const doubled = estimateArchitectureCosts(fn, {
      ...DEFAULT_ENVIRONMENTS,
      prod: { ...DEFAULT_ENVIRONMENTS.prod, usage: { ...DEFAULT_ENVIRONMENTS.prod.usage, requestsMillions: 50 } },
    });
    expect(doubled.totalsByEnv.prod).toBeCloseTo(base.totalsByEnv.prod * 2, 1);
    expect(doubled.totalsByEnv.dev).toBe(base.totalsByEnv.dev);
  });

  it('reads per-environment overrides', () => {
    const db = nodeFor('aws_db_instance', 'db', { instance_class: 'db.t4g.micro' });
    db.data.envOverrides.prod = { instance_class: 'db.r6g.large', multi_az: true };
    const { items } = estimateArchitectureCosts([db]);
    expect(items[0].drivers.prod.compute).toBeCloseTo(0.24 * 730 * 2, 1);
    expect(items[0].drivers.dev.compute).toBeCloseTo(0.016 * 730, 1);
  });
});

describe('projectMonthlyCost', () => {
  it('grows usage drivers and holds compute and fees flat', () => {
    const months = projectMonthlyCost({ compute: 100, storage: 10, requests: 10, transfer: 10, fees: 5 }, 0.1, 3);
    expect(months).toHaveLength(3);
    expect(months[2].compute).toBe(100);
    expect(months[2].fees).toBe(5);
    expect(months[2].requests).toBeCloseTo(12.1, 2);
  });
});

describe('findCostSavings', () => {
  it('suggests single-AZ outside production and nothing for prod Multi-AZ', () => {
    const nodes = [nodeFor('aws_db_instance', 'db', { multi_az: true, instance_class: 'db.r6g.large' })];
    const savings = findCostSavings(nodes, estimateArchitectureCosts(nodes));
    const titles = savings.map((s) => `${s.envId}:${s.title}`);
    expect(titles).toContain('dev:Run single-AZ outside production');
    expect(titles).not.toContain('prod:Run single-AZ outside production');
    expect(savings.find((s) => s.envId === 'dev')!.monthlyUsd).toBeCloseTo((0.24 * 730 * 2 + 20 * 0.115 * 2) / 2, 0);
  });

  it('lists the largest savings first', () => {
    const nodes = [nodeFor('aws_nat_gateway', 'nat'), nodeFor('aws_instance', 'web')];
    const savings = findCostSavings(nodes, estimateArchitectureCosts(nodes));
    expect(savings.length).toBeGreaterThan(0);
    for (let i = 1; i < savings.length; i++) expect(savings[i - 1].monthlyUsd).toBeGreaterThanOrEqual(savings[i].monthlyUsd);
  });
});

describe('costEstimateCsv', () => {
  it('writes one row per resource and environment', () => {
    const csv = costEstimateCsv(estimateArchitectureCosts([nodeFor('aws_instance', 'web, primary')]));
    const lines = csv.split('\n');
    expect(lines[0].split(',')).toEqual(['resource', 'service', 'category', 'environment', ...COST_DRIVERS, 'total_usd', 'sizing']);
    expect(lines).toHaveLength(5);
    expect(lines[1].startsWith('"web, primary",')).toBe(true);
  });
});
