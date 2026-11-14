import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENTS } from '../src/data/awsCatalog';
import { ARCHITECTURE_TEMPLATES } from '../src/data/templates';
import { compileTerraformForEnvironment } from '../src/utils/terraformCompiler';
import { auditAwsExport, groupAwsExportNotes } from '../src/utils/awsExport';
import { normalizeNodes } from '../src/utils/canvasLayout';
import type { EnvironmentId } from '../src/types/cloud';
import { NO_NETWORK_CANVAS, nodeFor } from './fixtures';

const compile = (target: 'emulator' | 'aws', envId: EnvironmentId = 'dev') =>
  compileTerraformForEnvironment(NO_NETWORK_CANVAS, [], DEFAULT_ENVIRONMENTS[envId], DEFAULT_ENVIRONMENTS, target);

describe('AWS export', () => {
  it('never contains emulator endpoints, credentials or placeholder IDs', () => {
    const out = compile('aws');
    const all = [out.mainTf, out.providerTf, out.variablesTf, out.tfvars, out.backendTf, out.backendConfig].join('\n');
    expect(all).not.toMatch(/emulator_endpoint|emulator_port|\.aws\/emulator|127\.0\.0\.1|vpc-default|subnet-default|ami-0c55b159cbfafe1f0|EmulatorPort/);
  });

  it('asks for an existing network when the canvas has none', () => {
    const out = compile('aws');
    expect(out.mainTf).toContain('subnet_id                   = var.subnet_ids[0]');
    expect(out.mainTf).toContain('vpc_zone_identifier       = var.subnet_ids');
    expect(out.variablesTf).toContain('variable "subnet_ids" {');
    expect(out.tfvars).toContain('subnet_ids = ["CHANGE-ME"]');
  });

  it('declares no network inputs when the canvas provides the network', () => {
    const tpl = ARCHITECTURE_TEMPLATES.find((t) => t.id === 'vpc-ecs-rds-ha')!;
    const out = compileTerraformForEnvironment(normalizeNodes(tpl.nodes), tpl.edges, DEFAULT_ENVIRONMENTS.dev, DEFAULT_ENVIRONMENTS, 'aws');
    expect(out.variablesTf).not.toMatch(/variable "(vpc_id|subnet_ids)"/);
    expect(out.tfvars).not.toContain('CHANGE-ME');
  });

  it('looks up Amazon Linux 2023 for the default AMI, by architecture', () => {
    const { mainTf } = compile('aws');
    expect(mainTf).toContain('ami                         = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value');
    expect(mainTf).toContain('ami                         = data.aws_ssm_parameter.al2023_ami_arm64.insecure_value');
    expect(mainTf).toContain('image_id      = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value');
    expect(mainTf.match(/data "aws_ssm_parameter" "al2023_ami_x86_64"/g)).toHaveLength(1);
    expect(mainTf).toContain('ami                         = "ami-0abcdef1234567890"');
  });

  it('keeps the emulator build on placeholders, with no backend', () => {
    const out = compile('emulator');
    expect(out.mainTf).toContain('"subnet-default-dev-a"');
    expect(out.mainTf).not.toContain('aws_ssm_parameter');
    expect(out.backendTf).toBe('');
    expect(out.backendConfig).toBe('');
  });

  it('gives every environment its own state key and region', () => {
    expect(compile('aws', 'prod').backendConfig).toContain('key          = "localcloud/prod/terraform.tfstate"');
    expect(compile('aws', 'prod').backendConfig).toContain('region       = "us-west-2"');
  });
});

describe('auditAwsExport', () => {
  it('flags network inputs per environment', () => {
    const notes = auditAwsExport(NO_NETWORK_CANVAS, [], DEFAULT_ENVIRONMENTS);
    expect(notes.map((n) => n.envId)).toEqual(['dev', 'testing', 'staging', 'prod']);
    expect(notes[0].message).toContain('vpc_id and subnet_ids');
  });

  it('flags subnets whose zone is in another region', () => {
    const subnet = nodeFor('aws_subnet', 'app_a', { availability_zone: 'us-east-1a' });
    subnet.data.envOverrides = { prod: { availability_zone: 'us-west-2a' } };
    const vpc = nodeFor('aws_vpc', 'main');
    const notes = auditAwsExport([vpc, subnet], [], DEFAULT_ENVIRONMENTS);
    // dev and testing are in us-east-1; prod overrides; staging is us-west-2 with no override
    expect(notes.map((n) => [n.envId, n.nodeId])).toEqual([['staging', 'n-app_a']]);
  });

  it('is clean for a blueprint that defines its own network', () => {
    const tpl = ARCHITECTURE_TEMPLATES.find((t) => t.id === 'serverless-ecommerce')!;
    expect(auditAwsExport(normalizeNodes(tpl.nodes), tpl.edges, DEFAULT_ENVIRONMENTS)).toEqual([]);
  });
});

describe('groupAwsExportNotes', () => {
  it('merges the same note across environments', () => {
    const groups = groupAwsExportNotes(auditAwsExport(NO_NETWORK_CANVAS, [], DEFAULT_ENVIRONMENTS));
    expect(groups).toHaveLength(1);
    expect(groups[0].envIds).toEqual(['dev', 'testing', 'staging', 'prod']);
  });
});
