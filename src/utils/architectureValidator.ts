import type {
  CloudNode,
  CloudEdge,
  EnvironmentId,
  LintFinding,
  CostBreakdownItem,
} from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { resolveNodeConfigForEnv } from './terraformCompiler';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

const EC2_HOURLY_USD: Record<string, number> = {
  't3.nano': 0.0052,
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  'm6i.large': 0.096,
  'm6i.xlarge': 0.192,
  'c6i.xlarge': 0.17,
  'c6i.2xlarge': 0.34,
};

const RDS_HOURLY_USD: Record<string, number> = {
  'db.t4g.micro': 0.016,
  'db.t4g.small': 0.032,
  'db.t4g.medium': 0.065,
  'db.r6g.large': 0.24,
  'db.r6g.xlarge': 0.48,
};

const CACHE_HOURLY_USD: Record<string, number> = {
  'cache.t4g.micro': 0.016,
  'cache.t4g.small': 0.032,
  'cache.t4g.medium': 0.065,
  'cache.r6g.large': 0.226,
};

const OPENSEARCH_HOURLY_USD: Record<string, number> = {
  't3.small.search': 0.036,
  'm6g.large.search': 0.128,
  'r6g.xlarge.search': 0.334,
};

export function estimateArchitectureCosts(nodes: CloudNode[]): {
  items: CostBreakdownItem[];
  totalsByEnv: Record<EnvironmentId, number>;
} {
  const items: CostBreakdownItem[] = [];
  const totalsByEnv: Record<EnvironmentId, number> = {
    dev: 0,
    testing: 0,
    staging: 0,
    prod: 0,
  };

  for (const node of nodes) {
    const type = node.data.serviceType;
    const monthlyUsd: Record<EnvironmentId, number> = {
      dev: 0,
      testing: 0,
      staging: 0,
      prod: 0,
    };
    const sizingNotes: Record<EnvironmentId, string> = {
      dev: '',
      testing: '',
      staging: '',
      prod: '',
    };

    for (const envId of ENV_IDS) {
      if (node.data.envEnabled?.[envId] === false) {
        monthlyUsd[envId] = 0;
        sizingNotes[envId] = 'Disabled';
        continue;
      }

      const cfg = resolveNodeConfigForEnv(node, envId);
      let cost = 0;
      let note = '';

      switch (type) {
        case 'aws_instance': {
          const it = cfg.instance_type || 't3.micro';
          const hourly = EC2_HOURLY_USD[it] || 0.02;
          const vol = Number(cfg.root_volume_size ?? 20) * 0.08;
          cost = hourly * 730 + vol;
          note = `${it} + ${cfg.root_volume_size || 20}GB EBS`;
          break;
        }
        case 'aws_autoscaling_group': {
          const it = cfg.instance_type || 't3.medium';
          const count = Number(cfg.desired_capacity ?? 2);
          const hourly = EC2_HOURLY_USD[it] || 0.0416;
          cost = hourly * 730 * count;
          note = `${count}x ${it}`;
          break;
        }
        case 'aws_ecs_service': {
          const cpuUnits = Number(cfg.cpu ?? 256) / 1024;
          const memGb = Number(cfg.memory ?? 512) / 1024;
          const tasks = Number(cfg.desired_count ?? 2);
          const perTaskMonth = (cpuUnits * 0.04048 + memGb * 0.004445) * 730;
          cost = perTaskMonth * tasks;
          note = `${tasks}x (${cfg.cpu} CPU / ${cfg.memory} MiB)`;
          break;
        }
        case 'aws_eks_cluster': {
          const controlPlane = 73.0;
          const it = cfg.node_instance_type || 'm6i.large';
          const nodesCount = Number(cfg.node_desired_size ?? 2);
          const hourly = EC2_HOURLY_USD[it] || 0.096;
          cost = controlPlane + hourly * 730 * nodesCount;
          note = `Control Plane + ${nodesCount}x ${it}`;
          break;
        }
        case 'aws_db_instance': {
          const ic = cfg.instance_class || 'db.t4g.micro';
          const hourly = RDS_HOURLY_USD[ic] || 0.032;
          const multiAzMult = cfg.multi_az ? 2 : 1;
          const storageCost = Number(cfg.allocated_storage ?? 20) * 0.115 * multiAzMult;
          cost = hourly * 730 * multiAzMult + storageCost;
          note = `${ic}${cfg.multi_az ? ' (Multi-AZ)' : ' (Single-AZ)'}`;
          break;
        }
        case 'aws_elasticache_cluster': {
          const nt = cfg.node_type || 'cache.t4g.micro';
          const count = Number(cfg.num_cache_nodes ?? 1);
          const hourly = CACHE_HOURLY_USD[nt] || 0.016;
          cost = hourly * 730 * count;
          note = `${count}x ${nt}`;
          break;
        }
        case 'aws_dynamodb_table': {
          if (cfg.billing_mode === 'PROVISIONED') {
            const rcu = Number(cfg.read_capacity ?? 5);
            const wcu = Number(cfg.write_capacity ?? 5);
            cost = rcu * 0.00013 * 730 + wcu * 0.00065 * 730 + 2.5;
            note = `Prov (${rcu} RCU / ${wcu} WCU)`;
          } else {
            cost = envId === 'prod' ? 18.5 : 3.25;
            note = 'Pay-per-request';
          }
          if (cfg.point_in_time_recovery) cost += 2.0;
          break;
        }
        case 'aws_lambda_function': {
          const memGb = Number(cfg.memory_size ?? 256) / 1024;
          const baseReqs = envId === 'prod' ? 2_500_000 : 150_000;
          cost = (baseReqs / 1_000_000) * 0.2 + memGb * (baseReqs * 0.15) * 0.0000166667;
          if (Number(cfg.reserved_concurrent_executions) > 0) {
            cost += Number(cfg.reserved_concurrent_executions) * 0.15;
          }
          note = `${cfg.memory_size}MB (${cfg.architectures || 'arm64'})`;
          break;
        }
        case 'aws_lb': {
          cost = 16.43 + (envId === 'prod' ? 12.0 : 2.5);
          note = `${cfg.load_balancer_type || 'application'} LB`;
          break;
        }
        case 'aws_nat_gateway': {
          cost = 32.85 + (envId === 'prod' ? 15.0 : 2.0);
          note = 'NAT GW + Data Processing';
          break;
        }
        case 'aws_opensearch_domain': {
          const it = cfg.instance_type || 't3.small.search';
          const count = Number(cfg.instance_count ?? 1);
          const hourly = OPENSEARCH_HOURLY_USD[it] || 0.036;
          const ebs = Number(cfg.ebs_volume_size ?? 20) * 0.1 * count;
          cost = hourly * 730 * count + ebs;
          note = `${count}x ${it}`;
          break;
        }
        case 'aws_cloudfront_distribution': {
          cost = envId === 'prod' ? 24.0 : 2.5;
          note = cfg.price_class || 'PriceClass_100';
          break;
        }
        case 'aws_apigatewayv2_api': {
          cost = envId === 'prod' ? 12.0 : 1.0;
          note = `${cfg.protocol_type || 'HTTP'} API`;
          break;
        }
        case 'aws_s3_bucket': {
          cost = envId === 'prod' ? 14.5 : 1.2;
          note = `${cfg.sse_algorithm || 'AES256'}${cfg.versioning_enabled ? ' + Versioning' : ''}`;
          break;
        }
        case 'aws_kms_key': {
          cost = 1.0;
          note = 'Customer Master Key';
          break;
        }
        case 'aws_secretsmanager_secret': {
          cost = 0.4;
          note = 'Secret Storage';
          break;
        }
        case 'aws_route53_zone': {
          cost = 0.5;
          note = 'Hosted Zone';
          break;
        }
        case 'aws_kinesis_stream': {
          const shards = Number(cfg.shard_count ?? 1);
          cost =
            cfg.stream_mode === 'PROVISIONED'
              ? shards * 0.015 * 730
              : envId === 'prod'
              ? 29.0
              : 7.5;
          note = cfg.stream_mode === 'PROVISIONED' ? `${shards} Shards` : 'On-Demand';
          break;
        }
        case 'aws_bedrock_agent': {
          cost = envId === 'prod' ? 45.0 : 5.0;
          note = String(cfg.foundation_model || '').split('.')[1] || 'Foundation Model';
          break;
        }
        default: {
          cost = 0;
          note = 'Free / Included';
        }
      }

      monthlyUsd[envId] = Math.round(cost * 100) / 100;
      sizingNotes[envId] = note;
      totalsByEnv[envId] = Math.round((totalsByEnv[envId] + monthlyUsd[envId]) * 100) / 100;
    }

    items.push({
      nodeId: node.id,
      label: node.data.label,
      serviceType: type,
      monthlyUsd,
      sizingNotes,
    });
  }

  return { items, totalsByEnv };
}

export function runArchitectureLinter(
  nodes: CloudNode[],
  edges: CloudEdge[],
  activeEnv: EnvironmentId
): LintFinding[] {
  const findings: LintFinding[] = [];
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
    if (type === 'aws_db_instance' && activeEnv === 'prod') {
      if (!cfg.multi_az) {
        findings.push({
          id: `rds-multiaz-${node.id}`,
          severity: 'warning',
          category: 'Reliability',
          title: `Production RDS "${node.data.label}" is Single-AZ`,
          description: `Multi-AZ standby deployment is disabled in PROD. Enable multi_az for automatic failover protection.`,
          nodeId: node.id,
          envId: 'prod',
          remediation: 'Toggle "Multi-AZ Standby Deployment" on for PROD.',
        });
      }
      if (cfg.skip_final_snapshot) {
        findings.push({
          id: `rds-snapshot-${node.id}`,
          severity: 'info',
          category: 'Reliability',
          title: `Production RDS "${node.data.label}" skips final snapshot`,
          description: `skip_final_snapshot is true in PROD. Set to false to retain a recovery snapshot on deletion.`,
          nodeId: node.id,
          envId: 'prod',
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
    if (type === 'aws_sqs_queue' && activeEnv === 'prod' && !cfg.enable_dlq) {
      findings.push({
        id: `sqs-dlq-${node.id}`,
        severity: 'warning',
        category: 'Reliability',
        title: `SQS Queue "${node.data.label}" has no Dead-Letter Queue (DLQ)`,
        description: `Poison-pill messages in PROD could loop until retention expiry. Enable companion DLQ generation.`,
        nodeId: node.id,
        envId: 'prod',
      });
    }

    // 6. Cognito MFA disabled in Production
    if (
      type === 'aws_cognito_user_pool' &&
      activeEnv === 'prod' &&
      cfg.mfa_configuration === 'OFF'
    ) {
      findings.push({
        id: `cognito-mfa-${node.id}`,
        severity: 'warning',
        category: 'Security',
        title: `Cognito Pool "${node.data.label}" has MFA disabled in PROD`,
        description: `Consider setting mfa_configuration to OPTIONAL or ON for production customer identity pools.`,
        nodeId: node.id,
        envId: 'prod',
      });
    }

    // 7. AWS Emulator Fidelity Note for high-complexity services
    const svc = SERVICE_BY_TYPE[type];
    if (svc?.emulatorSupportLevel === 'high') {
      findings.push({
        id: `emulator-fidelity-${node.id}`,
        severity: 'info',
        category: 'Emulator',
        title: `${svc.shortName} Control Plane Emulation Note`,
        description: `aws-emulator emulates ${svc.name} control-plane APIs locally with zero AWS cost. Remember that aws-emulator does not enforce IAM policy evaluation during local test runs.`,
        nodeId: node.id,
        envId: activeEnv,
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
