import type { CloudNode, EnvironmentId } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';

/** Naming and config helpers shared by the compiler and everything that has to agree with it. */

export function resolveNodeConfigForEnv(node: CloudNode, envId: EnvironmentId): Record<string, any> {
  const base = node.data.baseConfig || {};
  const overrides = node.data.envOverrides?.[envId] || {};
  return {
    ...base,
    ...overrides,
  };
}

export function sanitizeIdentifier(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z_]+/, 'res_')
      .replace(/_+/g, '_')
      .replace(/_$/, '') || 'aws_resource'
  );
}

/** The Terraform resource name a node compiles to. */
export function tfName(node: CloudNode): string {
  return sanitizeIdentifier(node.data.resourceName || node.data.label);
}

/** Lowercase letters, digits and hyphens only, as AWS wants for DNS-style names. */
export function dnsSlug(base: string): string {
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Name expression for resources whose AWS names allow only lowercase letters, digits and hyphens
 * (load balancers, target groups, S3 buckets, RDS, ElastiCache, OpenSearch). Underscores become
 * hyphens and the name is cut to the service's limit without leaving a trailing hyphen.
 */
export function dnsSafeName(base: string, maxLength: number): string {
  return `trimsuffix(substr("\${local.name_prefix}-${dnsSlug(base)}", 0, ${maxLength}), "-")`;
}

/** Redis with more than one node is a replication group, not a cluster. */
export function isRedisReplicationGroup(serviceType: string, cfg: Record<string, any>): boolean {
  return serviceType === 'aws_elasticache_cluster' && (cfg.engine || 'redis') === 'redis' && Number(cfg.num_cache_nodes ?? 1) > 1;
}

/**
 * The Terraform type of a node's main resource, which can depend on its config (multi-node Redis).
 * Status, outputs and Extra HCL all attach to `<this type>.<resource name>`.
 */
export function mainResourceType(node: CloudNode, cfg: Record<string, any>): string {
  if (isRedisReplicationGroup(node.data.serviceType, cfg)) return 'aws_elasticache_replication_group';
  return SERVICE_BY_TYPE[node.data.serviceType]?.terraformResourceType || node.data.serviceType;
}

/**
 * The name the deployed resource carries in AWS for one environment, as the compiler writes it.
 * The data explorer and scenarios use it to find a canvas node's live counterpart.
 */
export function liveResourceName(node: CloudNode, envId: EnvironmentId): string {
  const res = tfName(node);
  const cfg = resolveNodeConfigForEnv(node, envId);
  const prefixed = `lc-${envId}-${res}`;
  switch (node.data.serviceType) {
    case 'aws_s3_bucket':
      return `lc-${envId}-${dnsSlug(String(cfg.bucket_prefix || res))}`.slice(0, 63).replace(/-$/, '');
    case 'aws_sqs_queue':
      return cfg.fifo_queue ? `${prefixed}.fifo` : prefixed;
    case 'aws_sns_topic':
      return cfg.fifo_topic ? `${prefixed}.fifo` : prefixed;
    case 'aws_cloudwatch_log_group':
      return `${cfg.log_group_prefix || '/aws/localcloud'}/${envId}/${res}`;
    default:
      return prefixed;
  }
}
