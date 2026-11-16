import type { CloudNode, EnvironmentId } from '../../src/types/cloud';
import { EXPLORER_SERVICE_BY_ID, explorerOperation } from '../../src/utils/explorerOps';
import { liveResourceName } from '../../src/utils/terraformNames';
import {
  MAX_RETRY_SECONDS,
  checkExpectation,
  type Scenario,
  type ScenarioRunResult,
  type ScenarioStep,
  type ScenarioStepResult,
} from '../../src/utils/scenarios';
import { resolveLiveTarget, runExplorerOperation } from './explorer';

/** What a scenario runs against: one environment's emulator and the design that was deployed to it. */
export interface ScenarioTarget {
  envId: EnvironmentId;
  port: number;
  region: string;
  nodes: CloudNode[];
}

const OUTPUT_MAX_CHARS = 4000;
const RETRY_INTERVAL_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Results are stored and shown; keep them to a readable size. */
function clip(output: unknown): unknown {
  const text = JSON.stringify(output ?? null);
  return text.length <= OUTPUT_MAX_CHARS ? output : `${text.slice(0, OUTPUT_MAX_CHARS)}… (${text.length} characters)`;
}

async function runStep(step: ScenarioStep, target: ScenarioTarget): Promise<ScenarioStepResult> {
  const started = Date.now();
  const done = (result: Omit<ScenarioStepResult, 'stepId' | 'durationMs'>): ScenarioStepResult => ({
    stepId: step.id,
    durationMs: Date.now() - started,
    ...result,
  });

  const service = EXPLORER_SERVICE_BY_ID[step.service];
  const operation = explorerOperation(step.service, step.operation);
  if (!service || !operation) {
    return done({ ok: false, attempts: 0, error: `Unknown operation ${step.service}:${step.operation}` });
  }

  let liveTarget = '';
  if (step.nodeId) {
    const node = target.nodes.find((n) => n.id === step.nodeId);
    if (!node) return done({ ok: false, attempts: 0, error: 'The resource this step used is no longer on the canvas' });
    if (node.data.serviceType !== service.nodeType) {
      return done({ ok: false, attempts: 0, error: `${node.data.label} is not a ${service.label} resource` });
    }
    if (node.data.envEnabled?.[target.envId] === false) {
      return done({ ok: false, attempts: 0, error: `${node.data.label} is switched off in ${target.envId}` });
    }
    const liveName = liveResourceName(node, target.envId);
    const resolved = await resolveLiveTarget(target.port, target.region, step.service, liveName);
    if (!resolved) {
      return done({ ok: false, attempts: 0, error: `${node.data.label} (${liveName}) is not deployed in ${target.envId}. Apply first.` });
    }
    liveTarget = resolved;
  }

  // Only a read is safe to repeat: retrying a send would deliver it again
  const retrySeconds = operation.reads ? Math.min(step.retrySeconds ?? 0, MAX_RETRY_SECONDS) : 0;
  const deadline = started + retrySeconds * 1000;
  let attempts = 0;
  for (;;) {
    attempts++;
    let output: unknown;
    let error: string | undefined;
    try {
      output = await runExplorerOperation(target.port, target.region, step.service, step.operation, liveTarget, step.input ?? {});
    } catch (err: any) {
      error = `${err?.name || 'Error'}: ${err?.message}`;
    }
    const verdict = error ? ({ ok: false, failure: error } as const) : checkExpectation(step.expect, output);
    if (verdict.ok) return done({ ok: true, attempts, output: clip(output) });
    if (Date.now() + RETRY_INTERVAL_MS > deadline) {
      return done({
        ok: false,
        attempts,
        output: clip(output),
        ...(error ? { error } : { failure: verdict.failure }),
      });
    }
    await sleep(RETRY_INTERVAL_MS);
  }
}

/** Runs a scenario's steps in order; the first failing step stops it. */
export async function runScenario(scenario: Scenario, target: ScenarioTarget): Promise<ScenarioRunResult> {
  const started = Date.now();
  const steps: ScenarioStepResult[] = [];
  for (const step of scenario.steps) {
    const result = await runStep(step, target);
    steps.push(result);
    if (!result.ok) break;
  }
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    env: target.envId,
    ok: steps.length === scenario.steps.length && steps.every((s) => s.ok),
    durationMs: Date.now() - started,
    steps,
  };
}

/** A plain-text account of a run, for the runs log and CI output. */
export function scenarioRunLog(results: ScenarioRunResult[], scenarios: Scenario[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const scenario = scenarios.find((sc) => sc.id === result.scenarioId);
    lines.push(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${result.env}, ${result.durationMs} ms)`);
    result.steps.forEach((step, i) => {
      const def = scenario?.steps.find((s) => s.id === step.stepId);
      const what = def ? `${def.service}:${def.operation}` : step.stepId;
      const tries = step.attempts > 1 ? `, ${step.attempts} attempts` : '';
      lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'} ${i + 1}. ${what} (${step.durationMs} ms${tries})`);
      if (!step.ok) lines.push(`       ${step.error || step.failure}`);
    });
    const skipped = (scenario?.steps.length ?? result.steps.length) - result.steps.length;
    if (skipped > 0) lines.push(`  ${skipped} step${skipped === 1 ? '' : 's'} not run`);
  }
  return `${lines.join('\n')}\n`;
}
