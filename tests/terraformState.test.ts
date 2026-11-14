import { describe, expect, it } from 'vitest';
import { statusFromState } from '../src/utils/terraformState';
import { nodeFor } from './fixtures';

const fn = nodeFor('aws_lambda_function', 'orders_api');
const fnV2 = nodeFor('aws_lambda_function', 'orders_api_v2');
const agent = nodeFor('aws_bedrock_agent', 'helper');
const off = nodeFor('aws_s3_bucket', 'assets');
off.data.envEnabled = { ...off.data.envEnabled, dev: false };

describe('statusFromState', () => {
  it('marks nodes whose main resource is in state, by catalog resource type', () => {
    const { status } = statusFromState([fn, fnV2, agent], 'dev', {
      exists: true,
      resources: [
        { type: 'aws_iam_role', name: 'orders_api_v2_exec_role' },
        { type: 'aws_lambda_function', name: 'orders_api' },
        { type: 'aws_bedrockagent_agent', name: 'helper' },
      ],
      outputs: {},
    });
    // A helper resource alone (the v2 role) doesn't make its node applied
    expect(status).toEqual({ 'n-orders_api': 'provisioned', 'n-orders_api_v2': 'unapplied', 'n-helper': 'provisioned' });
  });

  it('matches outputs to the longest resource name', () => {
    const { outputs } = statusFromState([fn, fnV2], 'dev', {
      exists: true,
      resources: [
        { type: 'aws_lambda_function', name: 'orders_api' },
        { type: 'aws_lambda_function', name: 'orders_api_v2' },
      ],
      outputs: { orders_api_lambda_arn: 'arn:1', orders_api_v2_lambda_arn: 'arn:2' },
    });
    expect(outputs['n-orders_api']).toEqual({ lambda_arn: 'arn:1' });
    expect(outputs['n-orders_api_v2']).toEqual({ lambda_arn: 'arn:2' });
  });

  it('clears status and outputs after a destroy, but keeps a failure visible', () => {
    const failed = { ...fn, data: { ...fn.data, provisioningStatus: { dev: 'failed' as const } } };
    const wasApplied = { ...fnV2, data: { ...fnV2.data, provisioningStatus: { dev: 'provisioned' as const }, provisionedOutputs: { dev: { lambda_arn: 'arn:2' } } } };
    const { status, outputs } = statusFromState([failed, wasApplied], 'dev', { exists: false, resources: [], outputs: {} });
    expect(status).toEqual({ 'n-orders_api': 'failed', 'n-orders_api_v2': 'unapplied' });
    expect(outputs['n-orders_api_v2']).toBeUndefined();
  });

  it('ignores state for a node switched off in this environment', () => {
    const { status } = statusFromState([off], 'dev', {
      exists: true,
      resources: [{ type: 'aws_s3_bucket', name: 'assets' }],
      outputs: {},
    });
    expect(status['n-assets']).toBe('unapplied');
  });
});
