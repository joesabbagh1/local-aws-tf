import { describe, expect, it } from 'vitest';
import { AWS_SERVICES_CATALOG, DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import { checkConnection } from '../src/utils/connectionRules';
import { compileTerraformForEnvironment } from '../src/utils/terraformCompiler';
import { runArchitectureLinter } from '../src/utils/architectureValidator';
import type { CloudEdge, CloudNode } from '../src/types/cloud';
import { allConnectionsCanvas, nodeFor } from './fixtures';
import { ACCESS, accessLevelsFor, accessStatements } from '../src/utils/wiringCatalog';

const TYPES = AWS_SERVICES_CATALOG.map((svc) => svc.typeId);
const NETWORK_TYPES = ['aws_vpc', 'aws_subnet', 'aws_security_group'];

const compile = (nodes: CloudNode[], edges: CloudEdge[], target: 'emulator' | 'aws' = 'emulator') =>
  compileTerraformForEnvironment(nodes, edges, DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS, target).mainTf;

const edge = (source: CloudNode, target: CloudNode, data?: CloudEdge['data']): CloudEdge => ({
  id: `e-${source.id}-${target.id}`,
  source: source.id,
  target: target.id,
  data,
});

/** Every ordered pair of catalog services the canvas accepts. */
const accepted = TYPES.flatMap((s) =>
  TYPES.map((t) => {
    const source = nodeFor(s, 'src');
    const target = nodeFor(t, 'dst');
    const check = checkConnection(source, target, []);
    return check.ok ? { s, t, source, target, relationshipType: check.relationshipType } : null;
  })
).filter((pair): pair is NonNullable<typeof pair> => pair !== null);

describe('every connection the canvas accepts generates Terraform', () => {
  const calls = accepted.filter((p) => !NETWORK_TYPES.includes(p.s));
  const placements = accepted.filter((p) => NETWORK_TYPES.includes(p.s));

  it('accepts a meaningful number of pairs', () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(placements.length).toBeGreaterThan(15);
  });

  it.each(calls.map((p) => [p.s, p.t, p] as const))('%s -> %s', (_s, _t, pair) => {
    const nodes = [pair.source, pair.target];
    const without = compile(nodes, []);
    const withEdge = compile(nodes, [edge(pair.source, pair.target, { relationshipType: pair.relationshipType })]);
    expect(withEdge).not.toBe(without);
    // …and the AWS export gets the same wiring
    expect(compile(nodes, [edge(pair.source, pair.target)], 'aws')).not.toBe(compile(nodes, [], 'aws'));
  });

  // With two of each network resource on the canvas, wiring the second one must be what places the target
  it.each(placements.map((p) => [p.s, p.t, p] as const))('%s places %s', (_s, _t, pair) => {
    const vpcA = nodeFor('aws_vpc', 'vpc_a');
    const vpcB = nodeFor('aws_vpc', 'vpc_b');
    const subnetA = { ...nodeFor('aws_subnet', 'subnet_a'), parentId: vpcA.id };
    const subnetB = nodeFor('aws_subnet', 'subnet_b');
    const sgA = nodeFor('aws_security_group', 'sg_a');
    const sgB = nodeFor('aws_security_group', 'sg_b');
    const network = [vpcA, vpcB, subnetA, subnetB, sgA, sgB];
    const placer = { aws_vpc: vpcB, aws_subnet: subnetB, aws_security_group: sgB }[pair.s]!;
    const target = NETWORK_TYPES.includes(pair.t) ? nodeFor(pair.t, 'placed') : pair.target;
    const nodes = [...network, target];
    expect(compile(nodes, [edge(placer, target)])).not.toBe(compile(nodes, []));
  });

  it('generates nothing extra for a connection switched to depends_on only', () => {
    const fn = nodeFor('aws_lambda_function', 'fn');
    const table = nodeFor('aws_dynamodb_table', 'orders');
    const tf = compile([fn, table], [edge(fn, table, { relationshipType: 'depends_on' })]);
    expect(tf).not.toContain('resource "aws_iam_role_policy" ');
    expect(tf).not.toContain('ORDERS_TABLE_NAME');
    expect(tf).toContain('depends_on = [aws_lambda_function.fn]');
  });
});

describe('wiring details', () => {
  it('gives a caller the permission and the environment variable for what it calls', () => {
    const fn = nodeFor('aws_lambda_function', 'notify');
    const topic = nodeFor('aws_sns_topic', 'alerts');
    const secret = nodeFor('aws_secretsmanager_secret', 'api_key');
    const tf = compile([fn, topic, secret], [edge(fn, topic), edge(fn, secret)]);
    expect(tf).toContain('"sns:Publish"');
    expect(tf).toContain('ALERTS_TOPIC_ARN = "${aws_sns_topic.alerts.arn}"');
    expect(tf).toContain('"secretsmanager:GetSecretValue"');
    expect(tf).toContain('role = aws_iam_role.notify_exec_role.id');
  });

  it('narrows a grant to the access level a connection chooses', () => {
    const fn = nodeFor('aws_lambda_function', 'reader');
    const table = nodeFor('aws_dynamodb_table', 'orders');
    const queue = nodeFor('aws_sqs_queue', 'jobs');
    const bucket = nodeFor('aws_s3_bucket', 'media');
    const tf = compile(
      [fn, table, queue, bucket],
      [edge(fn, table, { relationshipType: 'iam_grant', access: 'read' }), edge(fn, queue, { relationshipType: 'iam_grant', access: 'write' }), edge(fn, bucket)]
    );
    const policy = (name: string) => tf.slice(tf.indexOf(`resource "aws_iam_role_policy" "${name}"`)).split('\n}\n')[0];

    const ddb = policy('reader_ddb_orders');
    expect(ddb).toContain('"dynamodb:GetItem"');
    expect(ddb).toContain('"dynamodb:Query"');
    expect(ddb).not.toContain('PutItem');
    expect(ddb).not.toContain('DeleteItem');
    // Indexes stay readable
    expect(ddb).toContain('/index/*');

    const sqs = policy('reader_sqs_jobs');
    expect(sqs).toContain('"sqs:SendMessage"');
    expect(sqs).not.toContain('ReceiveMessage');

    // No level: the full grant, as before
    const s3 = policy('reader_s3_media');
    expect(s3).toContain('"s3:GetObject"');
    expect(s3).toContain('"s3:PutObject"');
  });

  it('offers access levels only where a grant mixes reading and writing', () => {
    expect(accessLevelsFor('aws_sqs_queue').map((l) => `${l.value}:${l.label}`)).toEqual(['read:Receive', 'write:Send', 'readwrite:Send and receive']);
    expect(accessLevelsFor('aws_efs_file_system').map((l) => l.value)).toEqual(['read', 'readwrite']);
    expect(accessLevelsFor('aws_sns_topic')).toEqual([]);
    // Each level is a subset of the full grant, so narrowing never adds a permission
    for (const type of TYPES) {
      const spec = ACCESS[type];
      if (!spec?.levels) continue;
      const full = new Set(spec.statements({ name: 'x', tfType: type, cfg: {} }).flatMap((st) => st.actions));
      for (const level of [spec.levels.read, spec.levels.write]) {
        for (const action of level?.actions ?? []) expect(full.has(action), `${type}: ${action}`).toBe(true);
      }
    }
    // An unavailable level falls back to the full grant
    const ref = { name: 'x', tfType: 'aws_efs_file_system', cfg: {} };
    expect(accessStatements('aws_efs_file_system', ref, 'write')).toEqual(ACCESS.aws_efs_file_system.statements(ref));
  });

  it('grants a container on its task role and tells it where things are', () => {
    const svc = nodeFor('aws_ecs_service', 'api');
    const table = nodeFor('aws_dynamodb_table', 'orders');
    const queue = nodeFor('aws_sqs_queue', 'jobs');
    const tf = compile([svc, table, queue], [edge(svc, table), edge(queue, svc)]);
    expect(tf).toContain('role = aws_iam_role.api_task_role.id');
    expect(tf).toContain('{ name = "ORDERS_TABLE_NAME", value = tostring(aws_dynamodb_table.orders.name) }');
    expect(tf).toContain('{ name = "JOBS_QUEUE_URL", value = tostring(aws_sqs_queue.jobs.url) }');
    expect(tf).toContain('resource "aws_iam_role_policy" "api_consume_jobs"');
  });

  it('gives an EC2 instance a role and profile only once it is granted something', () => {
    const vm = nodeFor('aws_instance', 'worker');
    const bucket = nodeFor('aws_s3_bucket', 'media');
    expect(compile([vm, bucket], [])).not.toContain('aws_iam_instance_profile');
    const tf = compile([vm, bucket], [edge(vm, bucket)]);
    expect(tf).toContain('resource "aws_iam_instance_profile" "worker_profile"');
    expect(tf).toContain('iam_instance_profile        = aws_iam_instance_profile.worker_profile.name');
  });

  it('turns triggers into the event wiring AWS needs, permission included', () => {
    const bucket = nodeFor('aws_s3_bucket', 'uploads');
    const table = nodeFor('aws_dynamodb_table', 'orders', { stream_enabled: false });
    const bus = nodeFor('aws_cloudwatch_event_bus', 'events');
    const topic = nodeFor('aws_sns_topic', 'alerts');
    const fn = nodeFor('aws_lambda_function', 'handler');
    const tf = compile([bucket, table, bus, topic, fn], [edge(bucket, fn), edge(table, fn), edge(bus, fn), edge(topic, fn)]);
    expect(tf).toContain('resource "aws_s3_bucket_notification" "uploads_notifications"');
    expect(tf).toContain('principal     = "s3.amazonaws.com"');
    expect(tf).toContain('event_source_arn  = aws_dynamodb_table.orders.stream_arn');
    expect(tf).toContain('stream_enabled   = true');
    expect(tf).toContain('resource "aws_cloudwatch_event_target" "events_to_handler"');
    expect(tf).toContain('principal     = "events.amazonaws.com"');
    expect(tf).toContain('principal     = "sns.amazonaws.com"');
  });

  it('merges every sender into one queue policy', () => {
    const queue = nodeFor('aws_sqs_queue', 'inbox');
    const topic = nodeFor('aws_sns_topic', 'alerts');
    const bus = nodeFor('aws_cloudwatch_event_bus', 'events');
    const bucket = nodeFor('aws_s3_bucket', 'uploads');
    const tf = compile([queue, topic, bus, bucket], [edge(topic, queue), edge(bus, queue), edge(bucket, queue)]);
    expect(tf.match(/resource "aws_sqs_queue_policy"/g)).toHaveLength(1);
    for (const service of ['sns', 'events', 's3']) expect(tf).toContain(`Principal = { Service = "${service}.amazonaws.com" }`);
  });

  it('registers an ECS service with the load balancer in front of it', () => {
    const lb = nodeFor('aws_lb', 'ingress');
    const svc = nodeFor('aws_ecs_service', 'api');
    const fn = nodeFor('aws_lambda_function', 'admin');
    const tf = compile([lb, svc, fn], [edge(lb, svc), edge(lb, fn)]);
    expect(tf).toContain('target_group_arn = aws_lb_target_group.ingress_tg.arn\n    container_name   = "api"');
    expect(tf).toContain('depends_on = [aws_lb_listener.ingress_listener]');
    // The Lambda is a second target, reached by path
    expect(tf).toContain('resource "aws_lb_listener_rule" "ingress_to_admin"');
    expect(tf).toContain('values = ["/admin/*"]');
  });

  it('runs a state machine through the resources it is connected to, in order', () => {
    const sfn = nodeFor('aws_sfn_state_machine', 'flow');
    const fn = nodeFor('aws_lambda_function', 'enrich');
    const queue = nodeFor('aws_sqs_queue', 'done');
    const tf = compile([sfn, fn, queue], [edge(sfn, fn), edge(sfn, queue)]);
    expect(tf).toContain('StartAt = "Invoke_enrich"');
    expect(tf).toContain('Next = "Send_done"');
    expect(tf).toContain('"lambda:InvokeFunction"');
    expect(tf).toContain('role = aws_iam_role.flow_sfn_role.id');
  });

  it('puts a Cognito authorizer on the routes of an API it is connected to', () => {
    const pool = nodeFor('aws_cognito_user_pool', 'users', { create_app_client: false });
    const api = nodeFor('aws_apigatewayv2_api', 'api');
    const fn = nodeFor('aws_lambda_function', 'orders');
    const tf = compile([pool, api, fn], [edge(pool, api), edge(api, fn)]);
    expect(tf).toContain('resource "aws_apigatewayv2_authorizer" "api_users_auth"');
    expect(tf).toContain('authorizer_id      = aws_apigatewayv2_authorizer.api_users_auth.id');
    // …which needs a client for the token audience even when the form didn't ask for one
    expect(tf).toContain('resource "aws_cognito_user_pool_client" "users_client"');
  });

  it('keeps a bucket private behind CloudFront', () => {
    const cdn = nodeFor('aws_cloudfront_distribution', 'web');
    const bucket = nodeFor('aws_s3_bucket', 'site');
    const tf = compile([cdn, bucket], [edge(cdn, bucket)]);
    expect(tf).toContain('origin_access_control_id = aws_cloudfront_origin_access_control.web_site_oac.id');
    expect(tf).toContain('resource "aws_s3_bucket_policy" "site_cloudfront"');
  });

  it('flags a bucket that notifies several targets about the same objects', () => {
    const bucket = nodeFor('aws_s3_bucket', 'uploads');
    const a = nodeFor('aws_lambda_function', 'thumbs');
    const b = nodeFor('aws_sqs_queue', 'audit');
    const overlapping = runArchitectureLinter([bucket, a, b], [edge(bucket, a), edge(bucket, b)], 'dev');
    expect(overlapping.some((f) => f.id === `s3-overlap-${bucket.id}`)).toBe(true);
    const split = runArchitectureLinter(
      [bucket, a, b],
      [edge(bucket, a, { relationshipType: 'event_trigger', label: 'images/' }), edge(bucket, b, { relationshipType: 'event_trigger', label: 'logs/' })],
      'dev'
    );
    expect(split.some((f) => f.id === `s3-overlap-${bucket.id}`)).toBe(false);
  });
});

// One of everything, connected every way the canvas allows: a complete Terraform root that
// `npm run validate:golden` runs `terraform validate` on, for both targets.
describe('all-connections canvas', () => {
  const { nodes, edges } = allConnectionsCanvas();

  it.each(['emulator', 'aws'] as const)('compiles to valid %s Terraform', async (target) => {
    const compiled = compileTerraformForEnvironment(nodes, edges, DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS, target);
    const dir = `golden/${target}/all-connections/dev`;
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/dev.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
    if (target === 'aws') {
      await expect(compiled.backendTf).toMatchFileSnapshot(`${dir}/backend.tf`);
      await expect(compiled.backendConfig).toMatchFileSnapshot(`${dir}/backend.tfbackend`);
    }
  });
});
