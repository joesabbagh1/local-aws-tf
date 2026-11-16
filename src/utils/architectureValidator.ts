import type { CloudNode, CloudEdge, EnvironmentId, EnvironmentProfile, LintFinding } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { resolveNodeConfigForEnv } from './terraformCompiler';
import { emulatorSupport } from './emulatorSupport';
import { isProductionEnv } from './environments';

export function runArchitectureLinter(
  nodes: CloudNode[],
  edges: CloudEdge[],
  activeEnv: EnvironmentId,
  /** The project's environments; decides which ones get the production-only checks. */
  environments?: Partial<Record<EnvironmentId, Pick<EnvironmentProfile, 'production'>>>
): LintFinding[] {
  const findings: LintFinding[] = [];
  const isProd = isProductionEnv({ id: activeEnv, production: environments?.[activeEnv]?.production });
  const envTag = activeEnv.toUpperCase();
  const activeNodes = nodes.filter((n) => n.data.envEnabled?.[activeEnv] !== false);
  const nodeById = Object.fromEntries(activeNodes.map((n) => [n.id, n]));

  const incomingCount: Record<string, number> = {};
  const outgoingCount: Record<string, number> = {};
  for (const e of edges) {
    incomingCount[e.target] = (incomingCount[e.target] || 0) + 1;
    outgoingCount[e.source] = (outgoingCount[e.source] || 0) + 1;
  }

  for (const node of activeNodes) {
    const type = node.data.serviceType;
    const cfg = resolveNodeConfigForEnv(node, activeEnv);
    const totalConnections = (incomingCount[node.id] || 0) + (outgoingCount[node.id] || 0);

    // 1. Orphaned compute / integration resource check
    if (
      totalConnections === 0 &&
      nodes.length > 1 &&
      type !== 'aws_vpc' &&
      type !== 'aws_kms_key' &&
      type !== 'aws_ssm_parameter'
    ) {
      findings.push({
        id: `orphan-${node.id}`,
        severity: 'info',
        category: 'Networking',
        title: `${node.data.label} is not wired to any resource`,
        description: `Drag a handle from or to ${node.data.label} so LocalCloud Studio can automatically generate IAM permissions, event triggers, or VPC placement.`,
        nodeId: node.id,
        envId: activeEnv,
      });
    }

    // 2. S3 Public Access check
    if (type === 'aws_s3_bucket' && cfg.block_public_acls === false) {
      findings.push({
        id: `s3-public-${node.id}`,
        severity: 'warning',
        category: 'Security',
        title: `S3 Bucket "${node.data.label}" allows public ACLs`,
        description: `Public access block is disabled in [${activeEnv.toUpperCase()}]. Enable block_public_acls unless serving static public assets directly.`,
        nodeId: node.id,
        envId: activeEnv,
        remediation: 'Enable "Block All Public Access" in the Inspector.',
      });
    }

    // 3. Production RDS Single-AZ or Skip Final Snapshot check
    if (type === 'aws_db_instance' && isProd) {
      if (!cfg.multi_az) {
        findings.push({
          id: `rds-multiaz-${node.id}`,
          severity: 'warning',
          category: 'Reliability',
          title: `Production RDS "${node.data.label}" is Single-AZ`,
          description: `Multi-AZ standby deployment is disabled in ${envTag}. Enable multi_az for automatic failover protection.`,
          nodeId: node.id,
          envId: activeEnv,
          remediation: `Toggle "Multi-AZ Standby Deployment" on for ${envTag}.`,
        });
      }
      if (cfg.skip_final_snapshot) {
        findings.push({
          id: `rds-snapshot-${node.id}`,
          severity: 'info',
          category: 'Reliability',
          title: `Production RDS "${node.data.label}" skips final snapshot`,
          description: `skip_final_snapshot is true in ${envTag}. Set to false to retain a recovery snapshot on deletion.`,
          nodeId: node.id,
          envId: activeEnv,
        });
      }
    }

    // 4. Security Group 0.0.0.0/0 on sensitive ports (SSH 22, Postgres 5432, MySQL 3306, Redis 6379)
    if (type === 'aws_security_group') {
      const port = Number(cfg.ingress_port ?? 443);
      const cidr = String(cfg.ingress_cidr || '0.0.0.0/0');
      if (cidr === '0.0.0.0/0' && [22, 3389, 5432, 3306, 6379].includes(port)) {
        findings.push({
          id: `sg-open-${node.id}`,
          severity: 'error',
          category: 'Security',
          title: `Security Group opens sensitive port ${port} to 0.0.0.0/0`,
          description: `"${node.data.label}" allows unrestricted public ingress on port ${port} in [${activeEnv.toUpperCase()}]. Restrict to your VPC CIDR (e.g. 10.0.0.0/16).`,
          nodeId: node.id,
          envId: activeEnv,
        });
      }
    }

    // 5. SQS Queue without DLQ in Production
    if (type === 'aws_sqs_queue' && isProd && !cfg.enable_dlq) {
      findings.push({
        id: `sqs-dlq-${node.id}`,
        severity: 'warning',
        category: 'Reliability',
        title: `SQS Queue "${node.data.label}" has no Dead-Letter Queue (DLQ)`,
        description: `Poison-pill messages in ${envTag} could loop until retention expiry. Enable companion DLQ generation.`,
        nodeId: node.id,
        envId: activeEnv,
      });
    }

    // 6. Cognito MFA disabled in Production
    if (
      type === 'aws_cognito_user_pool' &&
      isProd &&
      cfg.mfa_configuration === 'OFF'
    ) {
      findings.push({
        id: `cognito-mfa-${node.id}`,
        severity: 'warning',
        category: 'Security',
        title: `Cognito Pool "${node.data.label}" has MFA disabled in ${envTag}`,
        description: `Consider setting mfa_configuration to OPTIONAL or ON for production customer identity pools.`,
        nodeId: node.id,
        envId: activeEnv,
      });
    }

    // 7. Services the emulator test run found failing (npm run test:emulator)
    const svc = SERVICE_BY_TYPE[type];
    const support = emulatorSupport(svc);
    if (svc?.deprecated) {
      findings.push({
        id: `deprecated-${node.id}`,
        severity: 'warning',
        category: 'Emulator',
        title: `${svc.shortName} is deprecated`,
        description: svc.deprecated,
        nodeId: node.id,
        envId: activeEnv,
        remediation: 'It still compiles and exports, but new designs should use the replacement.',
      });
    } else if (support.level === 'fails') {
      findings.push({
        id: `emulator-support-${node.id}`,
        severity: 'warning',
        category: 'Emulator',
        title: `${svc.shortName} failed on the emulator in tests`,
        description: support.errors[0] || 'It did not apply cleanly in the last emulator test run.',
        nodeId: node.id,
        envId: activeEnv,
        remediation: 'Expect apply to fail locally for this resource. The AWS export is not affected.',
      });
    }
  }

  // S3 refuses two notifications for the same events on the same keys
  const NOTIFIED = new Set(['aws_lambda_function', 'aws_sqs_queue', 'aws_sns_topic']);
  for (const bucket of activeNodes.filter((n) => n.data.serviceType === 'aws_s3_bucket')) {
    const notified = edges.filter(
      (e) =>
        e.source === bucket.id &&
        e.data?.relationshipType !== 'depends_on' &&
        NOTIFIED.has(nodeById[e.target]?.data.serviceType ?? '')
    );
    const prefixes = notified.map((e) => (/^[^\s]+\/$/.test(String(e.data?.label || '').trim()) ? String(e.data?.label).trim() : ''));
    const overlap = prefixes.some((p, i) => prefixes.some((q, j) => i !== j && (p.startsWith(q) || q.startsWith(p))));
    if (notified.length > 1 && overlap) {
      findings.push({
        id: `s3-overlap-${bucket.id}`,
        severity: 'warning',
        category: 'Reliability',
        title: `S3 Bucket "${bucket.data.label}" notifies ${notified.length} targets about the same objects`,
        description: `AWS rejects overlapping notifications on one bucket, so apply fails outside the emulator.`,
        nodeId: bucket.id,
        envId: activeEnv,
        remediation: 'Give each connection a key prefix as its label (e.g. "uploads/"), or notify one SNS topic and fan out from there.',
      });
    }
  }

  // Check if RDS is wired directly to a Public Subnet
  for (const edge of edges) {
    const src = nodeById[edge.source];
    const dst = nodeById[edge.target];
    if (
      src?.data.serviceType === 'aws_subnet' &&
      dst?.data.serviceType === 'aws_db_instance'
    ) {
      const subCfg = resolveNodeConfigForEnv(src, activeEnv);
      if (subCfg.map_public_ip_on_launch || subCfg.tier === 'public') {
        findings.push({
          id: `rds-public-sub-${dst.id}`,
          severity: 'error',
          category: 'Security',
          title: `Database "${dst.data.label}" placed in Public Subnet "${src.data.label}"`,
          description: `Relational databases should reside in private or isolated subnets without auto-assigned public IPv4 addresses.`,
          nodeId: dst.id,
          envId: activeEnv,
        });
      }
    }
  }

  return findings;
}
