import { useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { estimateArchitectureCosts, runArchitectureLinter } from '../utils/architectureValidator';
import type { EnvironmentId, LintFinding } from '../types/cloud';
import { AlertOctagon, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

const SEVERITY_STYLE: Record<LintFinding['severity'], { icon: typeof Info; cls: string }> = {
  error: { icon: AlertOctagon, cls: 'text-rose-400 bg-rose-500/5 border-rose-500/30' },
  warning: { icon: AlertTriangle, cls: 'text-amber-300 bg-amber-500/5 border-amber-500/30' },
  info: { icon: Info, cls: 'text-sky-300 bg-sky-500/5 border-sky-500/25' },
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

  const [severityFilter, setSeverityFilter] = useState<'all' | LintFinding['severity']>('all');

  const findings = useMemo(() => runArchitectureLinter(nodes, edges, activeEnv), [nodes, edges, activeEnv]);
  const costs = useMemo(() => estimateArchitectureCosts(nodes), [nodes]);

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
    <div className="p-4 space-y-5">
      {/* Cost by environment */}
      <section className="space-y-2.5">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Estimated monthly cost on AWS
          </h3>
          <span className="text-[10px] text-slate-500">on-demand, us-east-1 list prices</span>
        </div>
        <div className="space-y-1.5">
          {ENV_IDS.map((id) => {
            const env = environments[id];
            const total = costs.totalsByEnv[id];
            return (
              <div key={id} className="flex items-center gap-2.5">
                <span className={`w-14 text-[11px] font-semibold ${id === activeEnv ? 'text-white' : 'text-slate-400'}`}>
                  {env.shortLabel}
                </span>
                <div className="flex-1 h-2 rounded-full bg-slate-800/80 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${(total / maxTotal) * 100}%`, backgroundColor: env.color }}
                  />
                </div>
                <span className="w-16 text-right text-[11px] font-mono text-slate-200">{usd(total)}</span>
              </div>
            );
          })}
        </div>

        {topItems.length > 0 && (
          <div className="rounded-xl border border-slate-800 bg-[#141824] divide-y divide-slate-800/80">
            {topItems.map((item) => (
              <button
                key={item.nodeId}
                type="button"
                onClick={() => {
                  selectNode(item.nodeId);
                  setRightTab('inspector');
                }}
                className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-[#1a2030]"
              >
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-200 truncate">{item.label}</div>
                  <div className="text-[10px] text-slate-500 truncate">{item.sizingNotes[activeEnv]}</div>
                </div>
                <span className="text-[11px] font-mono text-slate-200 shrink-0">
                  {usd(item.monthlyUsd[activeEnv])}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Lint findings */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Architecture checks · {activeEnv}
          </h3>
          <div className="flex items-center gap-1">
            {(['all', 'error', 'warning', 'info'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                onClick={() => setSeverityFilter(sev)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  severityFilter === sev ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {sev === 'all' ? `All ${findings.length}` : `${sev} ${counts[sev]}`}
              </button>
            ))}
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="p-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 text-[11px] text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> No findings for {activeEnv}.
          </div>
        ) : (
          <div className="space-y-2">
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
                  className={`w-full text-left p-3 rounded-xl border ${cls} enabled:hover:brightness-125`}
                >
                  <div className="flex items-start gap-2">
                    <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-semibold text-slate-100">{f.title}</span>
                        <span className="text-[9px] font-mono px-1 rounded bg-slate-900/70 text-slate-400">
                          {f.category}
                        </span>
                      </div>
                      <p className="text-[10.5px] text-slate-300 leading-relaxed">{f.description}</p>
                      {f.remediation && (
                        <p className="text-[10.5px] text-slate-400 leading-relaxed">
                          <span className="text-slate-300">Fix:</span> {f.remediation}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
