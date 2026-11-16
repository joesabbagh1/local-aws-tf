import { describe, expect, it } from 'vitest';
import { checkExpectation, parseScenario } from '../src/utils/scenarios';
import { EXPLORER_SERVICES, buildExplorerInput, explorerOperation } from '../src/utils/explorerOps';
import { liveResourceName } from '../src/utils/terraformNames';
import { nodeFor } from './fixtures';

let n = 0;
const makeId = () => `id-${++n}`;

describe('parseScenario', () => {
  it('keeps what it understands and gives steps ids', () => {
    const parsed = parseScenario(
      {
        name: ' Order flow ',
        steps: [
          { service: 'apigateway', operation: 'request', nodeId: 'n-api', input: { method: 'POST' }, expect: { status: 200, contains: 'ok' } },
          { service: 'dynamodb', operation: 'scan', retrySeconds: 999, expect: { contains: ['order#1'], junk: true } },
        ],
      },
      makeId
    );
    expect('scenario' in parsed).toBe(true);
    if (!('scenario' in parsed)) return;
    const { scenario } = parsed;
    expect(scenario.name).toBe('Order flow');
    expect(scenario.steps[0]).toMatchObject({ nodeId: 'n-api', expect: { status: 200, contains: ['ok'] } });
    expect(scenario.steps[0].id).toMatch(/^id-/);
    expect(scenario.steps[1].retrySeconds).toBe(120);
    expect(scenario.steps[1].expect).toEqual({ contains: ['order#1'] });
  });

  it('says what is missing', () => {
    expect(parseScenario({ steps: [] }, makeId)).toEqual({ error: 'scenario.name is required' });
    expect(parseScenario({ name: 'x', steps: [{ service: 'sqs' }] }, makeId)).toEqual({ error: 'step 1 needs a service and an operation' });
  });
});

describe('checkExpectation', () => {
  it('passes without an expectation', () => {
    expect(checkExpectation(undefined, { anything: 1 })).toEqual({ ok: true });
  });

  it('checks contains, notContains and HTTP status', () => {
    const out = { status: 201, body: { orderId: '1001', state: 'PAID' } };
    expect(checkExpectation({ status: 201, contains: ['"state":"PAID"'] }, out).ok).toBe(true);
    expect(checkExpectation({ status: 200 }, out)).toEqual({ ok: false, failure: 'expected HTTP 200, got 201' });
    expect(checkExpectation({ contains: ['FAILED'] }, out)).toMatchObject({ ok: false, failure: expect.stringContaining('FAILED') });
    expect(checkExpectation({ notContains: ['1001'] }, out).ok).toBe(false);
  });
});

describe('explorer operations', () => {
  it('cover every service once, with unique operation ids', () => {
    const ids = EXPLORER_SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svc of EXPLORER_SERVICES) {
      const ops = svc.operations.map((o) => o.id);
      expect(new Set(ops).size, svc.id).toBe(ops.length);
    }
  });

  it('build their input from form values, parsing JSON fields', () => {
    const op = explorerOperation('apigateway', 'request')!;
    expect(buildExplorerInput(op, { method: 'POST', headers: '{"x-a":"1"}', body: '' })).toEqual({
      input: { method: 'POST', path: '/', headers: { 'x-a': '1' } },
    });
    expect(buildExplorerInput(op, { headers: '{nope' })).toEqual({ invalid: 'Headers' });
  });
});

describe('liveResourceName', () => {
  it('matches the names the compiler gives deployed resources', () => {
    expect(liveResourceName(nodeFor('aws_lambda_function', 'Orders API'), 'dev')).toBe('lc-dev-orders_api');
    expect(liveResourceName(nodeFor('aws_sqs_queue', 'jobs', { fifo_queue: true }), 'qa')).toBe('lc-qa-jobs.fifo');
    expect(liveResourceName(nodeFor('aws_s3_bucket', 'media', { bucket_prefix: 'App_Assets' }), 'prod')).toBe('lc-prod-app-assets');
  });
});
