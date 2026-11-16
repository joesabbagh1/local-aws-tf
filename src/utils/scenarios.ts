/**
 * A scenario is a saved end-to-end check of the deployed architecture: a list of steps run in order
 * against one environment's emulator ("send this request, then expect that item in the table").
 * Scenarios live in the project document, so they are versioned and committed with the design.
 */

export interface ScenarioExpectation {
  /** Every string must appear somewhere in the step's JSON result. */
  contains?: string[];
  /** None of these may appear. */
  notContains?: string[];
  /** HTTP status, for API Gateway requests. */
  status?: number;
}

export interface ScenarioStep {
  id: string;
  /** An explorer service and operation (see utils/explorerOps.ts), e.g. `sqs` + `send_message`. */
  service: string;
  operation: string;
  /** The canvas resource the step acts on; resolved to the live resource of the environment under test. */
  nodeId?: string;
  input?: Record<string, unknown>;
  expect?: ScenarioExpectation;
  /**
   * Asynchronous flows take a moment to land: the step is repeated until its expectation holds,
   * for at most this many seconds. 0 runs it once.
   */
  retrySeconds?: number;
}

export interface Scenario {
  id: string;
  name: string;
  steps: ScenarioStep[];
}

export interface ScenarioStepResult {
  stepId: string;
  ok: boolean;
  attempts: number;
  durationMs: number;
  /** What the operation returned (clipped), or why it could not run. */
  output?: unknown;
  error?: string;
  /** The expectation that did not hold, in words. */
  failure?: string;
}

export interface ScenarioRunResult {
  scenarioId: string;
  name: string;
  env: string;
  ok: boolean;
  durationMs: number;
  steps: ScenarioStepResult[];
}

export const MAX_RETRY_SECONDS = 120;

const asStringList = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return value ? [value] : undefined;
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return list.length ? list : undefined;
};

/** A scenario from untrusted input (an API body, a hand-edited project file), or why it isn't one. */
export function parseScenario(value: unknown, makeId: () => string): { scenario: Scenario } | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'scenario must be an object' };
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { error: 'scenario.name is required' };
  if (!Array.isArray(raw.steps)) return { error: 'scenario.steps must be a list' };

  const steps: ScenarioStep[] = [];
  for (const [index, item] of raw.steps.entries()) {
    if (!item || typeof item !== 'object') return { error: `step ${index + 1} must be an object` };
    const step = item as Record<string, unknown>;
    if (typeof step.service !== 'string' || typeof step.operation !== 'string' || !step.service || !step.operation) {
      return { error: `step ${index + 1} needs a service and an operation` };
    }
    const expectRaw = step.expect && typeof step.expect === 'object' ? (step.expect as Record<string, unknown>) : null;
    const expect: ScenarioExpectation = {};
    if (expectRaw) {
      const contains = asStringList(expectRaw.contains);
      const notContains = asStringList(expectRaw.notContains);
      if (contains) expect.contains = contains;
      if (notContains) expect.notContains = notContains;
      if (Number.isInteger(expectRaw.status)) expect.status = expectRaw.status as number;
    }
    const retry = Number(step.retrySeconds);
    steps.push({
      id: typeof step.id === 'string' && step.id ? step.id : makeId(),
      service: step.service,
      operation: step.operation,
      ...(typeof step.nodeId === 'string' && step.nodeId ? { nodeId: step.nodeId } : {}),
      ...(step.input && typeof step.input === 'object' ? { input: step.input as Record<string, unknown> } : {}),
      ...(Object.keys(expect).length ? { expect } : {}),
      ...(Number.isFinite(retry) && retry > 0 ? { retrySeconds: Math.min(retry, MAX_RETRY_SECONDS) } : {}),
    });
  }

  return {
    scenario: { id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(), name, steps },
  };
}

/** Text quoted for a message; text that has double quotes of its own gets single ones. */
const quoteText = (text: string) => (text.includes('"') ? `'${text}'` : `"${text}"`);

/** Whether a step's result satisfies its expectation; `failure` says what didn't hold. */
export function checkExpectation(
  expect: ScenarioExpectation | undefined,
  output: unknown
): { ok: true } | { ok: false; failure: string } {
  if (!expect) return { ok: true };
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  if (expect.status !== undefined) {
    const status = (output as { status?: unknown } | null)?.status;
    if (status !== expect.status) return { ok: false, failure: `expected HTTP ${expect.status}, got ${status ?? 'no status'}` };
  }
  for (const needle of expect.contains ?? []) {
    if (!text.includes(needle)) return { ok: false, failure: `expected the result to contain ${quoteText(needle)}` };
  }
  for (const needle of expect.notContains ?? []) {
    if (text.includes(needle)) return { ok: false, failure: `expected the result not to contain ${quoteText(needle)}` };
  }
  return { ok: true };
}
