import type { CloudNode, CloudEdge, EnvironmentId, EnvironmentProfile } from '../types/cloud';
import type { Scenario } from './scenarios';

export const PROJECT_FILE_VERSION = '2.0.0';

export interface ProjectFile {
  version: string;
  environments: Record<EnvironmentId, Omit<EnvironmentProfile, 'color' | 'badgeClass'>>;
  nodes: CloudNode[];
  edges: CloudEdge[];
  /** Saved end-to-end checks (utils/scenarios.ts). Left out of the file while there are none. */
  scenarios?: Scenario[];
}

/** Colours are presentation and come from the app, not the project. */
export function toProjectEnvironments(
  environments: Record<EnvironmentId, EnvironmentProfile>
): ProjectFile['environments'] {
  return Object.fromEntries(
    Object.entries(environments).map(([id, { color, badgeClass, ...profile }]) => [id, profile])
  ) as ProjectFile['environments'];
}

/**
 * The on-disk project: the design only. Selection, drag state, measurements and per-machine
 * provisioning state are left out so the file changes only when the architecture does.
 */
export function toProjectFile(state: {
  nodes: CloudNode[];
  edges: CloudEdge[];
  environments: Record<EnvironmentId, EnvironmentProfile>;
  scenarios?: Scenario[];
}): ProjectFile {
  return {
    version: PROJECT_FILE_VERSION,
    environments: toProjectEnvironments(state.environments),
    nodes: state.nodes.map((node) => {
      const { selected, dragging, measured, resizing, ...rest } = node as CloudNode & { resizing?: boolean };
      const { provisioningStatus, provisionedOutputs, ...data } = rest.data;
      return { ...rest, data } as CloudNode;
    }),
    edges: state.edges.map((edge) => {
      const { selected, ...rest } = edge;
      return rest as CloudEdge;
    }),
    ...(state.scenarios?.length ? { scenarios: state.scenarios } : {}),
  };
}

/** Provisioning state lives in the browser, not the project file; carry it over onto freshly loaded nodes. */
export function withRuntimeStateFrom(loaded: CloudNode[], local: CloudNode[]): CloudNode[] {
  const localById = new Map(local.map((n) => [n.id, n]));
  return loaded.map((node) => {
    const prev = localById.get(node.id);
    if (!prev?.data.provisioningStatus && !prev?.data.provisionedOutputs) return node;
    return {
      ...node,
      data: {
        ...node.data,
        provisioningStatus: prev.data.provisioningStatus,
        provisionedOutputs: prev.data.provisionedOutputs,
      },
    };
  });
}
