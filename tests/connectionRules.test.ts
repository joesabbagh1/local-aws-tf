import { describe, expect, it } from 'vitest';
import { checkConnection } from '../src/utils/connectionRules';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { nodeFor } from './fixtures';

const n = (type: string, name = type.replace(/^aws_/, '')) => nodeFor(type, name);

describe('checkConnection', () => {
  it('allows every connection the blueprints use, with the same relationship', () => {
    for (const tpl of ARCHITECTURE_TEMPLATES) {
      for (const edge of tpl.edges) {
        const source = tpl.nodes.find((x) => x.id === edge.source);
        const target = tpl.nodes.find((x) => x.id === edge.target);
        const check = checkConnection(source, target, []);
        expect(check, `${tpl.id}: ${source?.data.serviceType} -> ${target?.data.serviceType}`).toMatchObject({ ok: true });
      }
    }
  });

  it.each([
    ['aws_apigatewayv2_api', 'aws_lambda_function', 'event_trigger'],
    ['aws_sqs_queue', 'aws_lambda_function', 'event_trigger'],
    ['aws_lambda_function', 'aws_dynamodb_table', 'iam_grant'],
    ['aws_lambda_function', 'aws_sqs_queue', 'data_flow'],
    ['aws_cloudfront_distribution', 'aws_s3_bucket', 'target_route'],
    ['aws_lb', 'aws_ecs_service', 'target_route'],
    ['aws_security_group', 'aws_db_instance', 'network_attachment'],
    ['aws_vpc', 'aws_subnet', 'network_attachment'],
  ])('%s -> %s is a %s', (s, t, rel) => {
    expect(checkConnection(n(s), n(t), [])).toMatchObject({ ok: true, relationshipType: rel });
  });

  it.each([
    ['aws_db_instance', 'aws_lambda_function', "doesn't call other services"],
    ['aws_lambda_function', 'aws_vpc', 'Nothing connects into'],
    ['aws_security_group', 'aws_lambda_function', "isn't placed in a network"],
    ['aws_cloudfront_distribution', 'aws_sqs_queue', "doesn't mean anything"],
    ['aws_lambda_function', 'aws_cloudfront_distribution', "doesn't mean anything"],
    ['aws_kms_key', 'aws_s3_bucket', "doesn't call other services"],
  ])('%s -> %s is refused', (s, t, reason) => {
    const check = checkConnection(n(s), n(t), []);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain(reason);
  });

  it('refuses self-loops and duplicates', () => {
    const fn = n('aws_lambda_function');
    const table = n('aws_dynamodb_table');
    expect(checkConnection(fn, fn, []).ok).toBe(false);
    const existing = [{ id: 'e', source: fn.id, target: table.id }];
    expect(checkConnection(fn, table, existing).ok).toBe(false);
  });
});
