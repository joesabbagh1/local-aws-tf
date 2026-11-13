import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import { compileTerraformForEnvironment } from '../src/utils/terraformCompiler';
import { normalizeNodes } from '../src/utils/canvasLayout';
import type { EnvironmentId } from '../src/types/cloud';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

/**
 * Compiles every blueprint for every environment and compares against the files in tests/golden/.
 * Each golden directory is a complete Terraform root, so CI also runs `terraform validate` on it
 * (scripts/validate-golden.mjs). After an intended compiler change, refresh with `npm test -- -u`.
 */
describe.each(ARCHITECTURE_TEMPLATES.map((tpl) => [tpl.id, tpl] as const))('blueprint %s', (_id, tpl) => {
  const nodes = normalizeNodes(structuredClone(tpl.nodes));

  it.each(ENV_IDS)('compiles %s to the golden Terraform', async (envId) => {
    const compiled = compileTerraformForEnvironment(
      nodes,
      tpl.edges,
      DEFAULT_ENVIRONMENTS[envId],
      DEFAULT_ENVIRONMENTS,
      true
    );
    const dir = `golden/${tpl.id}/${envId}`;
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/${envId}.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
  });

  it('skips resources switched off for an environment', () => {
    const [first, ...rest] = nodes;
    const disabled = { ...first, data: { ...first.data, envEnabled: { ...first.data.envEnabled, dev: false } } };
    const compiled = compileTerraformForEnvironment(
      [disabled, ...rest],
      tpl.edges,
      DEFAULT_ENVIRONMENTS.dev,
      DEFAULT_ENVIRONMENTS,
      true
    );
    expect(compiled.mainTf).toContain(`Active Resources: ${nodes.length - 1} `);
  });
});
