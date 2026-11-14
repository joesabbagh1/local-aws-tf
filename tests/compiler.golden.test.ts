import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import { compileTerraformForEnvironment } from '../src/utils/terraformCompiler';
import { normalizeNodes } from '../src/utils/canvasLayout';
import type { EnvironmentId } from '../src/types/cloud';
import { IMPORT_FIXTURE_HCL, NO_NETWORK_CANVAS } from './fixtures';
import { parseTerraformHclToCanvas } from '../src/utils/hclImporter';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

/**
 * Compiles every blueprint for every environment, for the emulator and as the AWS export, and compares
 * against tests/golden/<target>/<blueprint>/<env>/. Each golden directory is a complete Terraform root,
 * so CI also runs `terraform validate` on it (scripts/validate-golden.mjs). After an intended compiler change, refresh with `npm test -- -u`.
 */
describe.each(ARCHITECTURE_TEMPLATES.map((tpl) => [tpl.id, tpl] as const))('blueprint %s', (_id, tpl) => {
  const nodes = normalizeNodes(structuredClone(tpl.nodes));

  it.each(ENV_IDS)('compiles %s to the golden emulator Terraform', async (envId) => {
    const compiled = compileTerraformForEnvironment(nodes, tpl.edges, DEFAULT_ENVIRONMENTS[envId], DEFAULT_ENVIRONMENTS);
    const dir = `golden/emulator/${tpl.id}/${envId}`;
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/${envId}.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
  });

  it.each(ENV_IDS)('compiles %s to the golden AWS export', async (envId) => {
    const compiled = compileTerraformForEnvironment(
      nodes,
      tpl.edges,
      DEFAULT_ENVIRONMENTS[envId],
      DEFAULT_ENVIRONMENTS,
      'aws'
    );
    const dir = `golden/aws/${tpl.id}/${envId}`;
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.backendTf).toMatchFileSnapshot(`${dir}/backend.tf`);
    await expect(compiled.backendConfig).toMatchFileSnapshot(`${dir}/backend.tfbackend`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/${envId}.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
  });

  it('skips resources switched off for an environment', () => {
    const [first, ...rest] = nodes;
    const disabled = { ...first, data: { ...first.data, envEnabled: { ...first.data.envEnabled, dev: false } } };
    const compiled = compileTerraformForEnvironment([disabled, ...rest], tpl.edges, DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS);
    expect(compiled.mainTf).toContain(`Active Resources: ${nodes.length - 1} `);
  });
});

// Not a blueprint: covers the export paths the blueprints don't reach (existing-network inputs, AMI lookup)
describe('no-network canvas', () => {
  it('compiles to a valid AWS export', async () => {
    const compiled = compileTerraformForEnvironment(NO_NETWORK_CANVAS, [], DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS, 'aws');
    const dir = 'golden/aws/no-network-fixture/dev';
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.backendTf).toMatchFileSnapshot(`${dir}/backend.tf`);
    await expect(compiled.backendConfig).toMatchFileSnapshot(`${dir}/backend.tfbackend`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/dev.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
  });
});

// Imported Terraform, with its unmodelled arguments carried as Extra HCL, must still compile to valid Terraform
describe('imported canvas', () => {
  it('compiles with its Extra HCL in place', async () => {
    // Without the one reference the importer warns about (aws_sns_topic.alerts is not on the canvas)
    const hcl = IMPORT_FIXTURE_HCL.replace(/^\s*description\s+= "uses .*$/m, '');
    const { nodes, edges } = parseTerraformHclToCanvas(hcl);
    const compiled = compileTerraformForEnvironment(normalizeNodes(nodes), edges, DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS);
    const dir = 'golden/emulator/import-fixture/dev';
    await expect(compiled.mainTf).toMatchFileSnapshot(`${dir}/main.tf`);
    await expect(compiled.providerTf).toMatchFileSnapshot(`${dir}/provider.tf`);
    await expect(compiled.variablesTf).toMatchFileSnapshot(`${dir}/variables.tf`);
    await expect(compiled.tfvars).toMatchFileSnapshot(`${dir}/dev.tfvars`);
    await expect(compiled.outputsTf).toMatchFileSnapshot(`${dir}/outputs.tf`);
  });
});
