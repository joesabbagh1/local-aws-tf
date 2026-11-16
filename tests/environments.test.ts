import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import {
  addEnvironment,
  envIdsOf,
  isProductionEnv,
  nextEmulatorPort,
  removeEnvironment,
  resolveEnvironments,
  validateEnvId,
} from '../src/utils/environments';
import { buildTerraformFiles } from '../src/utils/terraformBundle';
import { compileTerraformForEnvironment } from '../src/utils/terraformCompiler';
import { estimateArchitectureCosts, findCostSavings } from '../src/utils/costEstimator';
import { runArchitectureLinter } from '../src/utils/architectureValidator';
import { auditAwsExport } from '../src/utils/awsExport';
import { toProjectFile } from '../src/utils/projectFile';
import { nodeFor } from './fixtures';

const design = () => ({
  environments: structuredClone(DEFAULT_ENVIRONMENTS),
  nodes: [nodeFor('aws_lambda_function', 'api'), nodeFor('aws_db_instance', 'db')],
});

describe('resolveEnvironments', () => {
  it('gives a document without environments the four defaults', () => {
    expect(envIdsOf(resolveEnvironments(undefined))).toEqual(['dev', 'testing', 'staging', 'prod']);
    expect(envIdsOf(resolveEnvironments({}))).toEqual(['dev', 'testing', 'staging', 'prod']);
  });

  it('keeps exactly the saved environments, in order, so a removed default stays removed', () => {
    const resolved = resolveEnvironments({ prod: { region: 'eu-west-1' }, dev: {} });
    expect(envIdsOf(resolved)).toEqual(['prod', 'dev']);
    expect(resolved.prod.region).toBe('eu-west-1');
    expect(resolved.prod.emulatorPort).toBe(9300);
    // Colours come from the app, not the file
    expect(resolved.dev.color).toBe(DEFAULT_ENVIRONMENTS.dev.color);
  });

  it('fills in a custom environment and ignores ids that are not DNS-safe', () => {
    const resolved = resolveEnvironments({ qa: { emulatorPort: 9301 }, 'Bad Id': {} });
    expect(envIdsOf(resolved)).toEqual(['qa']);
    expect(resolved.qa).toMatchObject({ id: 'qa', name: 'QA', emulatorPort: 9301, emulatorEndpoint: 'https://127.0.0.1:9301' });
    expect(resolved.qa.color).toMatch(/^#/);
  });
});

describe('adding and removing environments', () => {
  it('validates ids', () => {
    expect(validateEnvId('qa', ['dev'])).toBeNull();
    expect(validateEnvId('perf-2', ['dev'])).toBeNull();
    expect(validateEnvId('dev', ['dev'])).toMatch(/already exists/);
    expect(validateEnvId('QA', [])).toMatch(/lowercase/);
    expect(validateEnvId('1qa', [])).toMatch(/starting with a letter/);
    expect(validateEnvId('a'.repeat(17), [])).not.toBeNull();
  });

  it('gives a new environment the next free port, never one of the defaults', () => {
    expect(nextEmulatorPort(DEFAULT_ENVIRONMENTS)).toBe(9301);
    const { prod: _p, ...withoutProd } = DEFAULT_ENVIRONMENTS;
    expect(nextEmulatorPort(withoutProd)).toBe(9301);
  });

  it('copies another environment\'s settings, overrides and switches', () => {
    const d = design();
    d.nodes[0].data.envOverrides.staging = { memory_size: 1024 };
    d.nodes[1].data.envEnabled.staging = false;
    const next = addEnvironment(d, 'qa', { copyFrom: 'staging', name: 'QA' });
    expect(next.environments.qa).toMatchObject({ name: 'QA', region: DEFAULT_ENVIRONMENTS.staging.region, emulatorPort: 9301 });
    expect(next.nodes[0].data.envOverrides.qa).toEqual({ memory_size: 1024 });
    expect(next.nodes[1].data.envEnabled.qa).toBe(false);
    // A copy, not a shared object
    next.nodes[0].data.envOverrides.qa!.memory_size = 1;
    expect(next.nodes[0].data.envOverrides.staging).toEqual({ memory_size: 1024 });
  });

  it('copies production-ness from a production environment', () => {
    const next = addEnvironment(design(), 'prod-eu', { copyFrom: 'prod' });
    expect(isProductionEnv(next.environments['prod-eu'])).toBe(true);
    expect(isProductionEnv(addEnvironment(design(), 'qa').environments.qa)).toBe(false);
  });

  it('removes an environment and what resources stored for it, but never the last one', () => {
    const d = design();
    d.nodes[0].data.envOverrides.testing = { memory_size: 512 };
    const next = removeEnvironment(d, 'testing');
    expect(envIdsOf(next.environments)).toEqual(['dev', 'staging', 'prod']);
    expect(next.nodes[0].data.envOverrides).not.toHaveProperty('testing');
    expect(next.nodes[0].data.envEnabled).not.toHaveProperty('testing');

    const single = { environments: { dev: DEFAULT_ENVIRONMENTS.dev }, nodes: [] };
    expect(removeEnvironment(single, 'dev')).toBe(single);
  });
});

describe('a custom environment through the rest of the app', () => {
  const d = addEnvironment(design(), 'qa', { copyFrom: 'testing' });

  it('compiles to its own folder with its own port and name prefix', () => {
    const { files, lambdaArtifacts } = buildTerraformFiles({ ...d, edges: [] }, 'emulator');
    expect(Object.keys(files)).toContain('environments/qa/main.tf');
    expect(files['environments/qa/qa.tfvars']).toContain('emulator_port     = 9301');
    expect(files['environments/qa/variables.tf']).toContain('(dev, testing, staging, prod, qa)');
    expect(files['docker-compose.emulator.yml']).toContain('"127.0.0.1:9301:9301"');
    expect(lambdaArtifacts.some((a) => a.envId === 'qa')).toBe(true);
  });

  it('is left out of the Terraform once removed', () => {
    const { files } = buildTerraformFiles({ ...removeEnvironment(d, 'testing'), edges: [] }, 'emulator');
    expect(Object.keys(files).some((f) => f.startsWith('environments/testing/'))).toBe(false);
  });

  it('is priced, audited and exported like the defaults', () => {
    const estimate = estimateArchitectureCosts(d.nodes, d.environments);
    expect(estimate.envIds).toContain('qa');
    expect(estimate.totalsByEnv.qa).toBeGreaterThan(0);
    expect(() => findCostSavings(d.nodes, estimate)).not.toThrow();
    expect(() => auditAwsExport(d.nodes, [], d.environments)).not.toThrow();
  });

  it('gets the production checks when marked as production', () => {
    const marked = { ...d.environments, qa: { ...d.environments.qa, production: true } };
    const ids = (envs: typeof marked) => runArchitectureLinter(d.nodes, [], 'qa', envs).map((f) => f.id);
    expect(ids(marked)).toContain('rds-multiaz-n-db');
    expect(ids(d.environments)).not.toContain('rds-multiaz-n-db');
    // …and prod without the flag stays production
    expect(runArchitectureLinter(d.nodes, [], 'prod', d.environments).map((f) => f.id)).toContain('rds-multiaz-n-db');
  });

  it('is saved in the project file with its profile', () => {
    const file = toProjectFile({ ...d, edges: [] });
    expect(Object.keys(file.environments)).toEqual(['dev', 'testing', 'staging', 'prod', 'qa']);
    expect(file.environments.qa).not.toHaveProperty('color');
  });

  it('compiles on its own', () => {
    const compiled = compileTerraformForEnvironment(d.nodes, [], d.environments.qa, d.environments);
    expect(compiled.mainTf).toContain('Active Resources: 2');
    expect(compiled.providerTf).toContain('127.0.0.1:9301');
  });
});
