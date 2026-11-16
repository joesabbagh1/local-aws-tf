import type {
  CloudNode,
  CostBreakdownItem,
  CostDriver,
  CostSaving,
  EnvironmentId,
  EnvironmentProfile,
  UsageProfile,
} from '../types/cloud';
import { DEFAULT_ENVIRONMENTS, SERVICE_BY_TYPE } from '../data/awsCatalog';
import { envIdsOf, isProductionEnv } from './environments';
import { resolveNodeConfigForEnv } from './terraformCompiler';

/**
 * Monthly cost estimate at on-demand us-east-1 list prices. Usage-priced services are sized from each
 * environment's usage profile; free tiers, reserved pricing and inter-AZ traffic are left out.
 */

export const COST_DRIVERS: CostDriver[] = ['compute', 'storage', 'requests', 'transfer', 'fees'];

export const DRIVER_LABELS: Record<CostDriver, string> = {
  compute: 'Compute',
  storage: 'Storage',
  requests: 'Requests',
  transfer: 'Data transfer',
  fees: 'Fixed fees',
};

const HOURS_PER_MONTH = 730;

const EC2_HOURLY_USD: Record<string, number> = {
  't3.nano': 0.0052,
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  't4g.small': 0.0168,
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

/** USD per million input / output tokens. */
const BEDROCK_TOKEN_USD: { match: string; input: number; output: number }[] = [
  { match: 'haiku', input: 0.8, output: 4 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'nova-pro', input: 0.8, output: 3.2 },
  { match: 'llama3-3-70b', input: 0.72, output: 0.72 },
];

const CLOUDFRONT_GB_USD: Record<string, number> = {
  PriceClass_100: 0.085,
  PriceClass_200: 0.12,
  PriceClass_All: 0.14,
};

const zeroDrivers = (): Record<CostDriver, number> => ({ compute: 0, storage: 0, requests: 0, transfer: 0, fees: 0 });

const round2 = (n: number) => Math.round(n * 100) / 100;

export function usageFor(env: Pick<EnvironmentProfile, 'usage'> | undefined, envId: EnvironmentId): UsageProfile {
  // An environment the app has no defaults for is assumed to see dev-sized traffic until it says otherwise
  return { ...(DEFAULT_ENVIRONMENTS[envId] ?? DEFAULT_ENVIRONMENTS.dev).usage, ...env?.usage };
}

interface PriceContext {
  usage: UsageProfile;
  /** How many log groups share the environment's log volume. */
  logGroupCount: number;
}

/** One resource in one environment: cost split by driver plus a short sizing note. */
function priceNode(type: string, cfg: Record<string, any>, ctx: PriceContext): { drivers: Record<CostDriver, number>; note: string } {
  const d = zeroDrivers();
  const { requestsMillions: reqM, dataTransferGb, storageGb, logsGb } = ctx.usage;
  let note = '';

  switch (type) {
    case 'aws_instance': {
      const it = cfg.instance_type || 't3.micro';
      const vol = Number(cfg.root_volume_size ?? 20);
      d.compute = (EC2_HOURLY_USD[it] ?? 0.02) * HOURS_PER_MONTH;
      d.storage = vol * 0.08;
      note = `${it} + ${vol} GB gp3`;
      break;
    }
    case 'aws_autoscaling_group': {
      const it = cfg.instance_type || 't3.medium';
      const count = Number(cfg.desired_capacity ?? 2);
      d.compute = (EC2_HOURLY_USD[it] ?? 0.0416) * HOURS_PER_MONTH * count;
      d.storage = 20 * 0.08 * count;
      note = `${count} × ${it}`;
      break;
    }
    case 'aws_ecs_service': {
      const vcpu = Number(cfg.cpu ?? 256) / 1024;
      const memGb = Number(cfg.memory ?? 512) / 1024;
      const tasks = Number(cfg.desired_count ?? 2);
      d.compute = (vcpu * 0.04048 + memGb * 0.004445) * HOURS_PER_MONTH * tasks;
      note = `${tasks} × Fargate ${cfg.cpu ?? 256} CPU / ${cfg.memory ?? 512} MiB`;
      break;
    }
    case 'aws_eks_cluster': {
      const it = cfg.node_instance_type || 'm6i.large';
      const count = Number(cfg.node_desired_size ?? 2);
      d.fees = 0.1 * HOURS_PER_MONTH;
      d.compute = (EC2_HOURLY_USD[it] ?? 0.096) * HOURS_PER_MONTH * count;
      d.storage = 20 * 0.08 * count;
      note = `Control plane + ${count} × ${it}`;
      break;
    }
    case 'aws_ecr_repository': {
      d.storage = (2 + storageGb * 0.02) * 0.1;
      note = 'Image storage';
      break;
    }
    case 'aws_lambda_function': {
      const memGb = Number(cfg.memory_size ?? 256) / 1024;
      const arm = (cfg.architectures || 'arm64') === 'arm64';
      // 120 ms average duration per invocation
      const gbSeconds = reqM * 1_000_000 * 0.12 * memGb;
      d.requests = reqM * 0.2;
      d.compute = gbSeconds * (arm ? 0.0000133334 : 0.0000166667);
      if (Number(cfg.reserved_concurrent_executions) > 0) {
        d.fees = Number(cfg.reserved_concurrent_executions) * 0.15;
      }
      note = `${cfg.memory_size ?? 256} MB ${arm ? 'arm64' : 'x86_64'}`;
      break;
    }
    case 'aws_apigatewayv2_api': {
      const ws = cfg.protocol_type === 'WEBSOCKET';
      d.requests = reqM * 1.0;
      if (ws) d.fees = reqM * 0.25;
      note = ws ? 'WebSocket API' : 'HTTP API';
      break;
    }
    case 'aws_lb': {
      const nlb = cfg.load_balancer_type === 'network';
      const reqPerSec = (reqM * 1_000_000) / (HOURS_PER_MONTH * 3600);
      // LCUs bill on the busiest dimension: new connections or bytes processed
      const lcu = Math.max(0.5, reqPerSec / 25, dataTransferGb / HOURS_PER_MONTH);
      d.fees = 0.0225 * HOURS_PER_MONTH;
      d.requests = lcu * (nlb ? 0.006 : 0.008) * HOURS_PER_MONTH;
      note = `${nlb ? 'Network' : 'Application'} LB, ~${lcu.toFixed(1)} LCU`;
      break;
    }
    case 'aws_nat_gateway': {
      d.fees = 0.045 * HOURS_PER_MONTH;
      d.transfer = dataTransferGb * 0.045;
      note = `NAT gateway + ${dataTransferGb} GB processed`;
      break;
    }
    case 'aws_cloudfront_distribution': {
      const pc = cfg.price_class || 'PriceClass_100';
      d.transfer = dataTransferGb * (CLOUDFRONT_GB_USD[pc] ?? 0.085);
      d.requests = reqM * 0.75;
      note = `${pc}, ${dataTransferGb} GB out`;
      break;
    }
    case 'aws_route53_zone': {
      d.fees = 0.5;
      d.requests = reqM * 0.4;
      note = 'Hosted zone + queries';
      break;
    }
    case 'aws_s3_bucket': {
      const versions = cfg.versioning_enabled ? 1.2 : 1;
      d.storage = storageGb * versions * 0.023;
      // One write per ten reads
      d.requests = reqM * (0.1 * 5 + 0.9 * 0.4);
      note = `${storageGb} GB Standard${cfg.versioning_enabled ? ' + versions' : ''}`;
      break;
    }
    case 'aws_efs_file_system': {
      d.storage = storageGb * 0.3;
      note = `${storageGb} GB Standard`;
      break;
    }
    case 'aws_dynamodb_table': {
      if (cfg.billing_mode === 'PROVISIONED') {
        const rcu = Number(cfg.read_capacity ?? 5);
        const wcu = Number(cfg.write_capacity ?? 5);
        d.compute = (rcu * 0.00013 + wcu * 0.00065) * HOURS_PER_MONTH;
        note = `Provisioned ${rcu} RCU / ${wcu} WCU`;
      } else {
        // One write per four reads
        d.requests = reqM * (0.2 * 0.625 + 0.8 * 0.125);
        note = 'On-demand';
      }
      d.storage = storageGb * 0.25 + (cfg.point_in_time_recovery ? storageGb * 0.2 : 0);
      if (cfg.point_in_time_recovery) note += ' + PITR';
      break;
    }
    case 'aws_db_instance': {
      const ic = cfg.instance_class || 'db.t4g.micro';
      const az = cfg.multi_az ? 2 : 1;
      const gb = Number(cfg.allocated_storage ?? 20);
      d.compute = (RDS_HOURLY_USD[ic] ?? 0.032) * HOURS_PER_MONTH * az;
      d.storage = gb * 0.115 * az;
      note = `${ic}${cfg.multi_az ? ', Multi-AZ' : ''}, ${gb} GB`;
      break;
    }
    case 'aws_elasticache_cluster': {
      const nt = cfg.node_type || 'cache.t4g.micro';
      const count = Number(cfg.num_cache_nodes ?? 1);
      d.compute = (CACHE_HOURLY_USD[nt] ?? 0.016) * HOURS_PER_MONTH * count;
      note = `${count} × ${nt}`;
      break;
    }
    case 'aws_opensearch_domain': {
      const it = cfg.instance_type || 't3.small.search';
      const count = Number(cfg.instance_count ?? 1);
      d.compute = (OPENSEARCH_HOURLY_USD[it] ?? 0.036) * HOURS_PER_MONTH * count;
      d.storage = Number(cfg.ebs_volume_size ?? 20) * 0.122 * count;
      note = `${count} × ${it}`;
      break;
    }
    case 'aws_sqs_queue': {
      // Send, receive and delete per message, one message per request
      d.requests = reqM * 3 * (cfg.fifo_queue ? 0.5 : 0.4);
      note = cfg.fifo_queue ? 'FIFO queue' : 'Standard queue';
      break;
    }
    case 'aws_sns_topic': {
      d.requests = reqM * 0.2 * 0.5;
      note = 'Publishes';
      break;
    }
    case 'aws_cloudwatch_event_bus': {
      d.requests = reqM * 0.2 * 1.0;
      note = 'Custom events';
      break;
    }
    case 'aws_sfn_state_machine': {
      const express = cfg.type === 'EXPRESS';
      // One execution per twenty requests, five transitions each
      d.requests = express ? reqM * 0.05 * 1.0 : reqM * 0.05 * 5 * 25;
      note = express ? 'Express workflows' : 'Standard workflows';
      break;
    }
    case 'aws_cognito_user_pool': {
      const mau = reqM * 800;
      d.requests = Math.max(0, mau - 10_000) * 0.0055;
      note = `~${Math.round(mau).toLocaleString()} MAU`;
      break;
    }
    case 'aws_cloudwatch_log_group': {
      const ingest = logsGb / Math.max(1, ctx.logGroupCount);
      const days = Number(cfg.retention_in_days) || 365;
      d.requests = ingest * 0.5;
      d.storage = ingest * Math.min(days, 365) / 30 * 0.03;
      if (cfg.create_error_alarm) d.fees = 0.1;
      note = `${ingest.toFixed(1)} GB/mo, ${Number(cfg.retention_in_days) ? `${cfg.retention_in_days} d` : 'never expires'}`;
      break;
    }
    case 'aws_kms_key': {
      d.fees = 1;
      d.requests = reqM * 0.1 * 3;
      note = 'Customer managed key';
      break;
    }
    case 'aws_secretsmanager_secret': {
      d.fees = 0.4;
      note = 'Secret';
      break;
    }
    case 'aws_kinesis_stream': {
      if (cfg.stream_mode === 'PROVISIONED') {
        const shards = Number(cfg.shard_count ?? 1);
        d.compute = shards * 0.015 * HOURS_PER_MONTH;
        d.requests = reqM * 0.014;
        note = `${shards} shard${shards === 1 ? '' : 's'}`;
      } else {
        d.fees = 0.04 * HOURS_PER_MONTH;
        d.requests = storageGb * 0.08;
        note = 'On-demand';
      }
      break;
    }
    case 'aws_bedrock_agent': {
      const model = String(cfg.foundation_model || '');
      const price = BEDROCK_TOKEN_USD.find((p) => model.includes(p.match)) ?? BEDROCK_TOKEN_USD[1];
      // One invocation per fifty requests, 2,000 tokens in and 500 out
      const invocations = reqM * 1_000_000 * 0.02;
      d.requests = (invocations * (2000 * price.input + 500 * price.output)) / 1_000_000;
      note = `${model.split('.')[1]?.split('-v')[0] || 'model'}, ${Math.round(invocations).toLocaleString()} calls`;
      break;
    }
    default:
      note = 'No charge';
  }

  for (const key of COST_DRIVERS) d[key] = round2(d[key]);
  return { drivers: d, note };
}

export interface CostEstimate {
  /** The environments estimated, in project order. */
  envIds: EnvironmentId[];
  /** Which of them count as production (see isProductionEnv). */
  productionEnvIds: EnvironmentId[];
  items: CostBreakdownItem[];
  totalsByEnv: Record<EnvironmentId, number>;
  driversByEnv: Record<EnvironmentId, Record<CostDriver, number>>;
}

export function estimateArchitectureCosts(
  nodes: CloudNode[],
  environments: Partial<Record<EnvironmentId, Pick<EnvironmentProfile, 'usage'> & Partial<Pick<EnvironmentProfile, 'production'>>>> = DEFAULT_ENVIRONMENTS
): CostEstimate {
  const ENV_IDS = envIdsOf(environments);
  const perEnv = <T,>(make: () => T) => Object.fromEntries(ENV_IDS.map((id) => [id, make()])) as Record<EnvironmentId, T>;
  const totalsByEnv = perEnv(() => 0);
  const driversByEnv = Object.fromEntries(ENV_IDS.map((id) => [id, zeroDrivers()])) as CostEstimate['driversByEnv'];
  const items: CostBreakdownItem[] = [];

  const logGroupCount = Object.fromEntries(
    ENV_IDS.map((envId) => [
      envId,
      nodes.filter((n) => n.data.serviceType === 'aws_cloudwatch_log_group' && n.data.envEnabled?.[envId] !== false).length,
    ])
  ) as Record<EnvironmentId, number>;

  for (const node of nodes) {
    const type = node.data.serviceType;
    const item: CostBreakdownItem = {
      nodeId: node.id,
      label: node.data.label,
      serviceType: type,
      category: SERVICE_BY_TYPE[type]?.category ?? 'Management & Governance',
      monthlyUsd: perEnv(() => 0),
      drivers: Object.fromEntries(ENV_IDS.map((id) => [id, zeroDrivers()])) as CostBreakdownItem['drivers'],
      sizingNotes: perEnv(() => ''),
    };

    for (const envId of ENV_IDS) {
      if (node.data.envEnabled?.[envId] === false) {
        item.sizingNotes[envId] = 'Disabled';
        continue;
      }
      const { drivers, note } = priceNode(type, resolveNodeConfigForEnv(node, envId), {
        usage: usageFor(environments[envId], envId),
        logGroupCount: logGroupCount[envId],
      });
      item.drivers[envId] = drivers;
      item.sizingNotes[envId] = note;
      item.monthlyUsd[envId] = round2(COST_DRIVERS.reduce((sum, k) => sum + drivers[k], 0));
      totalsByEnv[envId] = round2(totalsByEnv[envId] + item.monthlyUsd[envId]);
      for (const k of COST_DRIVERS) driversByEnv[envId][k] = round2(driversByEnv[envId][k] + drivers[k]);
    }
    items.push(item);
  }

  const productionEnvIds = ENV_IDS.filter((id) => isProductionEnv({ id, production: environments[id]?.production }));
  return { envIds: ENV_IDS, productionEnvIds, items, totalsByEnv, driversByEnv };
}

/** Month-by-month cost for one environment when usage grows by `monthlyGrowth` (0.05 = 5%) each month. */
export function projectMonthlyCost(
  drivers: Record<CostDriver, number>,
  monthlyGrowth: number,
  months = 12
): Record<CostDriver, number>[] {
  return Array.from({ length: months }, (_, i) => {
    const g = Math.pow(1 + monthlyGrowth, i);
    return {
      compute: drivers.compute,
      fees: drivers.fees,
      storage: round2(drivers.storage * g),
      requests: round2(drivers.requests * g),
      transfer: round2(drivers.transfer * g),
    };
  });
}

const SCHEDULABLE = new Set(['aws_instance', 'aws_autoscaling_group', 'aws_ecs_service', 'aws_db_instance']);
const COMMITTABLE = new Set([
  'aws_instance',
  'aws_autoscaling_group',
  'aws_ecs_service',
  'aws_eks_cluster',
  'aws_db_instance',
  'aws_elasticache_cluster',
  'aws_opensearch_domain',
]);

/** Concrete changes that would lower the bill, largest first. One suggestion per resource and environment. */
export function findCostSavings(nodes: CloudNode[], estimate: CostEstimate): CostSaving[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const production = new Set(estimate.productionEnvIds);
  const savings: CostSaving[] = [];

  for (const item of estimate.items) {
    const node = byId.get(item.nodeId);
    if (!node) continue;
    for (const envId of estimate.envIds) {
      if (item.monthlyUsd[envId] <= 0) continue;
      const cfg = resolveNodeConfigForEnv(node, envId);
      const d = item.drivers[envId];
      const isProd = production.has(envId);
      // Staging mirrors production's hours; everything else non-production can sleep at night
      const nonProd = !isProd && envId !== 'staging';
      const add = (title: string, detail: string, monthlyUsd: number) => {
        if (monthlyUsd >= 0.5) {
          savings.push({ id: `${item.nodeId}:${envId}`, nodeId: item.nodeId, envId, title, detail, monthlyUsd: round2(monthlyUsd) });
        }
      };

      if (item.serviceType === 'aws_nat_gateway' && !isProd) {
        add('Drop the NAT gateway', 'Use VPC endpoints for AWS APIs, or share one NAT gateway across non-production environments.', d.fees);
      } else if (item.serviceType === 'aws_db_instance' && cfg.multi_az && !isProd) {
        add('Run single-AZ outside production', 'A standby replica doubles instance and storage cost.', (d.compute + d.storage) / 2);
      } else if (nonProd && SCHEDULABLE.has(item.serviceType)) {
        add('Stop outside working hours', 'Running 12 hours on weekdays instead of around the clock covers a typical team.', d.compute * (1 - 60 / 168));
      } else if (isProd && COMMITTABLE.has(item.serviceType)) {
        add('Commit to a 1-year savings plan', 'No-upfront compute savings plans and reserved instances run about 30% under on-demand.', d.compute * 0.3);
      } else if (item.serviceType === 'aws_lambda_function' && cfg.architectures === 'x86_64') {
        add('Switch to arm64', 'Graviton Lambda is 20% cheaper per GB-second for most runtimes.', d.compute * 0.2);
      } else if (item.serviceType === 'aws_cloudwatch_log_group' && !isProd && (Number(cfg.retention_in_days) || 9999) > 14) {
        add('Shorten log retention', 'Keep non-production logs for 14 days.', d.storage * (1 - 14 / Math.min(Number(cfg.retention_in_days) || 365, 365)));
      }
    }
  }

  return savings.sort((a, b) => b.monthlyUsd - a.monthlyUsd);
}

export function costEstimateCsv(estimate: CostEstimate): string {
  const header = ['resource', 'service', 'category', 'environment', ...COST_DRIVERS, 'total_usd', 'sizing'];
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = estimate.items.flatMap((item) =>
    estimate.envIds.map((envId) => [
      item.label,
      SERVICE_BY_TYPE[item.serviceType]?.name ?? item.serviceType,
      item.category,
      envId,
      ...COST_DRIVERS.map((k) => item.drivers[envId][k].toFixed(2)),
      item.monthlyUsd[envId].toFixed(2),
      item.sizingNotes[envId],
    ])
  );
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}
