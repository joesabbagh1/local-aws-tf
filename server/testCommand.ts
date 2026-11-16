import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudEdge, CloudNode, EnvironmentId, EnvironmentProfile } from '../src/types/cloud';
import { envIdsOf, resolveEnvironments } from '../src/utils/environments';
import { buildTerraformFiles } from '../src/utils/terraformBundle';
import { parseScenario, type Scenario, type ScenarioRunResult } from '../src/utils/scenarios';
import {
  PROJECT_FILE,
  buildLambdaArtifact,
  checkEmulatorHealth,
  emulatorContainerLogs,
  getEmulatorAwsEnv,
  startEmulatorContainer,
  stopEmulatorContainer,
} from './api';
import { emulatorDataDir } from './services/explorer';
import { runScenario, scenarioRunLog } from './services/scenarioRunner';
import { recoverFromEmulatorGaps, runTerraform, type TerraformSession } from './services/terraformRunner';

/**
 * `localcloud-studio test`: deploys a project to a fresh emulator, runs its saved scenarios, and
 * destroys it again. Needs Docker and Terraform, not Postgres: it reads the committed
 * localcloud.json, so it runs the same in CI as on a laptop.
 *
 *   localcloud-studio test [projectDir] [--env dev[,staging]] [--scenario <name>] [--port 9398] [--keep] [--verbose]
 *
 * Exit codes: 0 everything passed, 1 a scenario or the deploy failed, 2 it could not run at all.
 */

const USAGE = `Usage: localcloud-studio test [projectDir] [--env dev[,staging]] [--scenario <name>]... [--port 9398] [--keep] [--verbose]

Deploys the project in <projectDir>/${PROJECT_FILE} to a fresh emulator, runs its saved
scenarios, then destroys everything. Needs Docker and Terraform; no database.

  --env        environments to test, comma-separated (default: dev, or the first one)
  --scenario   only run scenarios with this name or id (repeatable; default: all)
  --port       emulator port for the test (default 9398, away from the app's 9297+)
  --keep       leave the emulator and the Terraform folder running for a look afterwards
  --verbose    stream all Terraform output (by default it is shown only when a step fails)

Exit codes: 0 all passed, 1 a scenario or the deploy failed, 2 it could not run.`;

interface TestArgs {
  projectDir: string;
  envs: string[];
  scenarios: string[];
  port: number;
  keep: boolean;
  verbose: boolean;
}

export function parseTestArgs(argv: string[]): TestArgs | string {
  const args: TestArgs = { projectDir: process.cwd(), envs: [], scenarios: [], port: 9398, keep: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!inline) throw new Error(`${arg.split('=')[0]} needs a value`);
      return inline;
    };
    try {
      if (arg === '--help' || arg === '-h') return USAGE;
      else if (arg === '--keep') args.keep = true;
      else if (arg === '--verbose') args.verbose = true;
      else if (arg === '--env' || arg.startsWith('--env=')) args.envs.push(...value().split(',').map((e) => e.trim()).filter(Boolean));
      else if (arg === '--scenario' || arg.startsWith('--scenario=')) args.scenarios.push(value());
      else if (arg === '--port' || arg.startsWith('--port=')) args.port = Number(value());
      else if (!arg.startsWith('-')) args.projectDir = path.resolve(arg);
      else return `Unknown option: ${arg}\n\n${USAGE}`;
    } catch (err: any) {
      return `${err.message}\n\n${USAGE}`;
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) return `--port must be a port number from 1024 to 65535\n\n${USAGE}`;
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEmulator(port: number, timeoutMs = 120000): Promise<boolean> {
  const credentials = path.join(emulatorDataDir(), String(port), 'emulator_credentials');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkEmulatorHealth(port);
    if (health.running && health.caExists && fs.existsSync(credentials)) return true;
    await sleep(1000);
  }
  return false;
}

interface EnvOutcome {
  envId: EnvironmentId;
  deployed: boolean;
  destroyed: boolean | null;
  results: ScenarioRunResult[];
  error?: string;
}

/** Everything about one environment's run: deploy, scenarios, destroy. Never throws. */
async function testEnvironment(
  args: TestArgs,
  design: { nodes: CloudNode[]; edges: CloudEdge[]; environments: Record<EnvironmentId, EnvironmentProfile> },
  envId: EnvironmentId,
  scenarios: Scenario[]
): Promise<EnvOutcome> {
  const outcome: EnvOutcome = { envId, deployed: false, destroyed: null, results: [] };
  const say = (line: string) => console.log(`[${envId}] ${line}`);
  // The design's own port belongs to the app's emulator for this environment; the test gets its own
  const profile: EnvironmentProfile = {
    ...design.environments[envId],
    emulatorPort: args.port,
    emulatorEndpoint: `https://127.0.0.1:${args.port}`,
  };
  const environments = { ...design.environments, [envId]: profile };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `localcloud-test-${envId}-`));
  const envDir = path.join(workDir, 'environments', envId);
  const container = `localcloud-test-${envId}`;

  // Terraform output is long; keep it, and print it when a step fails
  let transcript = '';
  const session: TerraformSession = {
    cwd: envDir,
    env: getEmulatorAwsEnv(args.port, profile.region),
    varFile: `-var-file=${envId}.tfvars`,
    write: (chunk) => {
      transcript += String(chunk);
      if (args.verbose) process.stdout.write(chunk);
    },
  };
  const step = async (label: string, kind: 'apply' | 'destroy' | null, tfArgs: string[]) => {
    transcript = '';
    const first = await runTerraform(session, tfArgs);
    const code = first.code === 0 ? 0 : ((await recoverFromEmulatorGaps(session, kind, first.output)) ?? first.code);
    if (code !== 0 && !args.verbose) process.stdout.write(`${transcript.split('\n').slice(-60).join('\n')}\n`);
    say(`${label} ${code === 0 ? 'ok' : `failed (exit ${code})`}`);
    return code === 0;
  };

  try {
    const bundle = buildTerraformFiles({ ...design, environments }, 'emulator');
    for (const [rel, content] of Object.entries(bundle.files)) {
      if (!rel.startsWith(`environments/${envId}/`) && rel !== 'Dockerfile.emulator') continue;
      fs.mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(workDir, rel), content);
    }
    for (const art of bundle.lambdaArtifacts.filter((a) => a.envId === envId)) {
      const built = await buildLambdaArtifact(envDir, args.projectDir, art);
      if (built.error) throw new Error(built.error);
    }

    // A fresh emulator every run, so a result never depends on what an earlier run left behind
    fs.rmSync(path.join(emulatorDataDir(), String(args.port)), { recursive: true, force: true });
    say(`starting an emulator on port ${args.port}`);
    const started = await startEmulatorContainer(container, args.port, workDir);
    if (!started.ok) throw new Error(`the emulator did not start: ${started.error || started.output}`);
    if (!(await waitForEmulator(args.port))) {
      throw new Error(`the emulator did not become healthy. Its log:\n${(await emulatorContainerLogs(container)) || '(empty)'}`);
    }

    if (!(await step('terraform init', null, ['init', '-no-color', '-input=false']))) throw new Error('terraform init failed');
    outcome.deployed = await step('deploy', 'apply', ['apply', session.varFile, '-auto-approve', '-no-color', '-input=false']);
    if (outcome.deployed) {
      for (const scenario of scenarios) {
        const result = await runScenario(scenario, { envId, port: args.port, region: profile.region, nodes: design.nodes });
        outcome.results.push(result);
        process.stdout.write(scenarioRunLog([result], scenarios).replace(/^/gm, `[${envId}] `).replace(/\[[^\]]+\] $/, ''));
      }
    }
    if (!args.keep) outcome.destroyed = await step('destroy', 'destroy', ['destroy', session.varFile, '-auto-approve', '-no-color', '-input=false']);
  } catch (err: any) {
    outcome.error = String(err?.message || err);
    say(outcome.error);
  } finally {
    if (args.keep) {
      say(`kept the emulator on https://127.0.0.1:${args.port} (container ${container}) and the Terraform in ${envDir}`);
    } else {
      await stopEmulatorContainer(container);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  return outcome;
}

/** A Markdown table for the GitHub Actions job summary, when running there. */
function writeJobSummary(outcomes: EnvOutcome[]) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = outcomes.flatMap((o) => [
    `| ${o.envId} | deploy | ${o.deployed ? 'pass' : 'fail'} |`,
    ...o.results.map((r) => `| ${o.envId} | ${r.name.replace(/\|/g, '\\|')} | ${r.ok ? 'pass' : 'fail'} |`),
    ...(o.destroyed === false ? [`| ${o.envId} | destroy | fail |`] : []),
  ]);
  fs.appendFileSync(file, `### LocalCloud scenarios\n\n| Environment | Check | Result |\n|---|---|---|\n${rows.join('\n')}\n`);
}

export async function runTestCommand(argv: string[]): Promise<number> {
  const parsed = parseTestArgs(argv);
  if (typeof parsed === 'string') {
    console.log(parsed);
    return parsed === USAGE ? 0 : 2;
  }
  const args = parsed;

  const file = path.join(args.projectDir, PROJECT_FILE);
  if (!fs.existsSync(file)) {
    console.error(`No ${PROJECT_FILE} in ${args.projectDir}. Open the project in LocalCloud Studio once to write it, or pass its folder.`);
    return 2;
  }
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: any) {
    console.error(`${file} is not valid JSON: ${err.message}`);
    return 2;
  }
  const design = {
    nodes: (Array.isArray(doc.nodes) ? doc.nodes : []) as CloudNode[],
    edges: (Array.isArray(doc.edges) ? doc.edges : []) as CloudEdge[],
    environments: resolveEnvironments(doc.environments),
  };
  if (design.nodes.length === 0) {
    console.error(`${file} has no resources to deploy.`);
    return 2;
  }

  const known = envIdsOf(design.environments);
  const envs = args.envs.length > 0 ? args.envs : [known.includes('dev') ? 'dev' : known[0]];
  const unknownEnv = envs.find((e) => !known.includes(e));
  if (unknownEnv) {
    console.error(`The project has no environment "${unknownEnv}". It has: ${known.join(', ')}.`);
    return 2;
  }

  const saved: Scenario[] = [];
  (Array.isArray(doc.scenarios) ? doc.scenarios : []).forEach((raw: unknown, i: number) => {
    const parsed = parseScenario(raw, () => `scenario-${i + 1}`);
    if ('scenario' in parsed) saved.push(parsed.scenario);
    else console.warn(`Skipping scenario ${i + 1}: ${parsed.error}`);
  });
  const scenarios = args.scenarios.length > 0 ? saved.filter((sc) => args.scenarios.includes(sc.name) || args.scenarios.includes(sc.id)) : saved;
  const missing = args.scenarios.filter((want) => !saved.some((sc) => sc.name === want || sc.id === want));
  if (missing.length > 0) {
    console.error(`No scenario named ${missing.map((m) => `"${m}"`).join(', ')}. Saved: ${saved.map((sc) => `"${sc.name}"`).join(', ') || 'none'}.`);
    return 2;
  }
  if (scenarios.length === 0) console.log('No saved scenarios: checking that the project deploys and destroys cleanly.');

  const outcomes: EnvOutcome[] = [];
  for (const envId of envs) outcomes.push(await testEnvironment(args, design, envId, scenarios));
  writeJobSummary(outcomes);

  const failedScenarios = outcomes.flatMap((o) => o.results.filter((r) => !r.ok).map((r) => `${o.envId}: ${r.name}`));
  const broken = outcomes.filter((o) => !o.deployed || o.destroyed === false || o.error);
  const passed = outcomes.reduce((n, o) => n + o.results.filter((r) => r.ok).length, 0);
  console.log(
    `\n${passed} scenario run${passed === 1 ? '' : 's'} passed, ${failedScenarios.length} failed` +
      `${broken.length ? `; ${broken.map((o) => `${o.envId} ${o.error ? 'could not run' : !o.deployed ? 'did not deploy' : 'did not destroy'}`).join(', ')}` : ''}.`
  );
  // Could not even start (Docker, Terraform, the emulator): 2, like the emulator test
  if (outcomes.every((o) => o.error && !o.deployed)) return 2;
  return failedScenarios.length === 0 && broken.length === 0 ? 0 : 1;
}
