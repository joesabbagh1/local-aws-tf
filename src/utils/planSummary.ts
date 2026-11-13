import type { CloudNode, EnvironmentId } from '../types/cloud';
import { sanitizeIdentifier } from './terraformCompiler';

export type PlanAction = 'create' | 'update' | 'replace' | 'delete';

/** One entry of `resource_changes` from `terraform show -json <plan>`. */
export interface PlanResourceChange {
  address: string;
  type: string;
  name: string;
  actions: string[];
}

export interface PlannedChange {
  address: string;
  action: PlanAction;
}

export interface PlanSummary {
  /** Terraform-style totals: a replace counts as one add and one destroy. */
  counts: { add: number; change: number; destroy: number };
  /** The headline action per canvas node. */
  byNode: Record<string, PlanAction>;
  changesByNode: Record<string, PlannedChange[]>;
  /** Changes with no node on the canvas, e.g. resources whose node was deleted. */
  other: PlannedChange[];
}

/** Maps a Terraform resource name (e.g. orders_fn or orders_fn_exec_role) back to its canvas node. */
export function buildResourceNameResolver(nodes: CloudNode[], envId: EnvironmentId) {
  const entries = nodes
    .filter((n) => n.data.envEnabled?.[envId] !== false)
    .map((n) => ({ id: n.id, resName: sanitizeIdentifier(n.data.resourceName || n.data.label) }))
    .sort((a, b) => b.resName.length - a.resName.length);

  return (tfName: string): string | undefined =>
    entries.find((e) => tfName === e.resName || tfName.startsWith(`${e.resName}_`))?.id;
}

export function classifyPlanActions(actions: string[]): PlanAction | null {
  const has = (a: string) => actions.includes(a);
  if (has('create') && has('delete')) return 'replace';
  if (has('create')) return 'create';
  if (has('delete')) return 'delete';
  if (has('update')) return 'update';
  return null;
}

export function summarizePlan(
  changes: PlanResourceChange[],
  nodes: CloudNode[],
  envId: EnvironmentId
): PlanSummary {
  const resolveNode = buildResourceNameResolver(nodes, envId);
  const summary: PlanSummary = {
    counts: { add: 0, change: 0, destroy: 0 },
    byNode: {},
    changesByNode: {},
    other: [],
  };

  for (const change of changes) {
    const action = classifyPlanActions(change.actions);
    if (!action) continue;

    if (action === 'create' || action === 'replace') summary.counts.add++;
    if (action === 'delete' || action === 'replace') summary.counts.destroy++;
    if (action === 'update') summary.counts.change++;

    const nodeId = resolveNode(change.name);
    if (!nodeId) {
      summary.other.push({ address: change.address, action });
      continue;
    }
    (summary.changesByNode[nodeId] ||= []).push({ address: change.address, action });
  }

  for (const [nodeId, nodeChanges] of Object.entries(summary.changesByNode)) {
    const kinds = new Set(nodeChanges.map((c) => c.action));
    summary.byNode[nodeId] = kinds.size === 1 ? nodeChanges[0].action : kinds.has('replace') ? 'replace' : 'update';
  }

  return summary;
}

export function planHasChanges(summary: PlanSummary): boolean {
  return summary.counts.add + summary.counts.change + summary.counts.destroy > 0;
}
