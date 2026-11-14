import type { CloudEdge, CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';

type Relationship = NonNullable<CloudEdge['data']>['relationshipType'];

export type ConnectionCheck =
  | { ok: true; relationshipType: Relationship; label: string }
  | { ok: false; reason: string };

/** Resources the compiler places in a VPC / subnet / security group (it reads their network inputs). */
const NETWORKED = new Set([
  'aws_subnet',
  'aws_internet_gateway',
  'aws_nat_gateway',
  'aws_route_table',
  'aws_security_group',
  'aws_lb',
  'aws_route53_zone',
  'aws_instance',
  'aws_autoscaling_group',
  'aws_ecs_service',
  'aws_eks_cluster',
  'aws_db_instance',
  'aws_elasticache_cluster',
]);
const NETWORK = new Set(['aws_vpc', 'aws_subnet', 'aws_security_group']);

/** Things that run code and may call other services. */
const COMPUTE = new Set([
  'aws_lambda_function',
  'aws_ecs_service',
  'aws_instance',
  'aws_autoscaling_group',
  'aws_eks_cluster',
  'aws_sfn_state_machine',
  'aws_bedrock_agent',
]);

/**
 * What each non-compute service can sensibly point at. Compute can point at anything except the
 * network and the front door (CloudFront, load balancers, DNS, API Gateway, Cognito point inward).
 * Services missing here (databases, keys, secrets, logs, roles…) only receive connections.
 */
const TARGETS: Record<string, string[]> = {
  aws_apigatewayv2_api: ['aws_lambda_function', 'aws_sfn_state_machine', 'aws_sqs_queue', 'aws_sns_topic', 'aws_lb'],
  aws_sqs_queue: ['aws_lambda_function', 'aws_sfn_state_machine', 'aws_ecs_service'],
  aws_sns_topic: ['aws_lambda_function', 'aws_sqs_queue'],
  aws_kinesis_stream: ['aws_lambda_function', 'aws_ecs_service'],
  aws_cloudwatch_event_bus: ['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic', 'aws_sfn_state_machine'],
  aws_dynamodb_table: ['aws_lambda_function'],
  aws_s3_bucket: ['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic'],
  aws_cloudfront_distribution: ['aws_s3_bucket', 'aws_lb', 'aws_apigatewayv2_api', 'aws_lambda_function'],
  aws_lb: ['aws_lambda_function', 'aws_ecs_service', 'aws_instance', 'aws_autoscaling_group', 'aws_eks_cluster'],
  aws_route53_zone: ['aws_cloudfront_distribution', 'aws_lb', 'aws_apigatewayv2_api'],
  aws_cognito_user_pool: ['aws_apigatewayv2_api', 'aws_lb', 'aws_lambda_function'],
  aws_ecr_repository: ['aws_ecs_service', 'aws_eks_cluster', 'aws_lambda_function'],
};
const FRONT_DOOR = new Set(['aws_cloudfront_distribution', 'aws_lb', 'aws_route53_zone', 'aws_apigatewayv2_api', 'aws_cognito_user_pool']);

const EVENT_SOURCES = new Set(['aws_apigatewayv2_api', 'aws_sqs_queue', 'aws_sns_topic', 'aws_kinesis_stream', 'aws_cloudwatch_event_bus', 'aws_dynamodb_table', 'aws_s3_bucket']);
const DATA_TARGETS = new Set(['aws_dynamodb_table', 'aws_s3_bucket', 'aws_secretsmanager_secret', 'aws_kms_key']);

const short = (type: string) => SERVICE_BY_TYPE[type]?.shortName || type;

/** Whether `source → target` means anything, and if so how it is wired. */
export function checkConnection(source: CloudNode | undefined, target: CloudNode | undefined, edges: CloudEdge[]): ConnectionCheck {
  if (!source || !target) return { ok: false, reason: 'Connect two resources.' };
  if (source.id === target.id) return { ok: false, reason: 'A resource can’t connect to itself.' };
  if (edges.some((e) => e.source === source.id && e.target === target.id)) {
    return { ok: false, reason: `${source.data.label} is already connected to ${target.data.label}.` };
  }

  const s = source.data.serviceType;
  const t = target.data.serviceType;

  if (NETWORK.has(t) && !(s === 'aws_vpc' && t === 'aws_subnet') && !(s === 'aws_vpc' && t === 'aws_security_group')) {
    return { ok: false, reason: `Nothing connects into a ${short(t)}. Draw from the ${short(t)} to the resource, or drop the resource inside it.` };
  }
  if (NETWORK.has(s)) {
    if (s === 'aws_vpc' && (t === 'aws_subnet' || t === 'aws_security_group')) {
      return { ok: true, relationshipType: 'network_attachment', label: 'VPC Network' };
    }
    return NETWORKED.has(t)
      ? { ok: true, relationshipType: 'network_attachment', label: 'VPC Network' }
      : { ok: false, reason: `${short(t)} isn't placed in a network, so a ${short(s)} has nothing to attach to.` };
  }

  const allowed = COMPUTE.has(s) ? !NETWORK.has(t) && !FRONT_DOOR.has(t) : (TARGETS[s] || []).includes(t);
  if (!allowed) {
    return {
      ok: false,
      reason: TARGETS[s] || COMPUTE.has(s)
        ? `${short(s)} → ${short(t)} doesn't mean anything to AWS. Draw from the caller to what it calls.`
        : `${short(s)} doesn't call other services. Draw the connection from whatever uses it.`,
    };
  }

  if (EVENT_SOURCES.has(s) && !COMPUTE.has(s)) return { ok: true, relationshipType: 'event_trigger', label: 'Event Trigger' };
  if (s === 'aws_lb' || s === 'aws_cloudfront_distribution' || s === 'aws_route53_zone') {
    return { ok: true, relationshipType: 'target_route', label: 'Route Traffic' };
  }
  if (DATA_TARGETS.has(t)) return { ok: true, relationshipType: 'iam_grant', label: 'IAM Policy & Data' };
  return { ok: true, relationshipType: 'data_flow', label: 'Connects To' };
}
