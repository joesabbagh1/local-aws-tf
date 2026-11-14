import type { CloudNode, CloudEdge, EnvironmentId, EnvironmentProfile } from '../types/cloud';
import { compileTerraformForEnvironment, resolveNodeConfigForEnv, sanitizeIdentifier } from './terraformCompiler';

export const AWS_EXPORT_DIR = 'terraform-aws';
/** Files the user is expected to edit; an export never overwrites them once they exist. */
export const AWS_EXPORT_USER_FILES = ['backend.tfbackend'];

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

export interface AwsExportNote {
  envId: EnvironmentId;
  nodeId?: string;
  message: string;
}

/**
 * Things to sort out before the exported Terraform will deploy, per environment.
 * Only covers what the emulator tolerates but AWS does not; everything else is the Audit tab's job.
 */
export function auditAwsExport(
  nodes: CloudNode[],
  edges: CloudEdge[],
  environments: Record<EnvironmentId, EnvironmentProfile>
): AwsExportNote[] {
  const notes: AwsExportNote[] = [];

  for (const envId of ENV_IDS) {
    const env = environments[envId];
    const compiled = compileTerraformForEnvironment(nodes, edges, env, environments, 'aws');

    const needs = [
      /\bvar\.vpc_id\b/.test(compiled.mainTf) && 'vpc_id',
      /\bvar\.subnet_ids\b/.test(compiled.mainTf) && 'subnet_ids',
    ].filter(Boolean);
    if (needs.length > 0) {
      notes.push({
        envId,
        message: `Some resources have no VPC or Subnet on the canvas. Set ${needs.join(' and ')} in the environment's .tfvars, or place them in one.`,
      });
    }

    for (const node of nodes) {
      if (node.data.serviceType !== 'aws_subnet' || node.data.envEnabled?.[envId] === false) continue;
      const az = String(resolveNodeConfigForEnv(node, envId).availability_zone || '');
      if (az && !az.startsWith(env.region)) {
        notes.push({
          envId,
          nodeId: node.id,
          message: `Subnet ${sanitizeIdentifier(node.data.resourceName || node.data.label)} uses ${az}, but ${envId} is in ${env.region}. Override its availability zone for ${envId}.`,
        });
      }
    }
  }

  return notes;
}

/** Notes that say the same thing about the same resource, merged into one entry listing their environments. */
export function groupAwsExportNotes(notes: AwsExportNote[]): { envIds: EnvironmentId[]; nodeId?: string; message: string }[] {
  const groups = new Map<string, { envIds: EnvironmentId[]; nodeId?: string; message: string }>();
  for (const note of notes) {
    const key = `${note.nodeId || ''}\u0000${note.message}`;
    const group = groups.get(key);
    if (group) group.envIds.push(note.envId);
    else groups.set(key, { envIds: [note.envId], nodeId: note.nodeId, message: note.message });
  }
  return [...groups.values()];
}
