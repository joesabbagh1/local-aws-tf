import type { CloudEdge, CloudNode, EnvironmentId, EnvironmentProfile } from '../types/cloud';
import {
  compileTerraformForEnvironment,
  resolveNodeConfigForEnv,
  sanitizeIdentifier,
  type CompileTarget,
} from './terraformCompiler';
import { AWS_EXPORT_USER_FILES } from './awsExport';
import { envIdsOf } from './environments';


/**
 * The design plus its per-environment profiles: everything the compiler needs. Kept structural so
 * both the UI store and the server-side sync path can pass their own state shape.
 */
export interface TerraformSource {
  nodes: CloudNode[];
  edges: CloudEdge[];
  environments: Record<EnvironmentId, EnvironmentProfile>;
}

export interface LambdaArtifact {
  envId: EnvironmentId;
  resourceName: string;
  runtime: string;
  handler: string;
  code?: string;
  sourceDir?: string;
}

/** Everything that decides what `terraform plan` would do for one environment. */
export function planFingerprint(state: TerraformSource, envId: EnvironmentId): string {
  const compiled = compileTerraformForEnvironment(
    state.nodes,
    state.edges,
    state.environments[envId],
    state.environments
  );
  const lambdaCode = state.nodes
    .filter((n) => n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[envId] !== false)
    .map((n) => `${n.id}:${n.data.sourceDir ?? ''}:${n.data.inlineCode || ''}`);
  return [compiled.mainTf, compiled.providerTf, compiled.variablesTf, compiled.tfvars, compiled.outputsTf, ...lambdaCode].join('\u0000');
}

/** Every file of one compile target, laid out as environments/<env>/…, plus the Lambda zips to build. */
export function buildTerraformFiles(state: TerraformSource, target: CompileTarget) {
  const { nodes, edges, environments } = state;
  const files: Record<string, string> = {};
  const filesIfMissing: Record<string, string> = {};
  const lambdaArtifacts: LambdaArtifact[] = [];

  const envIds = envIdsOf(environments);
  for (const envId of envIds) {
    const compiled = compileTerraformForEnvironment(nodes, edges, environments[envId], environments, target);
    const dir = `environments/${envId}`;
    files[`${dir}/main.tf`] = compiled.mainTf;
    files[`${dir}/provider.tf`] = compiled.providerTf;
    files[`${dir}/variables.tf`] = compiled.variablesTf;
    files[`${dir}/${envId}.tfvars`] = compiled.tfvars;
    files[`${dir}/outputs.tf`] = compiled.outputsTf;

    if (target === 'emulator') {
      files[`${dir}/run-emulator-${envId}.sh`] = compiled.emulatorScriptSh;
      // The emulator image and compose file cover every environment; write them once
      if (envId === envIds[0]) {
        files['Dockerfile.emulator'] = compiled.dockerfile;
        files['docker-compose.emulator.yml'] = compiled.dockerComposeYml;
      }
    } else {
      files[`${dir}/backend.tf`] = compiled.backendTf;
      // Filled in by the user once; later exports keep their values
      for (const name of AWS_EXPORT_USER_FILES) filesIfMissing[`${dir}/${name}`] = compiled.backendConfig;
    }

    for (const n of nodes) {
      if (n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[envId] !== false) {
        const cfg = resolveNodeConfigForEnv(n, envId);
        lambdaArtifacts.push({
          envId,
          resourceName: sanitizeIdentifier(n.data.resourceName || n.data.label),
          runtime: String(cfg.runtime || 'nodejs20.x'),
          handler: String(cfg.handler || 'index.handler'),
          code: n.data.inlineCode,
          sourceDir: n.data.sourceDir,
        });
      }
    }
  }

  return { files, filesIfMissing, lambdaArtifacts };
}
