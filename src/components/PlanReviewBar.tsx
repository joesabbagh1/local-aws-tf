import { useCloudStore } from '../store/useCloudStore';
import { planHasChanges, type PlanAction } from '../utils/planSummary';
import { Loader2 } from 'lucide-react';
import { Button, cn } from './ui';

export const PLAN_ACTION_STYLE: Record<PlanAction, { symbol: string; label: string; text: string; border: string }> = {
  create: { symbol: '+', label: 'create', text: 'text-ok', border: 'border-ok/60' },
  update: { symbol: '~', label: 'change', text: 'text-warn', border: 'border-warn/60' },
  replace: { symbol: '±', label: 'replace', text: 'text-err', border: 'border-err/60' },
  delete: { symbol: '−', label: 'destroy', text: 'text-err', border: 'border-err/60' },
};

const MAX_OTHER_SHOWN = 5;

/** Floats over the canvas after a plan: what will change, with the only button that applies it. */
export function PlanReviewBar() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const plan = useCloudStore((s) => (s.pendingPlan?.envId === s.activeEnv ? s.pendingPlan : null));
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const runningCommand = useCloudStore((s) => s.runningCommand);
  const applyReviewedPlan = useCloudStore((s) => s.applyReviewedPlan);
  const discardPlan = useCloudStore((s) => s.discardPlan);

  if (!plan) return null;

  const hasChanges = planHasChanges(plan);
  const { add, change, destroy } = plan.counts;
  const isDestroy = plan.mode === 'destroy';

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-[calc(100%-24px)] rounded-lg bg-raised border border-line-strong shadow-xl shadow-black/40">
      <div className="h-11 pl-4 pr-2 flex items-center gap-4">
        {hasChanges ? (
          <>
            <span className="text-[14px] text-fg whitespace-nowrap">
              {isDestroy ? `Destroy ${activeEnv}` : `Plan for ${activeEnv}`}
            </span>
            <span className="flex items-center gap-3 font-mono text-xs whitespace-nowrap">
              <span className={add ? 'text-ok' : 'text-fg-faint'}>+{add} add</span>
              <span className={change ? 'text-warn' : 'text-fg-faint'}>~{change} change</span>
              <span className={destroy ? 'text-err' : 'text-fg-faint'}>−{destroy} destroy</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Button variant="ghost" disabled={isRunningCommand} onClick={discardPlan}>
                Discard
              </Button>
              <Button
                variant="primary"
                disabled={isRunningCommand}
                onClick={applyReviewedPlan}
                className={cn(isDestroy && 'bg-err text-base hover:bg-err/85')}
              >
                {runningCommand === 'apply' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isDestroy ? `Destroy ${destroy} resource${destroy === 1 ? '' : 's'}` : 'Apply'}
              </Button>
            </span>
          </>
        ) : (
          <>
            <span className="text-[14px] text-fg-muted whitespace-nowrap">
              {isDestroy ? (
                <>
                  Nothing to destroy in <span className="text-fg">{activeEnv}</span>.
                </>
              ) : (
                <>
                  No changes. <span className="text-fg">{activeEnv}</span> already matches the canvas.
                </>
              )}
            </span>
            <Button variant="ghost" onClick={discardPlan}>
              Dismiss
            </Button>
          </>
        )}
      </div>

      {plan.other.length > 0 && (
        <div className="px-4 py-2.5 border-t border-line">
          <div className="text-[12.5px] text-fg-faint mb-1.5">Not on the canvas</div>
          <ul className="space-y-0.5 font-mono text-[12.5px]">
            {plan.other.slice(0, MAX_OTHER_SHOWN).map((c) => (
              <li key={c.address} className="flex gap-2">
                <span className={cn('w-2 text-center', PLAN_ACTION_STYLE[c.action].text)}>
                  {PLAN_ACTION_STYLE[c.action].symbol}
                </span>
                <span className="text-fg-muted truncate">{c.address}</span>
              </li>
            ))}
            {plan.other.length > MAX_OTHER_SHOWN && (
              <li className="text-fg-faint pl-4">and {plan.other.length - MAX_OTHER_SHOWN} more, listed in the Run tab</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
