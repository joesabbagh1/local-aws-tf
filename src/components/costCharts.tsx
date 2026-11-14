import { useState, type FocusEvent, type ReactNode } from 'react';
import type { CostDriver } from '../types/cloud';
import { COST_DRIVERS, DRIVER_LABELS } from '../utils/costEstimator';
import { cn } from './ui';

/**
 * Driver colours, stacked in COST_DRIVERS order. Validated as a categorical set on the panel
 * surface (#16181A): every adjacent pair clears CVD ΔE 8 and normal-vision ΔE 15, all >= 3:1.
 */
export const DRIVER_COLORS: Record<CostDriver, string> = {
  compute: '#3987e5',
  storage: '#d95926',
  requests: '#199e70',
  transfer: '#c98500',
  fees: '#d55181',
};

/** $0.42, $18, $1,284 */
export function usd(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) < 10) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** $0, $250, $1.5K, $12K: for axes and tight spots. */
export function usdCompact(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 || n >= 10_000 ? 0 : 1)}K`;
  return usd(n);
}

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten so axis ticks land on clean numbers. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= n) ?? 10;
  return step * pow;
}

export function DriverLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {COST_DRIVERS.map((k) => (
        <span key={k} className="flex items-center gap-1.5 text-[12.5px] text-fg-muted">
          <span className="w-2.5 h-2.5 rounded-[2px]" style={{ backgroundColor: DRIVER_COLORS[k] }} />
          {DRIVER_LABELS[k]}
        </span>
      ))}
    </div>
  );
}

interface TooltipState {
  x: number;
  y: number;
  title: ReactNode;
  drivers: Record<CostDriver, number>;
  highlight?: CostDriver;
}

function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  return { tip, show: setTip, hide: () => setTip(null) };
}

/** Breakdown of one bar or column. Values lead, driver names follow, keyed by a short line. */
function DriverTooltip({ tip }: { tip: TooltipState }) {
  const total = COST_DRIVERS.reduce((sum, k) => sum + tip.drivers[k], 0);
  const left = Math.min(tip.x + 14, window.innerWidth - 230);
  const top = Math.min(tip.y + 14, window.innerHeight - 190);
  return (
    <div
      role="tooltip"
      className="fixed z-50 w-[210px] pointer-events-none rounded-md border border-line-strong bg-raised px-3 py-2.5"
      style={{ left, top }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-xs text-fg-muted truncate">{tip.title}</span>
        <span className="text-xs font-semibold text-fg tabular-nums">{usd(total)}</span>
      </div>
      <div className="space-y-1">
        {COST_DRIVERS.filter((k) => tip.drivers[k] > 0).map((k) => (
          <div key={k} className={cn('flex items-center gap-2 text-xs', tip.highlight && tip.highlight !== k && 'opacity-60')}>
            <span className="w-2.5 h-[2px] rounded-full shrink-0" style={{ backgroundColor: DRIVER_COLORS[k] }} />
            <span className="font-medium text-fg tabular-nums">{usd(tip.drivers[k])}</span>
            <span className="text-fg-muted">{DRIVER_LABELS[k]}</span>
          </div>
        ))}
        {total === 0 && <span className="text-xs text-fg-faint">No charge</span>}
      </div>
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  tooltipTitle: string;
  drivers: Record<CostDriver, number>;
  total: number;
  active?: boolean;
  onClick?: () => void;
}

/** Horizontal bars stacked by cost driver, one per row, sharing one scale. */
export function StackedBarList({ rows, labelWidth = 120 }: { rows: BarRow[]; labelWidth?: number }) {
  const { tip, show, hide } = useTooltip();
  const max = Math.max(0.01, ...rows.map((r) => r.total));

  return (
    <div className="space-y-1" onPointerLeave={hide}>
      {rows.map((row) => {
        const segments = COST_DRIVERS.filter((k) => row.drivers[k] > 0);
        const Wrapper = row.onClick ? 'button' : 'div';
        return (
          <Wrapper
            key={row.key}
            type={row.onClick ? 'button' : undefined}
            onClick={row.onClick}
            onFocus={(e: FocusEvent<HTMLElement>) => {
              const r = e.currentTarget.getBoundingClientRect();
              show({ x: r.right - 220, y: r.bottom, title: row.tooltipTitle, drivers: row.drivers });
            }}
            onBlur={hide}
            className={cn(
              'w-full grid items-center gap-3 h-8 px-2 -mx-2 rounded-md text-left',
              row.onClick && 'hover:bg-raised transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent'
            )}
            style={{ gridTemplateColumns: `${labelWidth}px 1fr 64px` }}
          >
            <span className={cn('text-xs truncate', row.active === false ? 'text-fg-muted' : 'text-fg')}>{row.label}</span>
            <span className="flex h-2.5 gap-[2px]" style={{ width: `${(row.total / max) * 100}%` }}>
              {segments.map((k, i) => (
                <span
                  key={k}
                  className={cn('h-full', i === segments.length - 1 && 'rounded-r-[4px]', 'hover:brightness-125')}
                  style={{ flexGrow: row.drivers[k], flexBasis: 0, minWidth: 2, backgroundColor: DRIVER_COLORS[k] }}
                  onPointerMove={(e) =>
                    show({ x: e.clientX, y: e.clientY, title: row.tooltipTitle, drivers: row.drivers, highlight: k })
                  }
                />
              ))}
            </span>
            <span className="text-xs text-right tabular-nums text-fg">{usd(row.total)}</span>
          </Wrapper>
        );
      })}
      {tip && <DriverTooltip tip={tip} />}
    </div>
  );
}

/** Columns stacked by cost driver over time. The whole slot is the hover target, not just the painted column. */
export function StackedColumns({
  columns,
  height = 200,
}: {
  columns: { label: string; title: string; drivers: Record<CostDriver, number> }[];
  height?: number;
}) {
  const { tip, show, hide } = useTooltip();
  const totals = columns.map((c) => COST_DRIVERS.reduce((sum, k) => sum + c.drivers[k], 0));
  const max = niceCeil(Math.max(...totals, 0.01));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const lastIndex = columns.length - 1;

  return (
    <div className="flex gap-3" onPointerLeave={hide}>
      {/* Y axis */}
      <div className="relative w-11 shrink-0" style={{ height }}>
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute right-0 text-[12.5px] text-fg-faint tabular-nums"
            style={{ bottom: `${(t / max) * 100}%`, transform: 'translateY(50%)' }}
          >
            {usdCompact(t)}
          </span>
        ))}
      </div>

      <div className="flex-1 min-w-0">
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <span
              key={t}
              className={cn('absolute left-0 right-0 h-px', t === 0 ? 'bg-line-strong' : 'bg-line/60')}
              style={{ bottom: `${(t / max) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex">
            {columns.map((col, i) => {
              const segments = COST_DRIVERS.filter((k) => col.drivers[k] > 0);
              return (
                <div
                  key={col.label + i}
                  tabIndex={0}
                  aria-label={`${col.title}: ${usd(totals[i])}`}
                  className="group relative flex-1 flex flex-col justify-end items-center outline-none"
                  onPointerMove={(e) => show({ x: e.clientX, y: e.clientY, title: col.title, drivers: col.drivers })}
                  onFocus={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left, y: r.top + 20, title: col.title, drivers: col.drivers });
                  }}
                  onBlur={hide}
                >
                  <span className="absolute inset-y-0 inset-x-0.5 rounded-sm group-hover:bg-fg/[0.04] group-focus-visible:bg-fg/[0.06]" />
                  {i === lastIndex && (
                    <span className="relative mb-1 text-[12.5px] text-fg tabular-nums whitespace-nowrap">
                      {usdCompact(totals[i])}
                    </span>
                  )}
                  <div
                    className="relative w-full max-w-[24px] flex flex-col-reverse gap-[2px]"
                    style={{ height: `${(totals[i] / max) * 100}%` }}
                  >
                    {segments.map((k, si) => (
                      <span
                        key={k}
                        className={cn('w-full', si === segments.length - 1 && 'rounded-t-[4px]')}
                        style={{ flexGrow: col.drivers[k], flexBasis: 0, minHeight: 2, backgroundColor: DRIVER_COLORS[k] }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {/* X axis */}
        <div className="flex mt-2">
          {columns.map((col, i) => (
            <span key={col.label + i} className="flex-1 text-center text-[12.5px] text-fg-faint">
              {col.label}
            </span>
          ))}
        </div>
      </div>
      {tip && <DriverTooltip tip={tip} />}
    </div>
  );
}
