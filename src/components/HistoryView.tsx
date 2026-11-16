import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useCloudStore } from '../store/useCloudStore';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { classifyPlanActions, type PlanResourceChange } from '../utils/planSummary';
import { envLabel } from '../utils/environments';
import { PLAN_ACTION_STYLE } from './PlanReviewBar';
import { Button, EnvDot, IconButton, Segmented, cn } from './ui';

/** Mirrors server/services/projectStore.ts (the page only reads it). */
interface FieldChange {
  field: string;
  env?: string;
  from?: unknown;
  to?: unknown;
}
interface EdgeBrief {
  id: string;
  sourceLabel: string;
  targetLabel: string;
}
interface ProjectDiff {
  nodes: {
    added: { id: string; label: string; serviceType: string }[];
    removed: { id: string; label: string; serviceType: string }[];
    changed: { id: string; label: string; serviceType: string; fields: FieldChange[] }[];
  };
  edges: { added: EdgeBrief[]; removed: EdgeBrief[]; changed: (EdgeBrief & { changes: string[] })[] };
  environmentChanges: { id: string; change: 'added' | 'removed' | 'changed'; fields: FieldChange[] }[];
  scenarios: { added: string[]; removed: string[]; changed: string[] };
}

interface VersionMeta {
  version: number;
  summary: string | null;
  actor: string;
  created_at: string;
}

interface RunMeta {
  id: number;
  env: string;
  command: string;
  status: string;
  exit_code: number | null;
  actor: string;
  doc_version: number | null;
  plan: { add: number; change: number; destroy: number } | null;
  started_at: string;
  finished_at: string | null;
}

interface RunDetail extends RunMeta {
  log: string | null;
  planChanges: PlanResourceChange[] | null;
}

interface EventRow {
  id: number;
  actor: string;
  action: string;
  payload: unknown;
  doc_version: number | null;
  created_at: string;
}

type Tab = 'changes' | 'runs' | 'activity';

const ACTOR_LABEL: Record<string, string> = {
  ui: 'Canvas',
  mcp: 'Agent',
  import: 'File',
  cli: 'Command line',
};
const actorLabel = (actor: string) => ACTOR_LABEL[actor] ?? actor;

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}

const fullTime = (iso: string) => new Date(iso).toLocaleString();

function duration(run: RunMeta): string {
  if (!run.finished_at) return 'running';
  const seconds = Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A field's value, short enough to sit in a table cell. */
function shown(value: unknown): string {
  if (value === undefined) return 'not set';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

const versionSummary = (v: VersionMeta) => v.summary || (v.actor === 'ui' ? 'Edited on the canvas' : 'Saved');

const RUN_STATUS: Record<string, { dot: string; label: string }> = {
  succeeded: { dot: 'bg-ok', label: 'Succeeded' },
  failed: { dot: 'bg-err', label: 'Failed' },
  running: { dot: 'bg-warn', label: 'Running' },
  aborted: { dot: 'bg-fg-faint', label: 'Aborted' },
  'stale-plan': { dot: 'bg-warn', label: 'Plan was stale' },
};
const runStatus = (status: string) => RUN_STATUS[status] ?? { dot: 'bg-fg-faint', label: status };
const runTitle = (run: RunMeta) => (run.command === 'scenario' ? 'Scenarios' : `terraform ${run.command}`);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

function ListRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-2.5 border-b border-line transition-colors',
        selected ? 'bg-raised' : 'hover:bg-raised/60'
      )}
    >
      {children}
    </button>
  );
}

function DiffLine({ symbol, tone, children }: { symbol: string; tone: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 py-1 text-xs">
      <span className={cn('font-mono w-3 shrink-0 text-center', tone)}>{symbol}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function FieldTable({ fields }: { fields: FieldChange[] }) {
  if (fields.length === 0) return null;
  return (
    <table className="mt-1 w-full text-[12.5px] font-mono">
      <tbody>
        {fields.map((f, i) => (
          <tr key={i} className="align-baseline">
            <td className="py-0.5 pr-3 text-fg-muted whitespace-nowrap">
              {f.field}
              {f.env && <span className="text-fg-faint"> · {envLabel(f.env)}</span>}
            </td>
            <td className="py-0.5 w-full break-all">
              {'from' in f || 'to' in f ? (
                <>
                  <span className="text-fg-faint">{shown(f.from)}</span>
                  <ArrowRight className="inline w-3 h-3 mx-1.5 text-fg-faint" />
                  <span className="text-fg">{shown(f.to)}</span>
                </>
              ) : (
                <span className="text-fg-faint">changed</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DiffGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="text-xs font-medium text-fg-muted mb-1.5">{title}</h3>
      {children}
    </section>
  );
}

function DiffBody({ diff }: { diff: ProjectDiff }) {
  const serviceName = (type: string) => SERVICE_BY_TYPE[type]?.shortName ?? type;
  const nodeCount = diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length;
  const edgeCount = diff.edges.added.length + diff.edges.removed.length + diff.edges.changed.length;
  const scenarioCount = diff.scenarios.added.length + diff.scenarios.removed.length + diff.scenarios.changed.length;
  if (nodeCount + edgeCount + scenarioCount + diff.environmentChanges.length === 0) {
    return <p className="text-xs text-fg-muted">The design is the same in both versions.</p>;
  }

  return (
    <>
      {nodeCount > 0 && (
        <DiffGroup title="Resources">
          {diff.nodes.added.map((n) => (
            <DiffLine key={n.id} symbol="+" tone="text-ok">
              <span className="text-fg">{n.label}</span> <span className="text-fg-faint">{serviceName(n.serviceType)}</span>
            </DiffLine>
          ))}
          {diff.nodes.removed.map((n) => (
            <DiffLine key={n.id} symbol="−" tone="text-err">
              <span className="text-fg-muted line-through">{n.label}</span>{' '}
              <span className="text-fg-faint">{serviceName(n.serviceType)}</span>
            </DiffLine>
          ))}
          {diff.nodes.changed.map((n) => (
            <DiffLine key={n.id} symbol="~" tone="text-warn">
              <span className="text-fg">{n.label}</span> <span className="text-fg-faint">{serviceName(n.serviceType)}</span>
              <FieldTable fields={n.fields} />
            </DiffLine>
          ))}
        </DiffGroup>
      )}

      {edgeCount > 0 && (
        <DiffGroup title="Connections">
          {diff.edges.added.map((e) => (
            <DiffLine key={e.id} symbol="+" tone="text-ok">
              <span className="text-fg">{e.sourceLabel}</span>
              <ArrowRight className="inline w-3 h-3 mx-1.5 text-fg-faint" />
              <span className="text-fg">{e.targetLabel}</span>
            </DiffLine>
          ))}
          {diff.edges.removed.map((e) => (
            <DiffLine key={e.id} symbol="−" tone="text-err">
              <span className="text-fg-muted">{e.sourceLabel}</span>
              <ArrowRight className="inline w-3 h-3 mx-1.5 text-fg-faint" />
              <span className="text-fg-muted">{e.targetLabel}</span>
            </DiffLine>
          ))}
          {diff.edges.changed.map((e) => (
            <DiffLine key={e.id} symbol="~" tone="text-warn">
              <span className="text-fg">{e.sourceLabel}</span>
              <ArrowRight className="inline w-3 h-3 mx-1.5 text-fg-faint" />
              <span className="text-fg">{e.targetLabel}</span>{' '}
              <span className="text-fg-faint">{e.changes.join(', ')}</span>
            </DiffLine>
          ))}
        </DiffGroup>
      )}

      {diff.environmentChanges.length > 0 && (
        <DiffGroup title="Environments">
          {diff.environmentChanges.map((c) => (
            <DiffLine
              key={c.id}
              symbol={c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '~'}
              tone={c.change === 'added' ? 'text-ok' : c.change === 'removed' ? 'text-err' : 'text-warn'}
            >
              <span className="text-fg">{c.id}</span>
              <FieldTable fields={c.fields} />
            </DiffLine>
          ))}
        </DiffGroup>
      )}

      {scenarioCount > 0 && (
        <DiffGroup title="Scenarios">
          {diff.scenarios.added.map((name) => (
            <DiffLine key={`a-${name}`} symbol="+" tone="text-ok">
              <span className="text-fg">{name}</span>
            </DiffLine>
          ))}
          {diff.scenarios.removed.map((name) => (
            <DiffLine key={`r-${name}`} symbol="−" tone="text-err">
              <span className="text-fg-muted">{name}</span>
            </DiffLine>
          ))}
          {diff.scenarios.changed.map((name) => (
            <DiffLine key={`c-${name}`} symbol="~" tone="text-warn">
              <span className="text-fg">{name}</span>
            </DiffLine>
          ))}
        </DiffGroup>
      )}
    </>
  );
}

function VersionDetail({
  projectId,
  version,
  head,
  onRestored,
}: {
  projectId: string;
  version: VersionMeta;
  head: number;
  onRestored: (error?: string) => void;
}) {
  const restoreVersion = useCloudStore((s) => s.restoreVersion);
  const isHead = version.version === head;
  // The head has nothing after it, and the first version nothing before it
  const [compare, setCompare] = useState<'previous' | 'current'>('previous');
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const mode = isHead ? 'previous' : compare;
  const from = mode === 'previous' ? version.version - 1 : version.version;
  const to = mode === 'previous' ? version.version : head;

  useEffect(() => {
    setDiff(null);
    setError(null);
    setConfirming(false);
    if (from < 1) return;
    let cancelled = false;
    getJson<{ diff: ProjectDiff }>(`/api/projects/${projectId}/diff?from=${from}&to=${to}`)
      .then((data) => !cancelled && setDiff(data.diff))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, from, to]);

  const restore = async () => {
    setRestoring(true);
    const res = await restoreVersion(version.version);
    if (!res.ok) {
      setRestoring(false);
      onRestored(res.error);
    }
  };

  return (
    <div className="max-w-[860px] px-8 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold tracking-tight text-fg">
            Version {version.version}
            {isHead && <span className="ml-2 text-xs font-normal text-fg-faint">current</span>}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            {versionSummary(version)} · {actorLabel(version.actor)} · {fullTime(version.created_at)}
          </p>
        </div>
        {!isHead &&
          (confirming ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-fg-muted">Make version {version.version} the design again?</span>
              <Button variant="primary" disabled={restoring} onClick={restore}>
                {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Restore
              </Button>
              <Button variant="ghost" disabled={restoring} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)} className="shrink-0">
              <RotateCcw className="w-3.5 h-3.5" />
              Restore this version
            </Button>
          ))}
      </div>
      {confirming && (
        <p className="mt-2 text-[12.5px] text-fg-faint text-right">
          Restoring saves a copy of this version as version {head + 1}. Nothing in between is lost.
        </p>
      )}

      {!isHead && version.version > 1 && (
        <Segmented
          value={compare}
          onChange={setCompare}
          className="mt-5 w-fit"
          options={[
            { value: 'previous', label: 'What this version changed' },
            { value: 'current', label: `Changed since, up to v${head}` },
          ]}
        />
      )}

      <div className="mt-5 bg-panel border border-line rounded-lg p-4">
        {from < 1 ? (
          <p className="text-xs text-fg-muted">The first saved version of this project.</p>
        ) : error ? (
          <p className="text-xs text-err">{error}</p>
        ) : !diff ? (
          <p className="text-xs text-fg-faint flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Comparing versions
          </p>
        ) : (
          <DiffBody diff={diff} />
        )}
      </div>
    </div>
  );
}

function RunDetailPane({
  projectId,
  run,
  envColor,
  onOpenVersion,
}: {
  projectId: string;
  run: RunMeta;
  envColor?: string;
  onOpenVersion: (version: number) => void;
}) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    let cancelled = false;
    getJson<{ run: RunDetail }>(`/api/projects/${projectId}/runs/${run.id}`)
      .then((data) => !cancelled && setDetail(data.run))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, run.id, run.status]);

  const status = runStatus(run.status);
  const changes = (detail?.planChanges || [])
    .map((c) => ({ address: c.address, action: classifyPlanActions(c.actions) }))
    .filter((c): c is { address: string; action: NonNullable<ReturnType<typeof classifyPlanActions>> } => !!c.action);

  return (
    <div className="px-8 py-6">
      <h2 className="text-[18px] font-semibold tracking-tight text-fg font-mono">{runTitle(run)}</h2>
      <p className="mt-1.5 text-xs text-fg-muted flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className={cn('w-1.5 h-1.5 rounded-full', status.dot)} />
          {status.label}
          {run.exit_code !== null && run.exit_code !== 0 && <span className="text-fg-faint">exit {run.exit_code}</span>}
        </span>
        <span className="text-fg-faint">·</span>
        <span className="flex items-center gap-1.5">
          {envColor && <EnvDot color={envColor} className="w-1.5 h-1.5" />}
          {envLabel(run.env)}
        </span>
        <span className="text-fg-faint">·</span>
        {duration(run)}
        <span className="text-fg-faint">·</span>
        {actorLabel(run.actor)}
        <span className="text-fg-faint">·</span>
        {fullTime(run.started_at)}
        {run.doc_version !== null && (
          <>
            <span className="text-fg-faint">·</span>
            <button
              type="button"
              onClick={() => onOpenVersion(run.doc_version!)}
              className="underline decoration-line-strong underline-offset-2 hover:text-fg"
            >
              design v{run.doc_version}
            </button>
          </>
        )}
      </p>

      {changes.length > 0 && (
        <div className="mt-5 bg-panel border border-line rounded-lg p-4">
          <h3 className="text-xs font-medium text-fg-muted mb-2">
            Planned changes
            {run.plan && (
              <span className="ml-2 font-mono font-normal text-fg-faint">
                +{run.plan.add} ~{run.plan.change} −{run.plan.destroy}
              </span>
            )}
          </h3>
          <div className="font-mono text-[12.5px] space-y-0.5 max-h-64 overflow-y-auto">
            {changes.map((c) => (
              <div key={c.address} className="flex gap-2.5">
                <span className={cn('w-3 text-center shrink-0', PLAN_ACTION_STYLE[c.action].text)}>
                  {PLAN_ACTION_STYLE[c.action].symbol}
                </span>
                <span className="text-fg-muted break-all">{c.address}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 rounded-lg border border-line bg-panel overflow-hidden">
        <div className="h-9 px-4 border-b border-line flex items-center text-xs text-fg-muted">Output</div>
        {error ? (
          <p className="p-4 text-xs text-err">{error}</p>
        ) : !detail ? (
          <p className="p-4 text-xs text-fg-faint flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading output
          </p>
        ) : (
          <pre className="p-4 font-mono text-[12.5px] leading-relaxed text-fg/90 whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">
            {detail.log?.trim() || (run.status === 'running' ? 'Still running. Output is saved when the run ends.' : 'No output was recorded.')}
          </pre>
        )}
      </div>
    </div>
  );
}

export function HistoryView() {
  const activeProject = useCloudStore((s) => s.activeProject);
  const projectVersion = useCloudStore((s) => s.projectVersion);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const environments = useCloudStore((s) => s.environments);
  const setView = useCloudStore((s) => s.setView);

  const [tab, setTab] = useState<Tab>('changes');
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = activeProject?.id;

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [v, r, e] = await Promise.all([
        getJson<{ versions: VersionMeta[] }>(`/api/projects/${projectId}/versions?limit=200`),
        getJson<{ runs: RunMeta[] }>(`/api/projects/${projectId}/runs?limit=100`),
        getJson<{ events: EventRow[] }>(`/api/projects/${projectId}/events?limit=200`),
      ]);
      setVersions(v.versions);
      setRuns(r.runs);
      setEvents(e.events);
    } catch (err: any) {
      setError(err?.message || 'History could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // New versions and finished runs show up without a manual refresh
  useEffect(() => {
    void load();
  }, [load, projectVersion, isRunningCommand]);

  const head = versions[0]?.version ?? projectVersion;
  const version = useMemo(
    () => versions.find((v) => v.version === selectedVersion) ?? versions[0],
    [versions, selectedVersion]
  );
  const run = useMemo(() => runs.find((r) => r.id === selectedRun) ?? runs[0], [runs, selectedRun]);
  const event = useMemo(() => events.find((e) => e.id === selectedEvent) ?? events[0], [events, selectedEvent]);

  if (!projectId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-base">
        <div className="text-center space-y-3">
          <p className="text-[14px] text-fg">No history yet</p>
          <p className="text-xs text-fg-muted">History is kept by the local backend. Start it with a database to see versions and runs.</p>
          <Button onClick={() => setView('design')}>Back to design</Button>
        </div>
      </main>
    );
  }

  const empty = (text: string) => <p className="px-4 py-8 text-center text-xs text-fg-muted">{text}</p>;

  return (
    <main className="flex-1 min-h-0 flex bg-base select-text">
      <aside className="w-[360px] shrink-0 h-full bg-panel border-r border-line flex flex-col">
        <div className="shrink-0 px-4 py-3 border-b border-line flex items-center gap-2">
          <Segmented
            value={tab}
            onChange={setTab}
            className="flex-1"
            options={[
              { value: 'changes', label: 'Changes' },
              { value: 'runs', label: 'Runs' },
              { value: 'activity', label: 'Activity' },
            ]}
          />
          <IconButton onClick={load} disabled={loading} title="Refresh">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </IconButton>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {error && <p className="px-4 py-3 text-xs text-err">{error}</p>}

          {tab === 'changes' &&
            (versions.length === 0
              ? !loading && empty('No versions saved yet.')
              : versions.map((v) => (
                  <ListRow key={v.version} selected={v.version === version?.version} onClick={() => setSelectedVersion(v.version)}>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-fg w-9 shrink-0">v{v.version}</span>
                      <span className="text-xs text-fg truncate flex-1">{versionSummary(v)}</span>
                      <span className="text-[12.5px] text-fg-faint shrink-0" title={fullTime(v.created_at)}>
                        {timeAgo(v.created_at)}
                      </span>
                    </div>
                    <div className="pl-11 mt-0.5 text-[12.5px] text-fg-faint">
                      {actorLabel(v.actor)}
                      {v.version === head && ' · current'}
                    </div>
                  </ListRow>
                )))}

          {tab === 'runs' &&
            (runs.length === 0
              ? !loading && empty('Nothing has been run yet.')
              : runs.map((r) => {
                  const status = runStatus(r.status);
                  return (
                    <ListRow key={r.id} selected={r.id === run?.id} onClick={() => setSelectedRun(r.id)}>
                      <div className="flex items-baseline gap-2">
                        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0 self-center', status.dot)} title={status.label} />
                        <span className="font-mono text-xs text-fg truncate flex-1">{runTitle(r)}</span>
                        <span className="text-[12.5px] text-fg-faint shrink-0" title={fullTime(r.started_at)}>
                          {timeAgo(r.started_at)}
                        </span>
                      </div>
                      <div className="pl-3.5 mt-0.5 text-[12.5px] text-fg-faint flex items-center gap-1.5">
                        {environments[r.env] && <EnvDot color={environments[r.env].color} className="w-1.5 h-1.5" />}
                        {envLabel(r.env)} · {actorLabel(r.actor)}
                        {r.plan && (
                          <span className="ml-auto font-mono">
                            +{r.plan.add} ~{r.plan.change} −{r.plan.destroy}
                          </span>
                        )}
                      </div>
                    </ListRow>
                  );
                }))}

          {tab === 'activity' &&
            (events.length === 0
              ? !loading && empty('No activity recorded yet.')
              : events.map((e) => (
                  <ListRow key={e.id} selected={e.id === event?.id} onClick={() => setSelectedEvent(e.id)}>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-fg truncate flex-1">{e.action}</span>
                      <span className="text-[12.5px] text-fg-faint shrink-0" title={fullTime(e.created_at)}>
                        {timeAgo(e.created_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-fg-faint">
                      {actorLabel(e.actor)}
                      {e.doc_version !== null && ` · v${e.doc_version}`}
                    </div>
                  </ListRow>
                )))}
        </div>
      </aside>

      <section className="flex-1 min-w-0 h-full overflow-y-auto">
        {tab === 'changes' && version && (
          <VersionDetail
            key={version.version}
            projectId={projectId}
            version={version}
            head={head}
            onRestored={(err) => err && setError(err)}
          />
        )}
        {tab === 'runs' && run && (
          <RunDetailPane
            key={run.id}
            projectId={projectId}
            run={run}
            envColor={environments[run.env]?.color}
            onOpenVersion={(v) => {
              setSelectedVersion(v);
              setTab('changes');
            }}
          />
        )}
        {tab === 'activity' && event && (
          <div className="max-w-[860px] px-8 py-6">
            <h2 className="text-[18px] font-semibold tracking-tight text-fg font-mono">{event.action}</h2>
            <p className="mt-1 text-xs text-fg-muted">
              {actorLabel(event.actor)} · {fullTime(event.created_at)}
              {event.doc_version !== null && ` · design v${event.doc_version}`}
            </p>
            <pre className="mt-5 bg-panel border border-line rounded-lg p-4 font-mono text-[12.5px] leading-relaxed text-fg/90 whitespace-pre-wrap break-words">
              {event.payload === null ? 'No details recorded.' : JSON.stringify(event.payload, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </main>
  );
}
