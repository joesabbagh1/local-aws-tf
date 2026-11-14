import { useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { runArchitectureLinter } from '../utils/architectureValidator';
import { estimateArchitectureCosts } from '../utils/costEstimator';
import type { EnvironmentId, LintFinding } from '../types/cloud';
import { AlertOctagon, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { Button, EnvDot, Section, Segmented, cn } from './ui';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

const SEVERITY_STYLE: Record<LintFinding['severity'], { icon: typeof Info; cls: string }> = {
  error: { icon: AlertOctagon, cls: 'text-err' },
  warning: { icon: AlertTriangle, cls: 'text-warn' },
  info: { icon: Info, cls: 'text-info' },
};

const usd = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n < 10 ? 2 : 0)}`;

export function ArchitectureAuditPanel() {
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const selectNode = useCloudStore((s) => s.selectNode);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  const setView = useCloudStore((s) => s.setView);

  const [severityFilter, setSeverityFilter] = useState<'all' | LintFinding['severity']>('all');

  const findings = useMemo(() => runArchitectureLinter(nodes, edges, activeEnv), [nodes, edges, activeEnv]);
  const costs = useMemo(() => estimateArchitectureCosts(nodes, environments), [nodes, environments]);

  const counts = {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const visible = severityFilter === 'all' ? findings : findings.filter((f) => f.severity === severityFilter);
  const maxTotal = Math.max(1, ...ENV_IDS.map((id) => costs.totalsByEnv[id]));
  const topItems = [...costs.items]
    .sort((a, b) => b.monthlyUsd[activeEnv] - a.monthlyUsd[activeEnv])
    .filter((i) => i.monthlyUsd[activeEnv] > 0)
    .slice(0, 8);

  return (
    <>
      {/* Cost by environment */}
      <Section
        title="Estimated monthly cost"
        aside={
          <Button variant="ghost" className="-mr-2" onClick={() => setView('costs')}>
            Open cost analysis
          </Button>
        }
      >
        <div className="space-y-2">
          {ENV_IDS.map((id) => {
            const env = environments[id];
            const total = costs.totalsByEnv[id];
            return (
              <div key={id} className="flex items-center gap-3">
                <span className={cn('w-20 text-xs flex items-center gap-2', id === activeEnv ? 'text-fg' : 'text-fg-muted')}>
                  <EnvDot color={env.color} className="w-1.5 h-1.5" />
                  {env.shortLabel.toLowerCase()}
                </span>
                <div className="flex-1 h-1 rounded-full bg-overlay overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${(total / maxTotal) * 100}%`, backgroundColor: env.color }}
                  />
                </div>
                <span className="w-14 text-right text-xs font-mono text-fg tabular-nums">{usd(total)}</span>
              </div>
            );
          })}
        </div>

        {topItems.length > 0 && (
          <div className="mt-4 -mx-2">
            {topItems.map((item) => (
              <button
                key={item.nodeId}
                type="button"
                onClick={() => {
                  selectNode(item.nodeId);
                  setRightTab('inspector');
                }}
                className="w-full px-2 py-1.5 rounded-md flex items-center justify-between gap-3 text-left hover:bg-raised transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-xs text-fg truncate">{item.label}</div>
                  <div className="text-[12.5px] text-fg-faint truncate">{item.sizingNotes[activeEnv]}</div>
                </div>
                <span className="text-xs font-mono text-fg-muted shrink-0 tabular-nums">
                  {usd(item.monthlyUsd[activeEnv])}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* Lint findings */}
      <Section title={`Checks · ${activeEnv}`}>
        <Segmented
          value={severityFilter}
          onChange={setSeverityFilter}
          className="mb-3"
          options={(['all', 'error', 'warning', 'info'] as const).map((sev) => ({
            value: sev,
            label: (
              <>
                {sev === 'all' ? 'All' : sev === 'error' ? 'Errors' : sev === 'warning' ? 'Warnings' : 'Info'}
                <span className="text-fg-faint tabular-nums">{sev === 'all' ? findings.length : counts[sev]}</span>
              </>
            ),
          }))}
        />

        {visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-muted flex items-center justify-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-ok" /> Nothing to flag in {activeEnv}.
          </p>
        ) : (
          <div className="-mx-2">
            {visible.map((f) => {
              const { icon: Icon, cls } = SEVERITY_STYLE[f.severity];
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={!f.nodeId}
                  onClick={() => {
                    if (!f.nodeId) return;
                    selectNode(f.nodeId);
                    setRightTab('inspector');
                  }}
                  className="w-full text-left px-2 py-2.5 rounded-md enabled:hover:bg-raised transition-colors flex items-start gap-2.5"
                >
                  <Icon className={cn('w-3.5 h-3.5 shrink-0 mt-px', cls)} />
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-fg">{f.title}</span>
                      <span className="text-[12.5px] text-fg-faint">{f.category}</span>
                    </div>
                    <p className="text-xs text-fg-muted leading-relaxed">{f.description}</p>
                    {f.remediation && (
                      <p className="text-xs text-fg-faint leading-relaxed">{f.remediation}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
