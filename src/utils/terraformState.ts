import type { CloudNode, EnvironmentId, ProvisioningState } from '../types/cloud';
import { mainResourceType, resolveNodeConfigForEnv, sanitizeIdentifier } from './terraformCompiler';

/** What `/api/terraform/state` reports for one environment. */
export interface TerraformStateSummary {
  exists: boolean;
  resources: { type: string; name: string }[];
  outputs: Record<string, string>;
}

/**
 * Node status and outputs as Terraform state records them. A node counts as applied when its
 * main resource (e.g. aws_lambda_function.orders_api) is in state; helpers like its IAM role don't
 * decide it. `failed` is kept for nodes not in state, since state can't say whether a create failed.
 */
export function statusFromState(
  nodes: CloudNode[],
  envId: EnvironmentId,
  state: TerraformStateSummary
): {
  status: Record<string, ProvisioningState>;
  outputs: Record<string, Record<string, string> | undefined>;
} {
  const inState = new Set(state.resources.map((r) => `${r.type}.${r.name}`));
  const status: Record<string, ProvisioningState> = {};
  const outputs: Record<string, Record<string, string> | undefined> = {};

  // Outputs are named <resName>_<output>; match the longest resource name first
  const byResName = nodes
    .map((n) => ({ node: n, resName: sanitizeIdentifier(n.data.resourceName || n.data.label) }))
    .sort((a, b) => b.resName.length - a.resName.length);

  for (const { node, resName } of byResName) {
    const tfType = mainResourceType(node, resolveNodeConfigForEnv(node, envId));
    const applied = node.data.envEnabled?.[envId] !== false && inState.has(`${tfType}.${resName}`);
    const current = node.data.provisioningStatus?.[envId];
    status[node.id] = applied ? 'provisioned' : current === 'failed' ? 'failed' : 'unapplied';
    outputs[node.id] = undefined;
  }

  for (const [name, value] of Object.entries(state.outputs)) {
    const match = byResName.find((r) => name.startsWith(`${r.resName}_`));
    if (!match || status[match.node.id] !== 'provisioned') continue;
    outputs[match.node.id] = { ...(outputs[match.node.id] || {}), [name.slice(match.resName.length + 1)]: value };
  }

  return { status, outputs };
}
