import type { CloudEdge, CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { ACCESS, CALLERS, FRONT_DOOR, NETWORKED, NETWORK_PLACEMENT, NOT_MODELLED, TRIGGERS, callWiring } from './wiringCatalog';

type Relationship = NonNullable<CloudEdge['data']>['relationshipType'];

export type ConnectionCheck =
  | { ok: true; relationshipType: Relationship; label: string }
  | { ok: false; reason: string };

const NETWORK = new Set(Object.keys(NETWORK_PLACEMENT));

const EVENT_SOURCES = new Set(['aws_apigatewayv2_api', 'aws_sqs_queue', 'aws_sns_topic', 'aws_kinesis_stream', 'aws_cloudwatch_event_bus', 'aws_dynamodb_table', 'aws_s3_bucket']);
const DATA_TARGETS = new Set(['aws_dynamodb_table', 'aws_s3_bucket', 'aws_secretsmanager_secret', 'aws_kms_key']);

const short = (type: string) => SERVICE_BY_TYPE[type]?.shortName || type;

/** Why a network resource has nothing to set on a resource another network resource does place. */
function misplacedReason(s: string, t: string): string {
  const hint =
    s === 'aws_vpc'
      ? `Draw from a Subnet instead, or drop the ${short(t)} inside one.`
      : s === 'aws_subnet'
        ? `A ${short(t)} belongs to the VPC, not to one subnet.`
        : `Security groups attach to resources with network interfaces.`;
  return `A ${short(s)} has nothing to set on a ${short(t)}. ${hint}`;
}

/**
 * Whether `source → target` means anything, and if so how it is wired. Only pairs the compiler
 * generates Terraform for are accepted (see wiringCatalog.ts), so a drawn connection always does
 * something.
 */
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
    if (NETWORK_PLACEMENT[s].includes(t)) return { ok: true, relationshipType: 'network_attachment', label: 'VPC Network' };
    return NETWORKED.has(t)
      ? { ok: false, reason: misplacedReason(s, t) }
      : { ok: false, reason: `${short(t)} isn't placed in a network, so a ${short(s)} has nothing to attach to.` };
  }

  const notModelled = NOT_MODELLED[`${s}>${t}`];
  if (notModelled) return { ok: false, reason: notModelled };

  const isCaller = Boolean(CALLERS[s]);
  if (isCaller) {
    if (FRONT_DOOR.has(t)) {
      return { ok: false, reason: `${short(s)} → ${short(t)} doesn't mean anything to AWS. Draw from the caller to what it calls.` };
    }
    if (!callWiring(s, t)) {
      return {
        ok: false,
        reason: ACCESS[t]
          ? `${short(t)} is reached over the network, so there is nothing to generate for ${short(s)} → ${short(t)}. Put both in the same VPC.`
          : `LocalCloud has nothing to generate for ${short(s)} → ${short(t)}.`,
      };
    }
  } else if (!(TRIGGERS[s] || []).includes(t)) {
    return {
      ok: false,
      reason: TRIGGERS[s]
        ? `${short(s)} → ${short(t)} doesn't mean anything to AWS. Draw from the caller to what it calls.`
        : `${short(s)} doesn't call other services. Draw the connection from whatever uses it.`,
    };
  }

  if (EVENT_SOURCES.has(s) && !isCaller) return { ok: true, relationshipType: 'event_trigger', label: 'Event Trigger' };
  if (s === 'aws_lb' || s === 'aws_cloudfront_distribution' || s === 'aws_route53_zone') {
    return { ok: true, relationshipType: 'target_route', label: 'Route Traffic' };
  }
  if (DATA_TARGETS.has(t)) return { ok: true, relationshipType: 'iam_grant', label: 'IAM Policy & Data' };
  return { ok: true, relationshipType: 'data_flow', label: 'Connects To' };
}
