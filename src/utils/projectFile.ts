import type { CloudNode, CloudEdge, EnvironmentId, EnvironmentProfile } from '../types/cloud';

export const PROJECT_FILE_VERSION = '2.0.0';

export interface ProjectFile {
  version: string;
  environments: Record<EnvironmentId, Omit<EnvironmentProfile, 'color' | 'badgeClass'>>;
  nodes: CloudNode[];
  edges: CloudEdge[];
}

/**
 * The on-disk project: the design only. Selection, drag state, measurements and per-machine
 * provisioning state are left out so the file changes only when the architecture does.
 */
export function toProjectFile(state: {
  nodes: CloudNode[];
  edges: CloudEdge[];
  environments: Record<EnvironmentId, EnvironmentProfile>;
}): ProjectFile {
  return {
    version: PROJECT_FILE_VERSION,
    // Colours are presentation and come from the app, not the project
    environments: Object.fromEntries(
      Object.entries(state.environments).map(([id, { color, badgeClass, ...profile }]) => [id, profile])
    ) as ProjectFile['environments'],
    nodes: state.nodes.map((node) => {
      const { selected, dragging, measured, resizing, ...rest } = node as CloudNode & { resizing?: boolean };
      const { provisioningStatus, provisionedOutputs, ...data } = rest.data;
      return { ...rest, data } as CloudNode;
    }),
    edges: state.edges.map((edge) => {
      const { selected, ...rest } = edge;
      return rest as CloudEdge;
    }),
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
