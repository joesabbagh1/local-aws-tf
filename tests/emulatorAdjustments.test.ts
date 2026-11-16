import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENTS, SERVICE_BY_TYPE } from '../src/data/awsCatalog';
import { compileTerraformForEnvironment, EXTRA_HCL_KEY, mergeLifecycleBlocks } from '../src/utils/terraformCompiler';
import { emulatorInstanceType, emulatorKinesisRetention, isBurstableInstanceType } from '../src/utils/emulatorAdjustments';
import { createServiceNode } from '../src/utils/nodeFactory';
import { runArchitectureLinter } from '../src/utils/architectureValidator';
import { alreadyExisting, blockedDeletes, failedIds, unimplementedDeletes, securityGroupEgressQuirks } from '../server/services/emulatorQuirks';
import type { CloudNode } from '../src/types/cloud';
import { nodeFor } from './fixtures';

const compile = (nodes: CloudNode[], target: 'emulator' | 'aws' = 'emulator') =>
  compileTerraformForEnvironment(nodes, [], DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS, target).mainTf;

/** The text of `resource "<type>" "<name>" { ... }`, by brace matching. */
function block(mainTf: string, tfType: string, name: string): string {
  const start = mainTf.indexOf(`resource "${tfType}" "${name}" {`);
  expect(start, `${tfType}.${name} in output`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = mainTf.indexOf('{', start); i < mainTf.length; i++) {
    if (mainTf[i] === '{') depth++;
    else if (mainTf[i] === '}' && --depth === 0) return mainTf.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

describe('emulator adjustments', () => {
  it('maps burstable instance types to a non-burstable one of the same architecture', () => {
    expect(isBurstableInstanceType('t3.micro')).toBe(true);
    expect(isBurstableInstanceType('t4g.small')).toBe(true);
    expect(isBurstableInstanceType('m6i.large')).toBe(false);
    expect(emulatorInstanceType('t2.micro')).toBe('m6i.large');
    expect(emulatorInstanceType('t3a.medium')).toBe('m6i.large');
    expect(emulatorInstanceType('t4g.micro')).toBe('m7g.medium');
    expect(emulatorInstanceType('c7g.large')).toBe('c7g.large');
  });

  it('runs a burstable EC2 instance as m6i or m7g on the emulator only', () => {
    const x86 = nodeFor('aws_instance', 'web', { instance_type: 't3.micro' });
    const arm = nodeFor('aws_instance', 'arm', { instance_type: 't4g.micro' });
    const emulator = compile([x86, arm]);
    expect(block(emulator, 'aws_instance', 'web')).toContain('instance_type               = "m6i.large"');
    expect(block(emulator, 'aws_instance', 'web')).toContain('# Emulator only: t3.micro runs as m6i.large');
    expect(block(emulator, 'aws_instance', 'arm')).toContain('instance_type               = "m7g.medium"');

    const aws = compile([x86, arm], 'aws');
    expect(block(aws, 'aws_instance', 'web')).toContain('instance_type               = "t3.micro"');
    expect(block(aws, 'aws_instance', 'arm')).toContain('instance_type               = "t4g.micro"');
    expect(aws).not.toContain('Emulator only');

    const steady = compile([nodeFor('aws_instance', 'big', { instance_type: 'm6i.large' })]);
    expect(steady).toContain('instance_type               = "m6i.large"');
    expect(steady).not.toContain('runs as');
  });

  it('ignores the root volume the emulator reports, on the emulator only', () => {
    const web = nodeFor('aws_instance', 'web', { instance_type: 'm6i.large' });
    expect(block(compile([web]), 'aws_instance', 'web')).toMatch(/lifecycle \{\s*ignore_changes = \[root_block_device\]\s*\}/);
    expect(compile([web], 'aws')).not.toContain('ignore_changes');
  });

  it('runs a 24-hour Kinesis retention as 25 hours on the emulator only', () => {
    expect(emulatorKinesisRetention(24)).toBe(25);
    expect(emulatorKinesisRetention(48)).toBe(48);
    const stream = nodeFor('aws_kinesis_stream', 'events', { retention_period: 24 });
    expect(block(compile([stream]), 'aws_kinesis_stream', 'events')).toMatch(/# Emulator only: 24 hours[^\n]*\n\s*retention_period = 25/);
    expect(block(compile([stream], 'aws'), 'aws_kinesis_stream', 'events')).toContain('retention_period = 24');
    const week = nodeFor('aws_kinesis_stream', 'week', { retention_period: 168 });
    expect(block(compile([week]), 'aws_kinesis_stream', 'week')).not.toContain('Emulator only');
  });

  it('ignores the port the emulator picks for Redis, on the emulator only', () => {
    const single = nodeFor('aws_elasticache_cluster', 'cache', { num_cache_nodes: 1 });
    const replicated = nodeFor('aws_elasticache_cluster', 'sessions', { engine: 'redis', num_cache_nodes: 2 });
    const emulator = compile([single, replicated]);
    expect(block(emulator, 'aws_elasticache_cluster', 'cache')).toMatch(/lifecycle \{\s*ignore_changes = \[port\]\s*\}/);
    expect(block(emulator, 'aws_elasticache_replication_group', 'sessions')).toMatch(/lifecycle \{\s*ignore_changes = \[port\]\s*\}/);
    expect(compile([single, replicated], 'aws')).not.toContain('ignore_changes = [port]');
  });

  it('merges an Extra HCL lifecycle block into the one the compiler writes', () => {
    const cache = nodeFor('aws_elasticache_cluster', 'cache', { num_cache_nodes: 1 });
    cache.data.baseConfig[EXTRA_HCL_KEY] = 'lifecycle {\n  prevent_destroy = true\n  ignore_changes = [tags, port]\n}';
    const body = block(compile([cache]), 'aws_elasticache_cluster', 'cache');
    expect(body.match(/\blifecycle \{/g)).toHaveLength(1);
    expect(body).toContain('ignore_changes = [port, tags]');
    expect(body).toContain('prevent_destroy = true');
  });

  it('lets ignore_changes = all win when merging lifecycle blocks', () => {
    const hcl = `resource "aws_x" "y" {
  a = 1

  lifecycle {
    ignore_changes = [port]
  }

  lifecycle {
    ignore_changes = all
    create_before_destroy = true
  }
}`;
    const merged = mergeLifecycleBlocks(hcl, 'aws_x', 'y');
    expect(merged.match(/\blifecycle \{/g)).toHaveLength(1);
    expect(merged).toContain('ignore_changes = all');
    expect(merged).not.toContain('[port]');
    expect(merged).toContain('create_before_destroy = true');
  });
});

describe('emulator quirks the runner recovers from', () => {
  it('finds resources whose delete the emulator has not implemented', () => {
    const output = `aws_s3_bucket.logs: Destruction complete after 1s

Error: deleting ElastiCache Replication Group (lc-prod-sessions): operation error ElastiCache: DeleteReplicationGroup, https response error StatusCode: 501, RequestID: 1, api error NotImplemented: operation DeleteReplicationGroup is scaffolded but not implemented

  with aws_elasticache_replication_group.sessions,

Error: deleting RDS DB Instance (lc-prod-db): InvalidParameterCombination: deletion protection is enabled

  with aws_db_instance.db,
`;
    expect(unimplementedDeletes(output)).toEqual([
      { address: 'aws_elasticache_replication_group.sessions', operation: 'DeleteReplicationGroup', id: 'lc-prod-sessions' },
    ]);
    expect(securityGroupEgressQuirks(output)).toEqual([]);
  });

  it('finds the address from the progress lines when a saved plan prints no "with" line', () => {
    const output = `aws_elasticache_replication_group.sessions: Destroying... [id=lc-dev-sessions]
aws_instance.web: Destroying... [id=i-2]
aws_instance.web: Destruction complete after 10s

Error: deleting ElastiCache Replication Group (lc-dev-sessions): operation error ElastiCache: DeleteReplicationGroup, https response error StatusCode: 501, api error NotImplemented: operation DeleteReplicationGroup is scaffolded but not implemented in this emulator
`;
    expect(unimplementedDeletes(output)).toEqual([
      { address: 'aws_elasticache_replication_group.sessions', operation: 'DeleteReplicationGroup', id: 'lc-dev-sessions' },
    ]);
  });

  it('finds what a resource the emulator could not delete still holds', () => {
    const output = `Error: deleting ElastiCache Subnet Group (lc-dev-sessions-subnets): operation error ElastiCache: DeleteCacheSubnetGroup, https response error StatusCode: 400, CacheSubnetGroupInUse: Cache subnet group lc-dev-sessions-subnets is currently in use.

  with aws_elasticache_subnet_group.sessions_subnets,

Error: deleting EC2 Subnet (subnet-1): operation error EC2: DeleteSubnet, https response error StatusCode: 400, api error DependencyViolation: The subnet has dependencies

  with aws_subnet.sub_a,
`;
    expect(blockedDeletes(output)).toEqual([
      { address: 'aws_elasticache_subnet_group.sessions_subnets', id: 'lc-dev-sessions-subnets' },
      { address: 'aws_subnet.sub_a', id: 'subnet-1' },
    ]);
  });

  it('finds the ids a re-apply meets as already existing, and the ids any error names', () => {
    const output = `Error: creating ElastiCache Subnet Group (lc-dev-sessions-subnets): operation error ElastiCache: CreateCacheSubnetGroup, https response error StatusCode: 400, CacheSubnetGroupAlreadyExists: Cache subnet group lc-dev-sessions-subnets already exists.

Error: modifying ElastiCache Replication Group (lc-dev-sessions) authentication: InvalidParameterValue: Invalid AuthToken provided.
`;
    expect(alreadyExisting(output)).toEqual(['lc-dev-sessions-subnets']);
    expect(failedIds(output)).toEqual(['lc-dev-sessions-subnets', 'lc-dev-sessions']);
  });
});

describe('deprecated services', () => {
  it('keeps Bedrock Agent out of new designs but still compiles existing ones', () => {
    const svc = SERVICE_BY_TYPE.aws_bedrock_agent;
    expect(svc.deprecated).toMatch(/Claude model/);
    expect(createServiceNode('aws_bedrock_agent', [])).toBeNull();

    const agent = nodeFor('aws_bedrock_agent', 'helper');
    expect(compile([agent])).toContain('resource "aws_bedrockagent_agent" "helper"');
    const findings = runArchitectureLinter([agent], [], 'dev', DEFAULT_ENVIRONMENTS);
    expect(findings.some((f) => f.id === `deprecated-${agent.id}`)).toBe(true);
    expect(findings.some((f) => f.id === `emulator-support-${agent.id}`)).toBe(false);
  });
});
