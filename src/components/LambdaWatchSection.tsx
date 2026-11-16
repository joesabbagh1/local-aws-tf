import { useCallback, useEffect, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { Section, Switch, cn } from './ui';

/** Mirrors server/services/lambdaWatch.ts. */
interface WatchUpdate {
  nodeId: string;
  label: string;
  functionName: string;
  at: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

interface WatchStatus {
  envId: string;
  port: number;
  since: string;
  updates: WatchUpdate[];
}

const POLL_MS = 2000;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Lambda watch mode for the active environment: while on, the backend pushes a function's code to
 * the emulator a second after it changes (code folder or inline code), without a plan.
 */
export function LambdaWatchSection() {
  const activeProject = useCloudStore((s) => s.activeProject);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const envName = useCloudStore((s) => s.environments[s.activeEnv]?.name ?? s.activeEnv);
  const lambdaCount = useCloudStore(
    (s) => s.nodes.filter((n) => n.data.serviceType === 'aws_lambda_function' && n.data.envEnabled?.[s.activeEnv] !== false).length
  );
  const [watches, setWatches] = useState<WatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const projectId = activeProject?.id;
  const watch = watches.find((w) => w.envId === activeEnv);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/lambda-watch`);
      const data = await res.json();
      if (data.ok) setWatches(data.watches);
    } catch {
      // The next poll tries again
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is watched: the updates come from the backend
  const watching = watches.length > 0;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [watching, load]);

  const toggle = async (enabled: boolean) => {
    if (!projectId) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/lambda-watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envId: activeEnv, enabled }),
      });
      const data = await res.json();
      if (data.ok) setWatches(data.watches);
      else setError(data.error || `HTTP ${res.status}`);
    } catch (err: any) {
      setError(err?.message || 'The backend did not answer');
    } finally {
      setPending(false);
    }
  };

  if (!projectId || lambdaCount === 0) return null;

  return (
    <Section
      title="Lambda code"
      aside={
        <div className={cn('flex items-center gap-2 text-xs text-fg-muted', pending && 'opacity-60 pointer-events-none')}>
          Watch
          <Switch checked={!!watch} onChange={(next) => void toggle(next)} title={`Watch Lambda code in ${envName}`} />
        </div>
      }
    >
      <p className="text-[12.5px] text-fg-faint">
        Updates a function on the {envName} emulator a second after its code changes, without a plan. A new runtime,
        handler or other setting still needs Apply.
      </p>
      {error && <p className="text-[12.5px] text-warn mt-2">{error}</p>}
      {watch && (
        <div className="mt-3">
          {watch.updates.length === 0 ? (
            <p className="text-xs text-fg-muted">
              Watching {lambdaCount} function{lambdaCount === 1 ? '' : 's'} since {timeOf(watch.since)}. Nothing changed yet.
            </p>
          ) : (
            <div className="divide-y divide-line">
              {watch.updates.map((u) => (
                <div key={`${u.nodeId}-${u.at}`} className="h-8 flex items-center gap-2.5 text-xs min-w-0" title={u.error || u.functionName}>
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', u.ok ? 'bg-ok' : 'bg-warn')} />
                  <span className="text-fg shrink-0">{u.label}</span>
                  <span className={cn('truncate', u.ok ? 'text-fg-faint' : 'text-warn')}>
                    {u.ok ? `updated in ${u.durationMs} ms` : u.error}
                  </span>
                  <span className="ml-auto font-mono text-[12.5px] text-fg-faint shrink-0">{timeOf(u.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
