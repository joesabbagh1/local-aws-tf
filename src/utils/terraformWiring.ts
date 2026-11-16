import type { CloudEdge, CloudNode, EnvironmentId } from '../types/cloud';
import { dnsSafeName, mainResourceType, resolveNodeConfigForEnv, tfName } from './terraformNames';
import { ACCESS, CALLERS, callWiring, type AccessStatement, type TargetRef } from './wiringCatalog';

/**
 * Terraform for the connections on the canvas. The pairs handled here are the pairs
 * wiringCatalog.ts lists; a resource's own block (terraformCompiler.ts) calls the helpers in the
 * first half for what must live inside it (environment variables, a state machine's definition, a
 * load balancer's target groups), and `renderEdgeWiringBlocks` writes everything that stands alone.
 */

type NodeMap = Record<string, CloudNode>;

/** An edge switched to "depends_on only" orders two resources and generates nothing else. */
export const isWired = (edge: CloudEdge) => edge.data?.relationshipType !== 'depends_on';

function targetRef(node: CloudNode, envId: EnvironmentId): TargetRef {
  const cfg = resolveNodeConfigForEnv(node, envId);
  return { name: tfName(node), tfType: mainResourceType(node, cfg), cfg };
}

const quote = (values: string[]) => values.map((v) => `"${v}"`).join(', ');

function statementsHcl(statements: AccessStatement[]): string {
  return statements
    .map(
      (st) => `{
      Effect   = "Allow"
      Action   = [${quote(st.actions)}]
      Resource = ${st.resourceList ?? `[${st.resources.join(', ')}]`}
    }`
    )
    .join(', ');
}

function rolePolicy(resource: string, policyName: string, roleRef: string, statements: AccessStatement[]): string {
  return `resource "aws_iam_role_policy" "${resource}" {
  name = "${policyName}"
  role = aws_iam_role.${roleRef}.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [${statementsHcl(statements)}]
  })
}`;
}

function serviceRole(resource: string, name: string, service: string): string {
  return `resource "aws_iam_role" "${resource}" {
  name = "\${local.name_prefix}-${name}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "${service}" }
    }]
  })
}`;
}

function lambdaPermission(resource: string, statementId: string, fn: string, principal: string, sourceArn: string, action = 'lambda:InvokeFunction'): string {
  return `resource "aws_lambda_permission" "${resource}" {
  statement_id  = "${statementId}"
  action        = "${action}"
  function_name = aws_lambda_function.${fn}.function_name
  principal     = "${principal}"
  source_arn    = ${sourceArn}
}`;
}

// ---------------------------------------------------------------------------------------------
// Helpers for resource blocks
// ---------------------------------------------------------------------------------------------

/** Whether a caller's outgoing connections grant it anything, i.e. whether it needs a role at all. */
export function hasGrants(node: CloudNode, outgoing: CloudEdge[], nodeById: NodeMap): boolean {
  return outgoing.some((edge) => {
    const target = nodeById[edge.target];
    return isWired(edge) && !!target && !!callWiring(node.data.serviceType, target.data.serviceType)?.grant;
  });
}

/**
 * Environment variables a Lambda or ECS service gets from its connections: where each resource it
 * calls is (`<TARGET>_TABLE_NAME`, `<TARGET>_QUEUE_URL`, …), and for an ECS service the queues and
 * streams it is wired to consume. Values are HCL template strings.
 */
export function connectionEnvVars(
  node: CloudNode,
  incoming: CloudEdge[],
  outgoing: CloudEdge[],
  nodeById: NodeMap,
  envId: EnvironmentId
): Record<string, string> {
  const vars: Record<string, string> = {};
  const type = node.data.serviceType;

  for (const edge of outgoing) {
    const target = nodeById[edge.target];
    if (!target || !isWired(edge) || !callWiring(type, target.data.serviceType)?.env) continue;
    const ref = targetRef(target, envId);
    for (const [suffix, value] of Object.entries(ACCESS[target.data.serviceType].env(ref))) {
      vars[`${ref.name.toUpperCase()}_${suffix}`] = value;
    }
  }

  // Lambda consumers are handed their events; a container has to poll, so it needs to know where
  if (type === 'aws_ecs_service') {
    for (const edge of incoming) {
      const source = nodeById[edge.source];
      if (!source || !isWired(edge)) continue;
      const name = tfName(source);
      if (source.data.serviceType === 'aws_sqs_queue') vars[`${name.toUpperCase()}_QUEUE_URL`] = `\${aws_sqs_queue.${name}.url}`;
      if (source.data.serviceType === 'aws_kinesis_stream') vars[`${name.toUpperCase()}_STREAM_NAME`] = `\${aws_kinesis_stream.${name}.name}`;
    }
  }
  return vars;
}

/** The role (and, for EC2, the instance profile) a caller without a built-in role gets once it is granted something. */
export function onDemandCallerRole(node: CloudNode, resName: string): string {
  const type = node.data.serviceType;
  const role = CALLERS[type].role(resName);
  if (type === 'aws_eks_cluster') {
    return `# Workloads assume this role through EKS Pod Identity: associate it with a service account
resource "aws_iam_role" "${role}" {
  name = "\${local.name_prefix}-${resName}-pod-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
    }]
  })
}`;
  }
  return `${serviceRole(role, `${resName}-instance-role`, 'ec2.amazonaws.com')}

resource "aws_iam_instance_profile" "${resName}_profile" {
  name = "\${local.name_prefix}-${resName}-profile"
  role = aws_iam_role.${role}.name
}`;
}

/** Service integrations a state machine can run as a step, by target type. */
const SFN_STEPS: Record<string, (ref: TargetRef) => { id: string; lines: string[] }> = {
  aws_lambda_function: (t) => ({
    id: `Invoke_${t.name}`,
    lines: [
      'Type     = "Task"',
      'Resource = "arn:aws:states:::lambda:invoke"',
      // By name rather than by reference, so a function may also start the machine that runs it
      `Parameters = {\n  FunctionName = "\${local.name_prefix}-${t.name}"\n  "Payload.$"  = "$"\n}`,
      'OutputPath = "$.Payload"',
    ],
  }),
  aws_sqs_queue: (t) => ({
    id: `Send_${t.name}`,
    lines: [
      'Type     = "Task"',
      'Resource = "arn:aws:states:::sqs:sendMessage"',
      `Parameters = {\n  QueueUrl        = aws_sqs_queue.${t.name}.url\n  "MessageBody.$" = "States.JsonToString($)"\n}`,
      'ResultPath = null',
    ],
  }),
  aws_sns_topic: (t) => ({
    id: `Publish_${t.name}`,
    lines: [
      'Type     = "Task"',
      'Resource = "arn:aws:states:::sns:publish"',
      `Parameters = {\n  TopicArn    = aws_sns_topic.${t.name}.arn\n  "Message.$" = "States.JsonToString($)"\n}`,
      'ResultPath = null',
    ],
  }),
  aws_cloudwatch_event_bus: (t) => ({
    id: `Emit_${t.name}`,
    lines: [
      'Type     = "Task"',
      'Resource = "arn:aws:states:::events:putEvents"',
      `Parameters = {\n  Entries = [{\n    EventBusName = aws_cloudwatch_event_bus.${t.name}.name\n    Source       = "${t.cfg.event_pattern_source || 'custom.app'}"\n    DetailType   = "StateMachineStep"\n    "Detail.$"   = "$"\n  }]\n}`,
      'ResultPath = null',
    ],
  }),
  aws_sfn_state_machine: (t) => ({
    id: `Start_${t.name}`,
    lines: [
      'Type     = "Task"',
      'Resource = "arn:aws:states:::states:startExecution"',
      `Parameters = {\n  StateMachineArn = aws_sfn_state_machine.${t.name}.arn\n  "Input.$"       = "$"\n}`,
      'ResultPath = null',
    ],
  }),
};

/**
 * The body of `definition = jsonencode(...)`: one step per connected Lambda, queue, topic, bus or
 * state machine, run in the order the connections were drawn. Other connections only grant the
 * machine's role access. With no steps it is a single Pass state.
 */
export function sfnDefinition(outgoing: CloudEdge[], nodeById: NodeMap, envId: EnvironmentId): string {
  const steps = outgoing
    .filter(isWired)
    .map((edge) => nodeById[edge.target])
    .filter((target): target is CloudNode => !!target && !!SFN_STEPS[target.data.serviceType])
    .map((target) => SFN_STEPS[target.data.serviceType](targetRef(target, envId)));

  if (steps.length === 0) {
    return `{
    Comment = "Compiled by LocalCloud Studio"
    StartAt = "InvokePrimaryStep"
    States = {
      InvokePrimaryStep = {
        Type = "Pass"
        End  = true
      }
    }
  }`;
  }

  const indent = (text: string, spaces: number) =>
    text
      .split('\n')
      .map((line) => `${' '.repeat(spaces)}${line}`)
      .join('\n');
  const states = steps
    .map((step, i) => {
      const flow = i === steps.length - 1 ? 'End = true' : `Next = "${steps[i + 1].id}"`;
      return `      ${step.id} = {\n${indent([...step.lines, flow].join('\n'), 8)}\n      }`;
    })
    .join('\n');
  return `{
    Comment = "Compiled by LocalCloud Studio"
    StartAt = "${steps[0].id}"
    States = {
${states}
    }
  }`;
}

/** Cognito's Lambda triggers, handed out in this order unless a connection's label names one. */
const COGNITO_TRIGGERS = [
  'post_confirmation',
  'pre_sign_up',
  'post_authentication',
  'pre_authentication',
  'pre_token_generation',
  'custom_message',
  'define_auth_challenge',
  'create_auth_challenge',
  'verify_auth_challenge_response',
  'user_migration',
];

/** Which trigger each connected Lambda handles for a user pool. */
export function cognitoTriggers(outgoing: CloudEdge[], nodeById: NodeMap): { trigger: string; fn: string }[] {
  const lambdas = outgoing.filter(
    (edge) => isWired(edge) && nodeById[edge.target]?.data.serviceType === 'aws_lambda_function'
  );
  const named = (edge: CloudEdge) => {
    const label = String(edge.data?.label || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return COGNITO_TRIGGERS.includes(label) ? label : null;
  };
  const taken = new Set(lambdas.map(named).filter((t): t is string => !!t));
  const free = COGNITO_TRIGGERS.filter((t) => !taken.has(t));
  const assigned: { trigger: string; fn: string }[] = [];
  const used = new Set<string>();
  for (const edge of lambdas) {
    const trigger = named(edge) ?? free.shift();
    if (!trigger || used.has(trigger)) continue;
    used.add(trigger);
    assigned.push({ trigger, fn: tfName(nodeById[edge.target]) });
  }
  return assigned;
}

/** The JWT authorizer a user pool puts on an API's routes, when one is connected to it. */
function apiAuthorizer(api: CloudNode, incoming: CloudEdge[], nodeById: NodeMap, envId: EnvironmentId): string | null {
  if ((resolveNodeConfigForEnv(api, envId).protocol_type || 'HTTP') !== 'HTTP') return null;
  const pool = incoming
    .filter(isWired)
    .map((edge) => nodeById[edge.source])
    .find((source) => source?.data.serviceType === 'aws_cognito_user_pool');
  return pool ? `${tfName(api)}_${tfName(pool)}_auth` : null;
}

export interface LbTargets {
  /** Target groups besides the load balancer's own IP group, in listener-rule order. */
  groups: { key: string; tg: string; kind: 'instance' | 'lambda'; members: CloudNode[] }[];
  /** The target group the listener forwards to by default. */
  defaultTg: string;
  /** Groups reached through a path rule (`/<key>/*`) because another one is the default. */
  ruled: { key: string; tg: string }[];
}

/**
 * How a load balancer splits its targets. ECS tasks register by IP in the load balancer's own
 * target group; instances and Auto Scaling groups share an instance group; each Lambda needs a
 * group of its own. The first kind present is the default route and the rest get a path rule.
 */
export function lbTargets(lbName: string, outgoing: CloudEdge[], nodeById: NodeMap): LbTargets {
  const targets = outgoing
    .filter(isWired)
    .map((edge) => nodeById[edge.target])
    .filter((n): n is CloudNode => !!n);
  const ofType = (...types: string[]) => targets.filter((n) => types.includes(n.data.serviceType));

  const hasEcs = ofType('aws_ecs_service').length > 0;
  const instances = ofType('aws_instance', 'aws_autoscaling_group');
  const lambdas = ofType('aws_lambda_function');

  const groups: LbTargets['groups'] = [];
  if (instances.length) groups.push({ key: 'instances', tg: `${lbName}_instances_tg`, kind: 'instance', members: instances });
  for (const fn of lambdas) groups.push({ key: tfName(fn), tg: `${lbName}_${tfName(fn)}_tg`, kind: 'lambda', members: [fn] });

  const ownGroup = `${lbName}_tg`;
  const defaultTg = hasEcs || groups.length === 0 ? ownGroup : groups[0].tg;
  return { groups, defaultTg, ruled: groups.filter((g) => g.tg !== defaultTg).map(({ key, tg }) => ({ key, tg })) };
}

export interface CloudfrontOrigin {
  id: string;
  /** The `origin { ... }` block's body, without the braces. */
  body: string;
  /** Requests under `/<path>/*` go here; the first origin takes everything else. */
  path: string;
}

/** One origin per connected bucket, load balancer, API or function; the first is the default. */
export function cloudfrontOrigins(distName: string, outgoing: CloudEdge[], nodeById: NodeMap, envId: EnvironmentId): CloudfrontOrigin[] {
  const custom = (policy: string, httpPort = 80) => `custom_origin_config {
      http_port              = ${httpPort}
      https_port             = 443
      origin_protocol_policy = "${policy}"
      origin_ssl_protocols   = ["TLSv1.2"]
    }`;

  const origins: CloudfrontOrigin[] = [];
  for (const edge of outgoing) {
    const target = nodeById[edge.target];
    if (!target || !isWired(edge)) continue;
    const name = tfName(target);
    const id = origins.length === 0 ? `${distName}-primary-origin` : `${distName}-${name}`;
    let domain: string;
    let rest: string;
    switch (target.data.serviceType) {
      case 'aws_s3_bucket':
        // The bucket stays private: CloudFront signs its requests and the bucket policy admits only this distribution
        domain = `aws_s3_bucket.${name}.bucket_regional_domain_name`;
        rest = `origin_access_control_id = aws_cloudfront_origin_access_control.${distName}_${name}_oac.id`;
        break;
      case 'aws_lb':
        // The load balancer's listener speaks plain HTTP
        domain = `aws_lb.${name}.dns_name`;
        rest = custom('http-only', Number(resolveNodeConfigForEnv(target, envId).listener_port ?? 80));
        break;
      case 'aws_apigatewayv2_api':
        domain = `replace(aws_apigatewayv2_api.${name}.api_endpoint, "https://", "")`;
        rest = custom('https-only');
        break;
      case 'aws_lambda_function':
        domain = `trimsuffix(trimprefix(aws_lambda_function_url.${name}_url.function_url, "https://"), "/")`;
        rest = `origin_access_control_id = aws_cloudfront_origin_access_control.${distName}_${name}_oac.id\n\n    ${custom('https-only')}`;
        break;
      default:
        continue;
    }
    origins.push({ id, path: name, body: `domain_name = ${domain}\n    origin_id   = "${id}"\n\n    ${rest}` });
  }
  return origins;
}

// ---------------------------------------------------------------------------------------------
// Standalone blocks, one connection at a time
// ---------------------------------------------------------------------------------------------

/** Resources AWS allows once per target (a queue's policy, a bucket's notification), gathered across connections. */
interface Shared {
  queuePolicies: Map<string, string[]>;
  topicPolicies: Map<string, string[]>;
  bucketPolicies: Map<string, string[]>;
  notifications: Map<string, { blocks: string[]; dependsOn: string[] }>;
  apiRoles: Set<string>;
  functionUrls: Set<string>;
}

const push = <T,>(map: Map<string, T[]>, key: string, value: T) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

function servicePolicyStatement(sid: string, service: string, action: string, resource: string, sourceArn: string, op = 'ArnEquals'): string {
  return `{
        Sid       = "${sid}"
        Effect    = "Allow"
        Principal = { Service = "${service}" }
        Action    = "${action}"
        Resource  = ${resource}
        Condition = { ${op} = { "aws:SourceArn" = ${sourceArn} } }
      }`;
}

const sidOf = (prefix: string, name: string) => `${prefix}${name.replace(/[^A-Za-z0-9]/g, '')}`;

export function renderEdgeWiringBlocks(edges: CloudEdge[], nodeById: NodeMap, envId: EnvironmentId): string[] {
  const blocks: string[] = [];
  const shared: Shared = {
    queuePolicies: new Map(),
    topicPolicies: new Map(),
    bucketPolicies: new Map(),
    notifications: new Map(),
    apiRoles: new Set(),
    functionUrls: new Set(),
  };
  const wired = edges.filter(isWired);
  const incomingTo = (id: string) => wired.filter((e) => e.target === id);
  const outgoingFrom = (id: string) => wired.filter((e) => e.source === id);

  for (const edge of wired) {
    const src = nodeById[edge.source];
    const dst = nodeById[edge.target];
    if (!src || !dst) continue;

    const srcName = tfName(src);
    const dstName = tfName(dst);
    const srcType = src.data.serviceType;
    const dstType = dst.data.serviceType;
    const dstCfg = resolveNodeConfigForEnv(dst, envId);
    const label = String(edge.data?.label || '').trim();

    // ── API Gateway ────────────────────────────────────────────────────────────────────────────
    if (srcType === 'aws_apigatewayv2_api') {
      const authorizer = apiAuthorizer(src, incomingTo(src.id), nodeById, envId);
      const auth = authorizer
        ? `\n  authorization_type = "JWT"\n  authorizer_id      = aws_apigatewayv2_authorizer.${authorizer}.id`
        : '';
      const route = (defaultKey: string) => `resource "aws_apigatewayv2_route" "${srcName}_route_${dstName}" {
  api_id    = aws_apigatewayv2_api.${srcName}.id
  route_key = "${label.includes('/') ? label : defaultKey}"
  target    = "integrations/\${aws_apigatewayv2_integration.${srcName}_to_${dstName}.id}"${auth}
}`;

      if (dstType === 'aws_lambda_function') {
        blocks.push(`resource "aws_apigatewayv2_integration" "${srcName}_to_${dstName}" {
  api_id                 = aws_apigatewayv2_api.${srcName}.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.${dstName}.invoke_arn
  payload_format_version = "2.0"
}

${route(`ANY /${dstName}/{proxy+}`)}

resource "aws_lambda_permission" "${srcName}_invoke_${dstName}" {
  statement_id  = "AllowExecutionFromAPIGateway-${srcName}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.${dstName}.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "\${aws_apigatewayv2_api.${srcName}.execution_arn}/*/*"
}`);
      } else if (dstType === 'aws_lb') {
        const internal = Boolean(dstCfg.internal ?? false);
        blocks.push(
          internal
            ? `# The load balancer is internal, so the API reaches it through a VPC link
resource "aws_apigatewayv2_vpc_link" "${srcName}_to_${dstName}" {
  name               = "\${local.name_prefix}-${srcName}-${dstName}"
  subnet_ids         = aws_lb.${dstName}.subnets
  security_group_ids = aws_lb.${dstName}.security_groups
}

resource "aws_apigatewayv2_integration" "${srcName}_to_${dstName}" {
  api_id             = aws_apigatewayv2_api.${srcName}.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_lb_listener.${dstName}_listener.arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.${srcName}_to_${dstName}.id
}

${route(`ANY /${dstName}/{proxy+}`)}`
            : `resource "aws_apigatewayv2_integration" "${srcName}_to_${dstName}" {
  api_id             = aws_apigatewayv2_api.${srcName}.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = "http://\${aws_lb.${dstName}.dns_name}/{proxy}"
}

${route(`ANY /${dstName}/{proxy+}`)}`
        );
      } else {
        // Service integrations: the API calls the service itself, with a role of its own
        const integration: Record<string, { subtype: string; action: string; params: string[] }> = {
          aws_sqs_queue: {
            subtype: 'SQS-SendMessage',
            action: 'sqs:SendMessage',
            params: [`QueueUrl    = aws_sqs_queue.${dstName}.url`, 'MessageBody = "$request.body"'],
          },
          aws_sfn_state_machine: {
            subtype: 'StepFunctions-StartExecution',
            action: 'states:StartExecution',
            params: [`StateMachineArn = aws_sfn_state_machine.${dstName}.arn`, 'Input           = "$request.body"'],
          },
          aws_cloudwatch_event_bus: {
            subtype: 'EventBridge-PutEvents',
            action: 'events:PutEvents',
            params: [
              `EventBusName = aws_cloudwatch_event_bus.${dstName}.name`,
              `Source       = "${dstCfg.event_pattern_source || 'custom.app'}"`,
              'DetailType   = "ApiRequest"',
              'Detail       = "$request.body"',
            ],
          },
          aws_kinesis_stream: {
            subtype: 'Kinesis-PutRecord',
            action: 'kinesis:PutRecord',
            params: [
              `StreamName   = aws_kinesis_stream.${dstName}.name`,
              'Data         = "$request.body"',
              'PartitionKey = "$context.requestId"',
            ],
          },
        };
        const spec = integration[dstType];
        if (spec) {
          const role = `${srcName}_integration_role`;
          if (!shared.apiRoles.has(role)) {
            shared.apiRoles.add(role);
            blocks.push(serviceRole(role, `${srcName}-integration-role`, 'apigateway.amazonaws.com'));
          }
          blocks.push(`${rolePolicy(`${srcName}_calls_${dstName}`, `${srcName}-calls-${dstName}`, role, [
            { actions: [spec.action], resources: [`${dstType}.${dstName}.arn`] },
          ])}

resource "aws_apigatewayv2_integration" "${srcName}_to_${dstName}" {
  api_id                 = aws_apigatewayv2_api.${srcName}.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "${spec.subtype}"
  credentials_arn        = aws_iam_role.${role}.arn
  payload_format_version = "1.0"

  request_parameters = {
    ${spec.params.join('\n    ')}
  }
}

${route(`POST /${dstName}`)}`);
        }
      }
    }

    // ── Queues and streams feeding consumers ───────────────────────────────────────────────────
    if (srcType === 'aws_sqs_queue' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_iam_role_policy" "${dstName}_consume_${srcName}" {
  name = "${dstName}-consume-${srcName}"
  role = aws_iam_role.${dstName}_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
      Resource = aws_sqs_queue.${srcName}.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "${srcName}_trigger_${dstName}" {
  event_source_arn = aws_sqs_queue.${srcName}.arn
  function_name    = aws_lambda_function.${dstName}.arn
  batch_size       = 10
  enabled          = true
  depends_on       = [aws_iam_role_policy.${dstName}_consume_${srcName}]
}`);
    }

    if (srcType === 'aws_kinesis_stream' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_iam_role_policy" "${dstName}_consume_${srcName}" {
  name = "${dstName}-consume-${srcName}"
  role = aws_iam_role.${dstName}_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:ListStreams"]
      Resource = aws_kinesis_stream.${srcName}.arn
    }]
  })
}

resource "aws_lambda_event_source_mapping" "${srcName}_stream_${dstName}" {
  event_source_arn  = aws_kinesis_stream.${srcName}.arn
  function_name     = aws_lambda_function.${dstName}.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.${dstName}_consume_${srcName}]
}`);
    }

    // A container polls: it gets the permissions (its environment variables come with its own block)
    if (dstType === 'aws_ecs_service' && (srcType === 'aws_sqs_queue' || srcType === 'aws_kinesis_stream')) {
      blocks.push(
        rolePolicy(`${dstName}_consume_${srcName}`, `${dstName}-consume-${srcName}`, CALLERS.aws_ecs_service.role(dstName), [
          srcType === 'aws_sqs_queue'
            ? {
                actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'],
                resources: [`aws_sqs_queue.${srcName}.arn`],
              }
            : {
                actions: ['kinesis:GetRecords', 'kinesis:GetShardIterator', 'kinesis:DescribeStream', 'kinesis:DescribeStreamSummary', 'kinesis:ListShards'],
                resources: [`aws_kinesis_stream.${srcName}.arn`],
              },
        ])
      );
    }

    if (srcType === 'aws_dynamodb_table' && dstType === 'aws_lambda_function') {
      blocks.push(`${rolePolicy(`${dstName}_consume_${srcName}`, `${dstName}-consume-${srcName}`, `${dstName}_exec_role`, [
        {
          actions: ['dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:DescribeStream', 'dynamodb:ListStreams'],
          resources: [`aws_dynamodb_table.${srcName}.stream_arn`],
        },
      ])}

resource "aws_lambda_event_source_mapping" "${srcName}_stream_${dstName}" {
  event_source_arn  = aws_dynamodb_table.${srcName}.stream_arn
  function_name     = aws_lambda_function.${dstName}.arn
  starting_position = "LATEST"
  batch_size        = 100
  depends_on        = [aws_iam_role_policy.${dstName}_consume_${srcName}]
}`);
    }

    // ── SNS ────────────────────────────────────────────────────────────────────────────────────
    if (srcType === 'aws_sns_topic' && dstType === 'aws_sqs_queue') {
      blocks.push(`resource "aws_sns_topic_subscription" "${srcName}_sub_${dstName}" {
  topic_arn = aws_sns_topic.${srcName}.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.${dstName}.arn
}`);
      push(
        shared.queuePolicies,
        dstName,
        servicePolicyStatement(sidOf('AllowTopic', srcName), 'sns.amazonaws.com', 'sqs:SendMessage', `aws_sqs_queue.${dstName}.arn`, `aws_sns_topic.${srcName}.arn`)
      );
    }
    if (srcType === 'aws_sns_topic' && dstType === 'aws_lambda_function') {
      blocks.push(`resource "aws_sns_topic_subscription" "${srcName}_sub_${dstName}" {
  topic_arn = aws_sns_topic.${srcName}.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.${dstName}.arn
}

${lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromSNS-${srcName}`, dstName, 'sns.amazonaws.com', `aws_sns_topic.${srcName}.arn`)}`);
    }

    // ── EventBridge ────────────────────────────────────────────────────────────────────────────
    if (srcType === 'aws_cloudwatch_event_bus') {
      const rule = `aws_cloudwatch_event_rule.${srcName}_rule`;
      const target = (arn: string, extra = '') => `resource "aws_cloudwatch_event_target" "${srcName}_to_${dstName}" {
  rule           = ${rule}.name
  event_bus_name = aws_cloudwatch_event_bus.${srcName}.name
  target_id      = "${dstName}"
  arn            = ${arn}${extra}
}`;
      if (dstType === 'aws_lambda_function') {
        blocks.push(`${target(`aws_lambda_function.${dstName}.arn`)}

${lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromEventBridge-${srcName}`, dstName, 'events.amazonaws.com', `${rule}.arn`)}`);
      } else if (dstType === 'aws_sqs_queue') {
        blocks.push(target(`aws_sqs_queue.${dstName}.arn`));
        push(
          shared.queuePolicies,
          dstName,
          servicePolicyStatement(sidOf('AllowRule', srcName), 'events.amazonaws.com', 'sqs:SendMessage', `aws_sqs_queue.${dstName}.arn`, `${rule}.arn`)
        );
      } else if (dstType === 'aws_sns_topic') {
        blocks.push(target(`aws_sns_topic.${dstName}.arn`));
        push(
          shared.topicPolicies,
          dstName,
          servicePolicyStatement(sidOf('AllowRule', srcName), 'events.amazonaws.com', 'sns:Publish', `aws_sns_topic.${dstName}.arn`, `${rule}.arn`)
        );
      } else if (dstType === 'aws_sfn_state_machine') {
        const role = `${srcName}_start_${dstName}_role`;
        blocks.push(`${serviceRole(role, `${srcName}-start-${dstName}`, 'events.amazonaws.com')}

${rolePolicy(`${srcName}_start_${dstName}`, `${srcName}-start-${dstName}`, role, [
  { actions: ['states:StartExecution'], resources: [`aws_sfn_state_machine.${dstName}.arn`] },
])}

${target(`aws_sfn_state_machine.${dstName}.arn`, `\n  role_arn       = aws_iam_role.${role}.arn`)}`);
      }
    }

    // ── S3 notifications (one notification resource per bucket) ────────────────────────────────
    if (srcType === 'aws_s3_bucket' && ['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic'].includes(dstType)) {
      const entry = shared.notifications.get(srcName) ?? { blocks: [], dependsOn: [] };
      shared.notifications.set(srcName, entry);
      // A label like "uploads/" limits the connection to keys under that prefix
      const prefix = /^[^\s]+\/$/.test(label) ? `\n    filter_prefix       = "${label}"` : '';
      const events = `events              = ["s3:ObjectCreated:*"]${prefix}`;
      const bucketArn = `aws_s3_bucket.${srcName}.arn`;
      if (dstType === 'aws_lambda_function') {
        blocks.push(lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromS3-${srcName}`, dstName, 's3.amazonaws.com', bucketArn));
        entry.blocks.push(`lambda_function {\n    lambda_function_arn = aws_lambda_function.${dstName}.arn\n    ${events}\n  }`);
        entry.dependsOn.push(`aws_lambda_permission.${srcName}_invoke_${dstName}`);
      } else if (dstType === 'aws_sqs_queue') {
        push(shared.queuePolicies, dstName, servicePolicyStatement(sidOf('AllowBucket', srcName), 's3.amazonaws.com', 'sqs:SendMessage', `aws_sqs_queue.${dstName}.arn`, bucketArn, 'ArnLike'));
        entry.blocks.push(`queue {\n    queue_arn           = aws_sqs_queue.${dstName}.arn\n    ${events}\n  }`);
        entry.dependsOn.push(`aws_sqs_queue_policy.${dstName}_senders`);
      } else {
        push(shared.topicPolicies, dstName, servicePolicyStatement(sidOf('AllowBucket', srcName), 's3.amazonaws.com', 'sns:Publish', `aws_sns_topic.${dstName}.arn`, bucketArn, 'ArnLike'));
        entry.blocks.push(`topic {\n    topic_arn           = aws_sns_topic.${dstName}.arn\n    ${events}\n  }`);
        entry.dependsOn.push(`aws_sns_topic_policy.${dstName}_publishers`);
      }
    }

    // ── CloudFront origins that need signed requests ───────────────────────────────────────────
    if (srcType === 'aws_cloudfront_distribution' && (dstType === 'aws_s3_bucket' || dstType === 'aws_lambda_function')) {
      const isBucket = dstType === 'aws_s3_bucket';
      blocks.push(`resource "aws_cloudfront_origin_access_control" "${srcName}_${dstName}_oac" {
  name                              = substr("\${local.name_prefix}-${srcName}-${dstName}", 0, 64)
  origin_access_control_origin_type = "${isBucket ? 's3' : 'lambda'}"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}`);
      if (isBucket) {
        push(
          shared.bucketPolicies,
          dstName,
          `{
        Sid       = "${sidOf('AllowCloudFront', srcName)}"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "\${aws_s3_bucket.${dstName}.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.${srcName}.arn } }
      }`
        );
      } else {
        if (!shared.functionUrls.has(dstName)) {
          shared.functionUrls.add(dstName);
          blocks.push(`resource "aws_lambda_function_url" "${dstName}_url" {
  function_name      = aws_lambda_function.${dstName}.function_name
  authorization_type = "AWS_IAM"
}`);
        }
        blocks.push(
          lambdaPermission(
            `${srcName}_invoke_${dstName}`,
            `AllowExecutionFromCloudFront-${srcName}`,
            dstName,
            'cloudfront.amazonaws.com',
            `aws_cloudfront_distribution.${srcName}.arn`,
            'lambda:InvokeFunctionUrl'
          )
        );
      }
    }

    // ── Load balancer targets (the target groups live in the load balancer's block) ────────────
    if (srcType === 'aws_lb') {
      const plan = lbTargets(srcName, outgoingFrom(src.id), nodeById);
      if (dstType === 'aws_instance') {
        blocks.push(`resource "aws_lb_target_group_attachment" "${srcName}_to_${dstName}" {
  target_group_arn = aws_lb_target_group.${srcName}_instances_tg.arn
  target_id        = aws_instance.${dstName}.id
}`);
      } else if (dstType === 'aws_autoscaling_group') {
        blocks.push(`resource "aws_autoscaling_attachment" "${srcName}_to_${dstName}" {
  autoscaling_group_name = aws_autoscaling_group.${dstName}.name
  lb_target_group_arn    = aws_lb_target_group.${srcName}_instances_tg.arn
}`);
      } else if (dstType === 'aws_lambda_function') {
        const tg = plan.groups.find((g) => g.kind === 'lambda' && g.key === dstName)?.tg ?? `${srcName}_${dstName}_tg`;
        blocks.push(`${lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromALB-${srcName}`, dstName, 'elasticloadbalancing.amazonaws.com', `aws_lb_target_group.${tg}.arn`)}

resource "aws_lb_target_group_attachment" "${srcName}_to_${dstName}" {
  target_group_arn = aws_lb_target_group.${tg}.arn
  target_id        = aws_lambda_function.${dstName}.arn
  depends_on       = [aws_lambda_permission.${srcName}_invoke_${dstName}]
}`);
      }
      // ECS services register themselves: see the load_balancer block on the service
    }

    // ── DNS ────────────────────────────────────────────────────────────────────────────────────
    if (srcType === 'aws_route53_zone' && (dstType === 'aws_lb' || dstType === 'aws_cloudfront_distribution')) {
      // The label names the record ("api", "www", "@" for the zone itself); otherwise the target's name
      const host = /^(@|[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*)$/i.test(label) ? label : dstName.replace(/_/g, '-');
      const recordName = host === '@' ? `aws_route53_zone.${srcName}.name` : `"${host}.\${aws_route53_zone.${srcName}.name}"`;
      const alias =
        dstType === 'aws_lb'
          ? `name                   = aws_lb.${dstName}.dns_name\n    zone_id                = aws_lb.${dstName}.zone_id\n    evaluate_target_health = true`
          : `name                   = aws_cloudfront_distribution.${dstName}.domain_name\n    zone_id                = aws_cloudfront_distribution.${dstName}.hosted_zone_id\n    evaluate_target_health = false`;
      blocks.push(`${
        dstType === 'aws_cloudfront_distribution'
          ? `# CloudFront only answers for this name once the distribution lists it under aliases with a matching certificate\n`
          : ''
      }resource "aws_route53_record" "${srcName}_to_${dstName}" {
  zone_id = aws_route53_zone.${srcName}.zone_id
  name    = ${recordName}
  type    = "A"

  alias {
    ${alias}
  }
}`);
    }

    // ── Cognito ────────────────────────────────────────────────────────────────────────────────
    if (srcType === 'aws_cognito_user_pool' && dstType === 'aws_apigatewayv2_api') {
      const authorizer = apiAuthorizer(dst, incomingTo(dst.id), nodeById, envId);
      blocks.push(
        authorizer === `${dstName}_${srcName}_auth`
          ? `# Routes on ${dstName} require a token issued by this user pool
resource "aws_apigatewayv2_authorizer" "${authorizer}" {
  api_id           = aws_apigatewayv2_api.${dstName}.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${srcName}-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.${srcName}_client.id]
    issuer   = "https://\${aws_cognito_user_pool.${srcName}.endpoint}"
  }
}`
          : `# ${srcName} is not used as an authorizer for ${dstName}: ${
              authorizer ? 'another user pool already is' : 'JWT authorizers need an HTTP API'
            }`
      );
    }
    if (srcType === 'aws_cognito_user_pool' && dstType === 'aws_lambda_function') {
      // Which trigger the function handles is set in the user pool's lambda_config
      if (cognitoTriggers(outgoingFrom(src.id), nodeById).some((t) => t.fn === dstName)) {
        blocks.push(
          lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromCognito-${srcName}`, dstName, 'cognito-idp.amazonaws.com', `aws_cognito_user_pool.${srcName}.arn`)
        );
      }
    }

    // ── Anything that runs code calling a resource: a grant on its role ────────────────────────
    const call = callWiring(srcType, dstType);
    if (call?.grant) {
      const ref = targetRef(dst, envId);
      const access = ACCESS[dstType];
      blocks.push(
        rolePolicy(`${srcName}_${access.key}_${dstName}`, `${srcName}-${access.key}-${dstName}`, CALLERS[srcType].role(srcName), access.statements(ref))
      );
      // An agent's action group is invoked by Bedrock itself, which needs the function's consent
      if (srcType === 'aws_bedrock_agent' && dstType === 'aws_lambda_function') {
        blocks.push(
          lambdaPermission(`${srcName}_invoke_${dstName}`, `AllowExecutionFromBedrock-${srcName}`, dstName, 'bedrock.amazonaws.com', `aws_bedrockagent_agent.${srcName}.agent_arn`)
        );
      }
    }
  }

  // Policies and notifications shared by several connections
  for (const [queue, statements] of shared.queuePolicies) {
    blocks.push(`resource "aws_sqs_queue_policy" "${queue}_senders" {
  queue_url = aws_sqs_queue.${queue}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      ${statements.join(',\n      ')}
    ]
  })
}`);
  }
  for (const [topic, statements] of shared.topicPolicies) {
    blocks.push(`resource "aws_sns_topic_policy" "${topic}_publishers" {
  arn = aws_sns_topic.${topic}.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      ${statements.join(',\n      ')}
    ]
  })
}`);
  }
  for (const [bucket, statements] of shared.bucketPolicies) {
    blocks.push(`resource "aws_s3_bucket_policy" "${bucket}_cloudfront" {
  bucket = aws_s3_bucket.${bucket}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      ${statements.join(',\n      ')}
    ]
  })
}`);
  }
  for (const [bucket, { blocks: entries, dependsOn }] of shared.notifications) {
    blocks.push(`resource "aws_s3_bucket_notification" "${bucket}_notifications" {
  bucket = aws_s3_bucket.${bucket}.id

  ${entries.join('\n\n  ')}

  depends_on = [${dependsOn.join(', ')}]
}`);
  }

  return blocks;
}

/** For `dnsSafeName` users outside the compiler. */
export { dnsSafeName };
