import { useEffect, useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import {
  EXPLORER_SERVICES,
  EXPLORER_SERVICE_BY_ID,
  EXPLORER_SERVICE_BY_NODE_TYPE,
  buildExplorerInput,
  explorerOperation,
  type ExplorerOperation,
} from '../utils/explorerOps';
import { liveResourceName } from '../utils/terraformNames';
import { envLabel } from '../utils/environments';
import type { Scenario, ScenarioStep, ScenarioStepResult } from '../utils/scenarios';
import type { CloudNode } from '../types/cloud';
import { AlertTriangle, CheckCircle2, Loader2, Play, Plus, Trash2, X, XCircle } from 'lucide-react';
import { Button, EnvDot, IconButton, Section, Segmented, cn, fieldCls, monoFieldCls } from './ui';

interface ExploreResult {
  ok: boolean;
  emulatorOnline?: boolean;
  data?: any;
  error?: string;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** One line describing what a step does, for the scenario list. */
function stepTitle(step: ScenarioStep, nodes: CloudNode[]): string {
  const op = explorerOperation(step.service, step.operation);
  const svc = EXPLORER_SERVICE_BY_ID[step.service];
  const node = nodes.find((n) => n.id === step.nodeId);
  return `${op?.label ?? step.operation} · ${node?.data.label ?? svc?.label ?? step.service}`;
}

/** Log events read better as lines than as JSON. */
function ResultBody({ data }: { data: any }) {
  if (data && Array.isArray(data.events) && typeof data.logGroup === 'string') {
    return (
      <div className="rounded-md border border-line bg-base p-3 font-mono text-[12.5px] leading-relaxed max-h-80 overflow-y-auto select-text">
        <div className="text-fg-faint mb-1.5">{data.logGroup}</div>
        {data.events.length === 0 ? (
          <div className="text-fg-faint">{data.note || 'No log lines in this window.'}</div>
        ) : (
          data.events.map((e: { time: string; message: string }, i: number) => (
            <div key={i} className="whitespace-pre-wrap break-words text-fg/90">
              <span className="text-fg-faint">{e.time.slice(11, 19)} </span>
              {e.message}
            </div>
          ))
        )}
      </div>
    );
  }
  return (
    <pre className="rounded-md border border-line bg-base p-3 font-mono text-[12.5px] leading-relaxed text-fg/90 overflow-x-auto max-h-80 select-text whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function OperationForm({
  operation,
  values,
  onChange,
}: {
  operation: ExplorerOperation;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (operation.inputs.length === 0) return null;
  return (
    <div className="space-y-2">
      {operation.inputs.map((field) => {
        const value = values[field.key] ?? field.defaultValue ?? '';
        return (
          <label key={field.key} className="block">
            <span className="block text-[12.5px] text-fg-muted mb-1">{field.label}</span>
            {field.kind === 'text' ? (
              <input
                type="text"
                value={value}
                placeholder={field.placeholder}
                spellCheck={false}
                onChange={(e) => onChange(field.key, e.target.value)}
                className={monoFieldCls}
              />
            ) : (
              <textarea
                rows={field.kind === 'json' ? 4 : 3}
                value={value}
                placeholder={field.placeholder}
                spellCheck={false}
                onChange={(e) => onChange(field.key, e.target.value)}
                className={cn(monoFieldCls, 'resize-y leading-relaxed')}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

// ============================================================================
// Explore: one operation against one deployed resource
// ============================================================================
function ExplorePane({ onAddedStep }: { onAddedStep: () => void }) {
  const nodes = useCloudStore((s) => s.nodes);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const activeProject = useCloudStore((s) => s.activeProject);
  const scenarios = useCloudStore((s) => s.scenarios);
  const saveScenario = useCloudStore((s) => s.saveScenario);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const preferred = selectedNode ? EXPLORER_SERVICE_BY_NODE_TYPE[selectedNode.data.serviceType] : undefined;

  const [serviceId, setServiceId] = useState(preferred?.id ?? 'apigateway');
  const service = EXPLORER_SERVICE_BY_ID[serviceId];
  const candidates = nodes.filter((n) => n.data.serviceType === service.nodeType);
  const [nodeId, setNodeId] = useState<string>('');
  const [operationId, setOperationId] = useState(service.operations[0].id);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string>('');

  // Follow the canvas selection
  useEffect(() => {
    if (!preferred) return;
    setServiceId(preferred.id);
    setNodeId(selectedNode!.id);
  }, [preferred?.id, selectedNode?.id]);

  useEffect(() => {
    if (!service.operations.some((op) => op.id === operationId)) setOperationId(service.operations[0].id);
    if (!candidates.some((n) => n.id === nodeId)) setNodeId(candidates[0]?.id ?? '');
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, candidates.length]);

  const operation = service.operations.find((op) => op.id === operationId) ?? service.operations[0];
  const node = candidates.find((n) => n.id === nodeId);
  const valueKey = `${service.id}:${operation.id}`;
  const opValues = values[valueKey] ?? {};
  const offInEnv = node?.data.envEnabled?.[activeEnv] === false;

  const run = async () => {
    if (!activeProject || !node) return;
    const built = buildExplorerInput(operation, opValues);
    if ('invalid' in built) {
      setResult({ ok: false, error: `${built.invalid} must be valid JSON` });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/emulator/explore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProject.id,
          envId: activeEnv,
          service: service.id,
          operation: operation.id,
          nodeId: node.id,
          input: built.input,
        }),
      });
      setResult((await res.json()) as ExploreResult);
    } catch (err: any) {
      setResult({ ok: false, error: err?.message || 'Request failed' });
    } finally {
      setBusy(false);
    }
  };

  const addToScenario = () => {
    if (!node) return;
    const built = buildExplorerInput(operation, opValues);
    if ('invalid' in built) {
      setResult({ ok: false, error: `${built.invalid} must be valid JSON` });
      return;
    }
    const step: ScenarioStep = {
      id: newId('st'),
      service: service.id,
      operation: operation.id,
      nodeId: node.id,
      ...(Object.keys(built.input).length ? { input: built.input } : {}),
      // A read waits a little for asynchronous flows to land by default
      ...(operation.reads ? { retrySeconds: 10 } : {}),
    };
    const existing = scenarios.find((sc) => sc.id === target);
    saveScenario(
      existing
        ? { ...existing, steps: [...existing.steps, step] }
        : { id: newId('sc'), name: `Scenario ${scenarios.length + 1}`, steps: [step] }
    );
    onAddedStep();
  };

  if (!activeProject) {
    return (
      <Section>
        <p className="text-xs text-fg-muted">The Data tab needs the local backend, which runs the emulator.</p>
      </Section>
    );
  }

  return (
    <>
      <Section>
        <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2.5 items-center">
          <span className="text-xs text-fg-muted">Service</span>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={fieldCls} aria-label="Service">
            {EXPLORER_SERVICES.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-fg-muted">Resource</span>
          {candidates.length === 0 ? (
            <span className="text-xs text-fg-faint">No {SERVICE_BY_TYPE[service.nodeType]?.shortName ?? service.label} on the canvas</span>
          ) : (
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} className={fieldCls} aria-label="Resource">
              {candidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.data.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {node && (
          <p className={cn('mt-2 text-[12.5px] font-mono truncate', offInEnv ? 'text-warn' : 'text-fg-faint')}>
            {offInEnv ? `Switched off in ${envLabel(activeEnv)}` : `${liveResourceName(node, activeEnv)} in ${envLabel(activeEnv)}`}
          </p>
        )}
      </Section>

      {node && !offInEnv && (
        <Section>
          {service.operations.length > 1 && (
            <Segmented
              value={operation.id}
              onChange={(id) => {
                setOperationId(id);
                setResult(null);
              }}
              options={service.operations.map((op) => ({ value: op.id, label: op.label }))}
              className="mb-3"
            />
          )}
          <OperationForm
            operation={operation}
            values={opValues}
            onChange={(key, value) => setValues((v) => ({ ...v, [valueKey]: { ...opValues, [key]: value } }))}
          />
          <div className="mt-3 flex items-center gap-1.5">
            <Button variant="primary" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
              {operation.label}
            </Button>
            <span className="flex-1" />
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Scenario to add this step to"
              className={cn(fieldCls, 'w-[136px]')}
            >
              <option value="">New scenario</option>
              {scenarios.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
            </select>
            <Button onClick={addToScenario} title="Save this operation as a scenario step">
              <Plus className="w-3 h-3" /> Step
            </Button>
          </div>
        </Section>
      )}

      {result && (
        <Section
          title={
            <span className={cn('flex items-center gap-1.5', result.ok ? 'text-fg-muted' : 'text-err')}>
              <span className={cn('w-1.5 h-1.5 rounded-full', result.ok ? 'bg-ok' : 'bg-err')} />
              {result.ok ? 'Response' : 'Failed'}
            </span>
          }
        >
          {result.ok ? (
            <ResultBody data={result.data} />
          ) : (
            <p className="text-xs text-err flex gap-2 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{result.error}</span>
            </p>
          )}
        </Section>
      )}
    </>
  );
}

// ============================================================================
// Scenarios: saved end-to-end checks, run against the active environment
// ============================================================================
function StepRow({
  scenario,
  step,
  index,
  result,
}: {
  scenario: Scenario;
  step: ScenarioStep;
  index: number;
  result?: ScenarioStepResult;
}) {
  const nodes = useCloudStore((s) => s.nodes);
  const saveScenario = useCloudStore((s) => s.saveScenario);
  const operation = explorerOperation(step.service, step.operation);
  const [open, setOpen] = useState(false);

  const update = (patch: Partial<ScenarioStep>) =>
    saveScenario({ ...scenario, steps: scenario.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s)) });
  const updateExpect = (patch: Partial<NonNullable<ScenarioStep['expect']>>) => {
    const expect = { ...(step.expect ?? {}), ...patch };
    for (const key of Object.keys(expect) as (keyof typeof expect)[]) if (expect[key] === undefined) delete expect[key];
    update({ expect: Object.keys(expect).length ? expect : undefined });
  };
  const remove = () => saveScenario({ ...scenario, steps: scenario.steps.filter((s) => s.id !== step.id) });
  const move = (delta: number) => {
    const steps = [...scenario.steps];
    const [taken] = steps.splice(index, 1);
    steps.splice(Math.max(0, Math.min(steps.length, index + delta)), 0, taken);
    saveScenario({ ...scenario, steps });
  };

  const expectation = [
    step.expect?.status !== undefined && `HTTP ${step.expect.status}`,
    step.expect?.contains?.length && `contains ${step.expect.contains.map((c) => `“${c}”`).join(', ')}`,
    step.expect?.notContains?.length && `not ${step.expect.notContains.map((c) => `“${c}”`).join(', ')}`,
  ].filter(Boolean);

  return (
    <div className="py-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-start gap-2 text-left">
        <span className="w-4 shrink-0 mt-px">
          {result ? (
            result.ok ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-ok" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-err" />
            )
          ) : (
            <span className="font-mono text-[12.5px] text-fg-faint">{index + 1}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg truncate">{stepTitle(step, nodes)}</span>
          <span className="block text-[12.5px] text-fg-faint truncate">
            {expectation.length ? `Expect ${expectation.join(', ')}` : 'No expectation: passes if it runs'}
            {step.retrySeconds ? ` · waits up to ${step.retrySeconds} s` : ''}
          </span>
        </span>
        {result && <span className="text-[12.5px] font-mono text-fg-faint shrink-0">{result.durationMs} ms</span>}
      </button>

      {result && !result.ok && (
        <p className="ml-6 mt-1 text-[12.5px] text-err break-words">{result.error || result.failure}</p>
      )}

      {open && (
        <div className="ml-6 mt-2 space-y-2">
          {step.input && Object.keys(step.input).length > 0 && (
            <dl className="rounded-md border border-line bg-base px-2.5 py-2 font-mono text-[12px] max-h-32 overflow-auto space-y-0.5">
              {Object.entries(step.input).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="text-fg-faint shrink-0">{key}</dt>
                  <dd className="text-fg-muted break-all min-w-0">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1.5 items-center">
            <span className="text-[12.5px] text-fg-muted">Contains</span>
            <input
              type="text"
              value={step.expect?.contains?.[0] ?? ''}
              placeholder='"status":"PAID"'
              spellCheck={false}
              onChange={(e) => updateExpect({ contains: e.target.value ? [e.target.value] : undefined })}
              className={monoFieldCls}
            />
            <span className="text-[12.5px] text-fg-muted">Doesn't contain</span>
            <input
              type="text"
              value={step.expect?.notContains?.[0] ?? ''}
              placeholder="errorMessage"
              spellCheck={false}
              onChange={(e) => updateExpect({ notContains: e.target.value ? [e.target.value] : undefined })}
              className={monoFieldCls}
            />
            {step.service === 'apigateway' && (
              <>
                <span className="text-[12.5px] text-fg-muted">HTTP status</span>
                <input
                  type="number"
                  value={step.expect?.status ?? ''}
                  placeholder="200"
                  onChange={(e) => updateExpect({ status: e.target.value ? Number(e.target.value) : undefined })}
                  className={monoFieldCls}
                />
              </>
            )}
            {operation?.reads && (
              <>
                <span className="text-[12.5px] text-fg-muted" title="Repeat the read until the expectation holds">
                  Wait up to (s)
                </span>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={step.retrySeconds ?? 0}
                  onChange={(e) => update({ retrySeconds: Number(e.target.value) > 0 ? Math.min(Number(e.target.value), 120) : undefined })}
                  className={monoFieldCls}
                />
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {scenario.steps.length > 1 && (
              <>
                <Button variant="ghost" disabled={index === 0} onClick={() => move(-1)}>
                  Move up
                </Button>
                <Button variant="ghost" disabled={index === scenario.steps.length - 1} onClick={() => move(1)}>
                  Move down
                </Button>
              </>
            )}
            <span className="flex-1" />
            <Button variant="danger" onClick={remove}>
              <Trash2 className="w-3 h-3" /> Remove step
            </Button>
          </div>
          {result?.output !== undefined && (
            <details>
              <summary className="text-[12.5px] text-fg-muted cursor-pointer">
                Last output{result.attempts > 1 ? ` (${result.attempts} attempts)` : ''}
              </summary>
              <div className="mt-1.5">
                <ResultBody data={result.output} />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ScenariosPane({ onExplore }: { onExplore: () => void }) {
  const scenarios = useCloudStore((s) => s.scenarios);
  const scenarioResults = useCloudStore((s) => s.scenarioResults);
  const runningScenarioId = useCloudStore((s) => s.runningScenarioId);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const saveScenario = useCloudStore((s) => s.saveScenario);
  const removeScenario = useCloudStore((s) => s.removeScenario);
  const runScenario = useCloudStore((s) => s.runScenario);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const run = async (id: string) => {
    setErrors((e) => ({ ...e, [id]: '' }));
    const outcome = await runScenario(id);
    if ('error' in outcome) setErrors((e) => ({ ...e, [id]: outcome.error }));
  };
  const runAll = async () => {
    for (const sc of scenarios) await run(sc.id);
  };

  const env = environments[activeEnv];

  if (scenarios.length === 0) {
    return (
      <Section>
        <p className="text-xs text-fg-muted leading-relaxed">
          A scenario checks the deployed architecture end to end: send a request or a message in, then read where it
          should land. Build steps from the Explore view with <span className="text-fg">+ Step</span>.
        </p>
        <Button className="mt-3" onClick={onExplore}>
          Open Explore
        </Button>
      </Section>
    );
  }

  return (
    <>
      <Section
        title={
          <span className="flex items-center gap-1.5">
            <EnvDot color={env.color} className="w-1.5 h-1.5" />
            Runs against {env.name}
          </span>
        }
        aside={
          <Button onClick={runAll} disabled={runningScenarioId !== null} className="-mr-1">
            <Play className="w-3 h-3 fill-current" /> Run all
          </Button>
        }
      >
        <p className="text-[12.5px] text-fg-faint">
          Steps run in order and stop at the first failure. Scenarios are saved with the project and versioned with the design.
        </p>
      </Section>

      {scenarios.map((scenario) => {
        const result = scenarioResults[scenario.id]?.[activeEnv];
        const running = runningScenarioId === scenario.id;
        return (
          <Section key={scenario.id}>
            <div className="flex items-center gap-1.5 mb-1">
              {result && (
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', result.ok ? 'bg-ok' : 'bg-err')} title={result.ok ? 'Passed' : 'Failed'} />
              )}
              <input
                type="text"
                value={scenario.name}
                aria-label="Scenario name"
                onChange={(e) => saveScenario({ ...scenario, name: e.target.value })}
                className="flex-1 min-w-0 bg-transparent text-[14px] text-fg font-medium focus:outline-none border-b border-transparent focus:border-line-strong"
              />
              <Button onClick={() => run(scenario.id)} disabled={runningScenarioId !== null || scenario.steps.length === 0}>
                {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 fill-current" />}
                Run
              </Button>
              {confirmDelete === scenario.id ? (
                <>
                  <Button
                    variant="danger"
                    onClick={() => {
                      removeScenario(scenario.id);
                      setConfirmDelete(null);
                    }}
                  >
                    Delete
                  </Button>
                  <IconButton onClick={() => setConfirmDelete(null)} title="Keep it">
                    <X className="w-3.5 h-3.5" />
                  </IconButton>
                </>
              ) : (
                <IconButton variant="danger" onClick={() => setConfirmDelete(scenario.id)} title="Delete scenario">
                  <Trash2 className="w-3.5 h-3.5" />
                </IconButton>
              )}
            </div>
            {result && (
              <p className="text-[12.5px] text-fg-faint mb-1">
                {result.ok ? 'Passed' : 'Failed'} in {envLabel(result.env)} · {(result.durationMs / 1000).toFixed(1)} s
              </p>
            )}
            {errors[scenario.id] && <p className="text-[12.5px] text-err mb-1 break-words">{errors[scenario.id]}</p>}
            <div className="divide-y divide-line">
              {scenario.steps.length === 0 ? (
                <p className="py-2 text-[12.5px] text-fg-faint">No steps yet. Add them from Explore.</p>
              ) : (
                scenario.steps.map((step, i) => (
                  <StepRow
                    key={step.id}
                    scenario={scenario}
                    step={step}
                    index={i}
                    result={result?.steps.find((r) => r.stepId === step.id)}
                  />
                ))
              )}
            </div>
          </Section>
        );
      })}
    </>
  );
}

export function ResourceExplorerPanel() {
  const scenarioCount = useCloudStore((s) => s.scenarios.length);
  const [mode, setMode] = useState<'explore' | 'scenarios'>('explore');
  const label = useMemo(() => (scenarioCount ? `Scenarios · ${scenarioCount}` : 'Scenarios'), [scenarioCount]);

  return (
    <>
      <div className="px-4 pt-3 pb-1">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'explore', label: 'Explore' },
            { value: 'scenarios', label },
          ]}
        />
      </div>
      {mode === 'explore' ? (
        <ExplorePane onAddedStep={() => setMode('scenarios')} />
      ) : (
        <ScenariosPane onExplore={() => setMode('explore')} />
      )}
    </>
  );
}
