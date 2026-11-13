import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import { toProjectFile, withRuntimeStateFrom } from '../src/utils/projectFile';
import type { CloudNode } from '../src/types/cloud';

const tpl = ARCHITECTURE_TEMPLATES[0];
const base = { edges: tpl.edges, environments: DEFAULT_ENVIRONMENTS, targetLocalEmulator: true };

describe('project file', () => {
  it('leaves out selection, drag, measurement and provisioning state', () => {
    const clean = toProjectFile({ ...base, nodes: tpl.nodes });
    const noisyNodes = tpl.nodes.map(
      (n) =>
        ({
          ...n,
          selected: true,
          dragging: true,
          measured: { width: 240, height: 150 },
          data: {
            ...n.data,
            provisioningStatus: { dev: 'provisioned' },
            provisionedOutputs: { dev: { arn: 'arn:aws:x' } },
          },
        }) as CloudNode
    );
    const noisy = toProjectFile({
      ...base,
      nodes: noisyNodes,
      edges: tpl.edges.map((e) => ({ ...e, selected: true })),
    });
    expect(JSON.stringify(noisy)).toBe(JSON.stringify(clean));
  });

  it('keeps the design: positions, config, overrides and nesting', () => {
    const project = toProjectFile({ ...base, nodes: tpl.nodes });
    expect(project.nodes.map((n) => [n.id, n.position, n.parentId, n.data.baseConfig, n.data.envOverrides])).toEqual(
      tpl.nodes.map((n) => [n.id, n.position, n.parentId, n.data.baseConfig, n.data.envOverrides])
    );
    expect(project.edges).toHaveLength(tpl.edges.length);
  });

  it('carries provisioning state over to nodes loaded from disk', () => {
    const local = tpl.nodes.map((n, i) =>
      i === 0 ? ({ ...n, data: { ...n.data, provisioningStatus: { dev: 'provisioned' } } } as CloudNode) : n
    );
    const loaded = toProjectFile({ ...base, nodes: tpl.nodes }).nodes;
    const merged = withRuntimeStateFrom(loaded, local);
    expect(merged[0].data.provisioningStatus).toEqual({ dev: 'provisioned' });
    expect(merged[1]).toBe(loaded[1]);
  });
});

describe('project file environments', () => {
  it('stores settings but not colours', () => {
    const project = toProjectFile({ ...base, nodes: tpl.nodes });
    expect(project.environments.prod).toMatchObject({ region: 'us-west-2', emulatorPort: 9300 });
    expect(project.environments.prod).not.toHaveProperty('color');
    expect(project.environments.prod).not.toHaveProperty('badgeClass');
  });
});
