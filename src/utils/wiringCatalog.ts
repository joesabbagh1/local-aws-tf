/**
 * What a connection on the canvas turns into. The canvas rules (connectionRules.ts) accept exactly
 * the pairs listed here, and the compiler (terraformWiring.ts) generates Terraform for exactly the
 * same pairs, so a connection that is drawn always does something. tests/wiring.test.ts holds the
 * two to that.
 *
 * Three kinds of connection:
 *   network    a VPC, Subnet or Security Group placing a resource
 *   trigger    a service delivering events or traffic to another (queue → function, CDN → bucket)
 *   call       something that runs code using another resource: an IAM grant on the caller's role,
 *              and for Lambda and ECS the environment variables that say where the resource is
 */

/** One resource as a caller sees it: its Terraform name, main resource type and resolved config. */
export interface TargetRef {
  name: string;
  tfType: string;
  cfg: Record<string, any>;
}

export interface AccessStatement {
  actions: string[];
  /** HCL expressions, e.g. `aws_sqs_queue.jobs.arn` or `"${aws_s3_bucket.media.arn}/*"`. */
  resources: string[];
  /** Set when the resources are one HCL expression that is already a list. */
  resourceList?: string;
}

/** How much of a resource a caller may use. Without one, a connection gets the full grant. */
export type AccessLevel = 'read' | 'write' | 'readwrite';

/** A narrower grant: the subset of the full grant's actions it keeps, and what the UI calls it. */
export interface AccessLevelSpec {
  label: string;
  actions: string[];
}

export interface AccessSpec {
  /** Short tag used in policy names: `<caller>_<key>_<target>`. */
  key: string;
  /**
   * Narrower grants a connection can choose instead of the full one, for resources whose full
   * grant mixes reading and writing. `readwrite` labels the full grant.
   */
  levels?: { read?: AccessLevelSpec; write?: AccessLevelSpec; readwrite: string };
  /** IAM statements the caller's role gets. Empty when access is by network only. */
  statements: (t: TargetRef) => AccessStatement[];
  /** Environment variables for callers that take them: suffix → value (an HCL template string body). */
  env: (t: TargetRef) => Record<string, string>;
}

const attr = (t: TargetRef, name: string) => `${t.tfType}.${t.name}.${name}`;
const tpl = (t: TargetRef, name: string) => `\${${attr(t, name)}}`;

/** What calling each kind of resource takes. A type missing here cannot be called. */
export const ACCESS: Record<string, AccessSpec> = {
  aws_dynamodb_table: {
    key: 'ddb',
    levels: {
      read: { label: 'Read', actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'] },
      write: { label: 'Write', actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'] },
      readwrite: 'Read and write',
    },
    statements: (t) => [
      {
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [attr(t, 'arn'), `"${tpl(t, 'arn')}/index/*"`],
      },
    ],
    env: (t) => ({ TABLE_NAME: tpl(t, 'name') }),
  },
  aws_s3_bucket: {
    key: 's3',
    levels: {
      read: { label: 'Read', actions: ['s3:GetObject', 's3:ListBucket'] },
      write: { label: 'Write', actions: ['s3:PutObject', 's3:DeleteObject'] },
      readwrite: 'Read and write',
    },
    statements: (t) => [
      {
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [attr(t, 'arn'), `"${tpl(t, 'arn')}/*"`],
      },
    ],
    env: (t) => ({ BUCKET_NAME: tpl(t, 'id') }),
  },
  aws_sqs_queue: {
    key: 'sqs',
    levels: {
      read: { label: 'Receive', actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'] },
      write: { label: 'Send', actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'] },
      readwrite: 'Send and receive',
    },
    statements: (t) => [
      {
        actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [attr(t, 'arn')],
      },
    ],
    env: (t) => ({ QUEUE_URL: tpl(t, 'url') }),
  },
  aws_sns_topic: {
    key: 'sns',
    statements: (t) => [{ actions: ['sns:Publish'], resources: [attr(t, 'arn')] }],
    env: (t) => ({ TOPIC_ARN: tpl(t, 'arn') }),
  },
  aws_secretsmanager_secret: {
    key: 'secret',
    statements: (t) => [
      { actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], resources: [attr(t, 'arn')] },
    ],
    env: (t) => ({ SECRET_ARN: tpl(t, 'arn') }),
  },
  aws_kms_key: {
    key: 'kms',
    levels: {
      read: { label: 'Decrypt', actions: ['kms:Decrypt', 'kms:DescribeKey'] },
      write: { label: 'Encrypt', actions: ['kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'] },
      readwrite: 'Both',
    },
    statements: (t) => [
      { actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [attr(t, 'arn')] },
    ],
    env: (t) => ({ KEY_ARN: tpl(t, 'arn') }),
  },
  aws_ssm_parameter: {
    key: 'ssm',
    statements: (t) => [{ actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: [attr(t, 'arn')] }],
    env: (t) => ({ PARAMETER_NAME: tpl(t, 'name') }),
  },
  aws_kinesis_stream: {
    key: 'kinesis',
    statements: (t) => [
      { actions: ['kinesis:PutRecord', 'kinesis:PutRecords', 'kinesis:DescribeStreamSummary'], resources: [attr(t, 'arn')] },
    ],
    env: (t) => ({ STREAM_NAME: tpl(t, 'name') }),
  },
  aws_cloudwatch_event_bus: {
    key: 'events',
    statements: (t) => [{ actions: ['events:PutEvents'], resources: [attr(t, 'arn')] }],
    env: (t) => ({ EVENT_BUS_NAME: tpl(t, 'name') }),
  },
  aws_sfn_state_machine: {
    key: 'sfn',
    statements: (t) => [{ actions: ['states:StartExecution'], resources: [attr(t, 'arn')] }],
    env: (t) => ({ STATE_MACHINE_ARN: tpl(t, 'arn') }),
  },
  aws_lambda_function: {
    key: 'invoke',
    statements: (t) => [{ actions: ['lambda:InvokeFunction'], resources: [attr(t, 'arn')] }],
    // The name as the compiler writes it, not a reference: two functions that call each other
    // (or a function and the state machine that runs it) must not depend on one another
    env: (t) => ({ FUNCTION_NAME: `\${local.name_prefix}-${t.name}` }),
  },
  aws_opensearch_domain: {
    key: 'opensearch',
    statements: (t) => [
      {
        actions: ['es:ESHttpGet', 'es:ESHttpHead', 'es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpDelete'],
        resources: [`"${tpl(t, 'arn')}/*"`],
      },
    ],
    env: (t) => ({ ENDPOINT: tpl(t, 'endpoint') }),
  },
  aws_cloudwatch_log_group: {
    key: 'logs',
    statements: (t) => [
      { actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`"${tpl(t, 'arn')}:*"`] },
    ],
    env: (t) => ({ LOG_GROUP_NAME: tpl(t, 'name') }),
  },
  aws_ecr_repository: {
    key: 'ecr',
    statements: (t) => [
      { actions: ['ecr:GetAuthorizationToken'], resources: ['"*"'] },
      {
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        resources: [attr(t, 'arn')],
      },
    ],
    env: (t) => ({ REPOSITORY_URL: tpl(t, 'repository_url') }),
  },
  aws_efs_file_system: {
    key: 'efs',
    levels: {
      read: { label: 'Read only', actions: ['elasticfilesystem:ClientMount'] },
      readwrite: 'Read and write',
    },
    statements: (t) => [
      { actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'], resources: [attr(t, 'arn')] },
    ],
    env: (t) => ({ FILE_SYSTEM_ID: tpl(t, 'id') }),
  },
  aws_db_instance: {
    key: 'db',
    // RDS keeps the master password in a secret it manages; the caller reads it at runtime. The
    // fallback pattern covers providers that don't report the secret back (it is how RDS names them).
    statements: (t) => [
      {
        actions: ['secretsmanager:GetSecretValue'],
        resources: [],
        resourceList: `coalescelist(${attr(t, 'master_user_secret[*].secret_arn')}, ["arn:aws:secretsmanager:*:*:secret:rds!*"])`,
      },
    ],
    env: (t) => ({
      HOST: tpl(t, 'address'),
      PORT: tpl(t, 'port'),
      NAME: tpl(t, 'db_name'),
      SECRET_ARN: `\${try(${attr(t, 'master_user_secret[0].secret_arn')}, "")}`,
    }),
  },
  aws_elasticache_cluster: {
    key: 'cache',
    // Reached over the network; there is nothing for IAM to grant
    statements: () => [],
    env: (t) =>
      t.tfType === 'aws_elasticache_replication_group'
        ? { HOST: tpl(t, 'primary_endpoint_address'), PORT: tpl(t, 'port') }
        : { HOST: tpl(t, 'cache_nodes[0].address'), PORT: tpl(t, 'port') },
  },
  aws_iam_role: {
    key: 'assume',
    statements: (t) => [{ actions: ['sts:AssumeRole'], resources: [attr(t, 'arn')] }],
    env: (t) => ({ ROLE_ARN: tpl(t, 'arn') }),
  },
  aws_bedrock_agent: {
    key: 'agent',
    statements: (t) => [
      {
        actions: ['bedrock:InvokeAgent'],
        resources: [`"\${replace(${attr(t, 'agent_arn')}, ":agent/", ":agent-alias/")}/*"`],
      },
    ],
    env: (t) => ({ AGENT_ID: tpl(t, 'agent_id') }),
  },
};

export interface CallerSpec {
  /** The IAM role grants attach to: `aws_iam_role.<this>`. */
  role: (name: string) => string;
  /** Whether the compiler passes environment variables to this caller's code. */
  takesEnv: boolean;
  /**
   * The role only exists when something is granted (EC2 gets an instance profile, EKS a pod
   * identity role). The others always have their role.
   */
  roleOnDemand?: boolean;
}

/** Things that run code and may call other resources, and the role their grants go on. */
export const CALLERS: Record<string, CallerSpec> = {
  aws_lambda_function: { role: (n) => `${n}_exec_role`, takesEnv: true },
  aws_ecs_service: { role: (n) => `${n}_task_role`, takesEnv: true },
  aws_instance: { role: (n) => `${n}_instance_role`, takesEnv: false, roleOnDemand: true },
  aws_autoscaling_group: { role: (n) => `${n}_instance_role`, takesEnv: false, roleOnDemand: true },
  aws_eks_cluster: { role: (n) => `${n}_pod_role`, takesEnv: false, roleOnDemand: true },
  aws_sfn_state_machine: { role: (n) => `${n}_sfn_role`, takesEnv: false },
  aws_bedrock_agent: { role: (n) => `${n}_agent_role`, takesEnv: false },
};

/**
 * Events and traffic: what each non-calling service can deliver to. Front doors (CloudFront, load
 * balancers, DNS, API Gateway, Cognito) only ever point inward, so they appear as sources only.
 */
export const TRIGGERS: Record<string, string[]> = {
  aws_apigatewayv2_api: ['aws_lambda_function', 'aws_sfn_state_machine', 'aws_sqs_queue', 'aws_cloudwatch_event_bus', 'aws_kinesis_stream', 'aws_lb'],
  aws_sqs_queue: ['aws_lambda_function', 'aws_ecs_service'],
  aws_sns_topic: ['aws_lambda_function', 'aws_sqs_queue'],
  aws_kinesis_stream: ['aws_lambda_function', 'aws_ecs_service'],
  aws_cloudwatch_event_bus: ['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic', 'aws_sfn_state_machine'],
  aws_dynamodb_table: ['aws_lambda_function'],
  aws_s3_bucket: ['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic'],
  aws_cloudfront_distribution: ['aws_s3_bucket', 'aws_lb', 'aws_apigatewayv2_api', 'aws_lambda_function'],
  aws_lb: ['aws_lambda_function', 'aws_ecs_service', 'aws_instance', 'aws_autoscaling_group'],
  aws_route53_zone: ['aws_cloudfront_distribution', 'aws_lb'],
  aws_cognito_user_pool: ['aws_apigatewayv2_api', 'aws_lambda_function'],
  aws_ecr_repository: ['aws_ecs_service'],
};

export const FRONT_DOOR = new Set(['aws_cloudfront_distribution', 'aws_lb', 'aws_route53_zone', 'aws_apigatewayv2_api', 'aws_cognito_user_pool']);

/** What each network resource sets on what: the VPC id, the subnets, or the security groups. */
export const NETWORK_PLACEMENT: Record<string, string[]> = {
  aws_vpc: ['aws_subnet', 'aws_security_group', 'aws_internet_gateway', 'aws_route_table', 'aws_lb', 'aws_route53_zone'],
  aws_subnet: [
    'aws_nat_gateway',
    'aws_route_table',
    'aws_lb',
    'aws_instance',
    'aws_autoscaling_group',
    'aws_ecs_service',
    'aws_eks_cluster',
    'aws_db_instance',
    'aws_elasticache_cluster',
  ],
  aws_security_group: [
    'aws_lb',
    'aws_instance',
    'aws_autoscaling_group',
    'aws_ecs_service',
    'aws_eks_cluster',
    'aws_db_instance',
    'aws_elasticache_cluster',
  ],
};

/** Every type some network resource can place. */
export const NETWORKED = new Set(Object.values(NETWORK_PLACEMENT).flat());

/**
 * Pairs people reasonably try that mean something in AWS but that LocalCloud can't generate
 * honestly, with the reason shown when the connection is refused.
 */
export const NOT_MODELLED: Record<string, string> = {
  'aws_apigatewayv2_api>aws_sns_topic':
    'HTTP APIs have no direct SNS integration. Route to a Lambda or an EventBridge bus that publishes to the topic.',
  'aws_sqs_queue>aws_sfn_state_machine':
    "A queue can't start a state machine on its own. Put a Lambda between them.",
  'aws_lb>aws_eks_cluster':
    'Load balancers for EKS are created from inside the cluster (AWS Load Balancer Controller), not from here.',
  'aws_route53_zone>aws_apigatewayv2_api':
    "DNS can only point at an API that has a custom domain and certificate, which LocalCloud doesn't model. Put CloudFront in front of the API.",
  'aws_cognito_user_pool>aws_lb':
    "Cognito sign-in on a load balancer needs an HTTPS listener and certificate, which LocalCloud doesn't model.",
  'aws_ecr_repository>aws_eks_cluster':
    "Images are pulled by the cluster's nodes, and LocalCloud doesn't model node groups.",
  'aws_ecr_repository>aws_lambda_function':
    'Lambda functions here deploy from a zip (inline code or a folder), not a container image.',
};

/** The levels a connection to `targetType` can choose, in display order; empty when it has only the full grant. */
export function accessLevelsFor(targetType: string): { value: AccessLevel; label: string }[] {
  const levels = ACCESS[targetType]?.levels;
  if (!levels) return [];
  return [
    ...(levels.read ? [{ value: 'read' as const, label: levels.read.label }] : []),
    ...(levels.write ? [{ value: 'write' as const, label: levels.write.label }] : []),
    { value: 'readwrite' as const, label: levels.readwrite },
  ];
}

/**
 * The statements a caller gets for one connection: the full grant, narrowed to the connection's
 * access level when the target offers that level. An unknown or unavailable level gets the full grant.
 */
export function accessStatements(targetType: string, t: TargetRef, level: unknown): AccessStatement[] {
  const spec = ACCESS[targetType];
  if (!spec) return [];
  const all = spec.statements(t);
  const narrower = level === 'read' || level === 'write' ? spec.levels?.[level] : undefined;
  if (!narrower) return all;
  const keep = new Set(narrower.actions);
  return all.map((s) => ({ ...s, actions: s.actions.filter((a) => keep.has(a)) })).filter((s) => s.actions.length > 0);
}

export type CallWiring = { grant: boolean; env: boolean };

/** What a caller gets from calling a target, or null when the pair generates nothing. */
export function callWiring(sourceType: string, targetType: string): CallWiring | null {
  const caller = CALLERS[sourceType];
  const access = ACCESS[targetType];
  if (!caller || !access) return null;
  // Probe with a placeholder: whether a spec has statements never depends on the target's config
  const probe: TargetRef = { name: 'x', tfType: targetType, cfg: {} };
  const grant = access.statements(probe).length > 0;
  const env = caller.takesEnv && Object.keys(access.env(probe)).length > 0;
  return grant || env ? { grant, env } : null;
}
