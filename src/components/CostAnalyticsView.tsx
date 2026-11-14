import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, CheckCircle2, Download, RotateCcw } from 'lucide-react';
import { useCloudStore } from '../store/useCloudStore';
import { DEFAULT_ENVIRONMENTS, SERVICE_BY_TYPE } from '../data/awsCatalog';
import type { AwsCategory, CostDriver, EnvironmentId, UsageProfile } from '../types/cloud';
import {
  COST_DRIVERS,
  ENV_IDS,
  costEstimateCsv,
  estimateArchitectureCosts,
  findCostSavings,
  projectMonthlyCost,
  usageFor,
} from '../utils/costEstimator';
import { DriverLegend, StackedBarList, StackedColumns, usd, type BarRow } from './costCharts';
import { Button, EnvDot, Segmented, ServiceGlyph, Switch, cn, fieldCls } from './ui';

const envLabel = (id: EnvironmentId) => (id === 'testing' ? 'test' : id);

const GROWTH_OPTIONS = [
  { value: '0', label: 'Flat' },
  { value: '0.05', label: '+5%' },
  { value: '0.1', label: '+10%' },
  { value: '0.2', label: '+20%' },
];

const USAGE_FIELDS: { key: keyof UsageProfile; label: string; unit: string; step: number }[] = [
  { key: 'requestsMillions', label: 'Requests', unit: 'M / mo', step: 0.1 },
  { key: 'dataTransferGb', label: 'Data out to internet', unit: 'GB / mo', step: 10 },
  { key: 'storageGb', label: 'Data per storage service', unit: 'GB', step: 10 },
  { key: 'logsGb', label: 'Logs ingested', unit: 'GB / mo', step: 5 },
];

function Card({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('bg-panel border border-line rounded-lg min-w-0', className)}>
      {(title || aside) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 min-h-[42px]">
          <h2 className="text-[14px] font-medium text-fg">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

function StatTile({ label, value, sub, hero }: { label: ReactNode; value: string; sub?: ReactNode; hero?: boolean }) {
  return (
    <div className={cn('bg-panel border border-line rounded-lg px-4 py-3.5 flex flex-col min-w-0', hero && 'col-span-2')}>
      <span className="text-xs text-fg-muted flex items-center gap-2">{label}</span>
      <span
        className={cn(
          'mt-auto pt-3 font-semibold tracking-tight text-fg truncate',
          hero ? 'text-[48px] leading-none' : 'text-[26px] leading-tight'
        )}
      >
        {value}
      </span>
      {sub && <span className="mt-1.5 text-xs text-fg-faint truncate">{sub}</span>}
    </div>
  );
}

export function CostAnalyticsView() {
  const nodes = useCloudStore((s) => s.nodes);
  const environments = useCloudStore((s) => s.environments);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const setActiveEnv = useCloudStore((s) => s.setActiveEnv);
  const setView = useCloudStore((s) => s.setView);
  const selectNode = useCloudStore((s) => s.selectNode);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  const updateEnvironmentProfile = useCloudStore((s) => s.updateEnvironmentProfile);

  const [growth, setGrowth] = useState('0.05');
  const [sortEnv, setSortEnv] = useState<EnvironmentId | null>(null);
  const [showFree, setShowFree] = useState(false);
  const [showAllSavings, setShowAllSavings] = useState(false);

  const estimate = useMemo(() => estimateArchitectureCosts(nodes, environments), [nodes, environments]);
  const savings = useMemo(() => findCostSavings(nodes, estimate), [nodes, estimate]);

  const env = environments[activeEnv];
  const total = estimate.totalsByEnv[activeEnv];
  const allEnvTotal = ENV_IDS.reduce((sum, id) => sum + estimate.totalsByEnv[id], 0);
  const savingsTotal = savings.reduce((sum, s) => sum + s.monthlyUsd, 0);
  const largest = [...estimate.items].sort((a, b) => b.monthlyUsd[activeEnv] - a.monthlyUsd[activeEnv])[0];
  const pricedCount = estimate.items.filter((i) => i.monthlyUsd[activeEnv] > 0).length;

  const openInCanvas = (nodeId: string, envId?: EnvironmentId) => {
    if (envId) setActiveEnv(envId);
    selectNode(nodeId);
    setRightTab('inspector');
    setView('design');
  };

  const envRows: BarRow[] = ENV_IDS.map((id) => ({
    key: id,
    label: (
      <span className="flex items-center gap-2">
        <EnvDot color={environments[id].color} />
        {environments[id].name}
      </span>
    ),
    tooltipTitle: environments[id].name,
    drivers: estimate.driversByEnv[id],
    total: estimate.totalsByEnv[id],
    active: id === activeEnv,
    onClick: () => setActiveEnv(id),
  }));

  const categoryRows: BarRow[] = useMemo(() => {
    const byCategory = new Map<AwsCategory, Record<CostDriver, number>>();
    for (const item of estimate.items) {
      if (item.monthlyUsd[activeEnv] <= 0) continue;
      const acc = byCategory.get(item.category) ?? { compute: 0, storage: 0, requests: 0, transfer: 0, fees: 0 };
      for (const k of COST_DRIVERS) acc[k] += item.drivers[activeEnv][k];
      byCategory.set(item.category, acc);
    }
    return [...byCategory.entries()]
      .map(([category, drivers]) => ({
        key: category,
        label: category,
        tooltipTitle: category,
        drivers,
        total: COST_DRIVERS.reduce((sum, k) => sum + drivers[k], 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [estimate, activeEnv]);

  const projection = useMemo(() => {
    const start = new Date();
    return projectMonthlyCost(estimate.driversByEnv[activeEnv], Number(growth)).map((drivers, i) => {
      const month = new Date(start.getFullYear(), start.getMonth() + i, 1);
      return {
        label: month.toLocaleString('en-US', { month: 'short' }),
        title: month.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        drivers,
      };
    });
  }, [estimate, activeEnv, growth]);
  const projectionTotal = projection.reduce(
    (sum, m) => sum + COST_DRIVERS.reduce((s, k) => s + m.drivers[k], 0),
    0
  );

  const sortBy = sortEnv ?? activeEnv;
  const tableItems = estimate.items
    .filter((i) => showFree || ENV_IDS.some((id) => i.monthlyUsd[id] > 0))
    .sort((a, b) => b.monthlyUsd[sortBy] - a.monthlyUsd[sortBy] || a.label.localeCompare(b.label));
  const visibleSavings = showAllSavings ? savings : savings.slice(0, 3);

  const exportCsv = () => {
    const blob = new Blob([costEstimateCsv(estimate)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'localcloud-cost-estimate.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const setUsage = (envId: EnvironmentId, key: keyof UsageProfile, raw: string) => {
    const value = Math.max(0, Number(raw) || 0);
    updateEnvironmentProfile(envId, { usage: { ...usageFor(environments[envId], envId), [key]: value } });
  };
  const usageIsDefault = ENV_IDS.every((id) =>
    USAGE_FIELDS.every(({ key }) => usageFor(environments[id], id)[key] === DEFAULT_ENVIRONMENTS[id].usage[key])
  );

  if (nodes.length === 0) {
    return (
      <main className="flex-1 flex items-center justify-center bg-base">
        <div className="text-center space-y-3">
          <p className="text-[14px] text-fg">Nothing to price yet</p>
          <p className="text-xs text-fg-muted">Add services on the canvas and their cost shows up here.</p>
          <Button onClick={() => setView('design')}>Back to design</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 min-h-0 overflow-y-auto bg-base select-text">
      <div className="max-w-[1320px] mx-auto px-6 py-6 space-y-4">
        {/* Page header */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-fg">Cost analysis</h1>
            <p className="mt-1 text-xs text-fg-muted">
              Estimated monthly spend at on-demand us-east-1 list prices, sized from the usage assumptions at the bottom
              of this page.
            </p>
          </div>
          <Button onClick={exportCsv}>
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </Button>
        </div>

        {/* Headline numbers */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatTile
            hero
            label={
              <>
                <EnvDot color={env.color} />
                {env.name} per month
              </>
            }
            value={usd(total)}
            sub={`${usd(total * 12)} per year · ${pricedCount} billable resource${pricedCount === 1 ? '' : 's'}`}
          />
          <StatTile
            label="All environments per month"
            value={usd(allEnvTotal)}
            sub={`${usd(allEnvTotal * 12)} per year · prod is ${
              allEnvTotal > 0 ? Math.round((estimate.totalsByEnv.prod / allEnvTotal) * 100) : 0
            }%`}
          />
          <StatTile
            label="Largest line item"
            value={largest && largest.monthlyUsd[activeEnv] > 0 ? usd(largest.monthlyUsd[activeEnv]) : '$0'}
            sub={largest && largest.monthlyUsd[activeEnv] > 0 ? largest.label : 'Nothing billable'}
          />
          <StatTile
            label="Possible savings per month"
            value={usd(savingsTotal)}
            sub={`${savings.length} suggestion${savings.length === 1 ? '' : 's'} across environments`}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <Card title="Monthly cost by environment" aside={<DriverLegend />} className="xl:col-span-7">
            <StackedBarList rows={envRows} labelWidth={130} />
          </Card>

          <Card title={`By service category · ${env.name}`} className="xl:col-span-5">
            {categoryRows.length === 0 ? (
              <p className="py-8 text-center text-xs text-fg-muted">Nothing billable in {env.name}.</p>
            ) : (
              <StackedBarList rows={categoryRows} labelWidth={170} />
            )}
          </Card>

          <Card
            title={`12-month projection · ${env.name}`}
            aside={
              <div className="flex items-center gap-2">
                <span className="text-xs text-fg-faint">Usage growth per month</span>
                <Segmented value={growth} onChange={setGrowth} options={GROWTH_OPTIONS} />
              </div>
            }
            className="xl:col-span-7"
          >
            <StackedColumns columns={projection} />
            <div className="mt-4 pt-3 border-t border-line flex items-center justify-between gap-4 text-xs">
              <DriverLegend />
              <span className="text-fg-muted shrink-0">
                12-month total <span className="ml-1 font-medium text-fg tabular-nums">{usd(projectionTotal)}</span>
              </span>
            </div>
            <p className="mt-2 text-xs text-fg-faint">
              Growth applies to storage, requests and data transfer. Compute and fixed fees stay as configured.
            </p>
          </Card>

          <Card
            title="Savings opportunities"
            aside={
              savings.length > 0 && <span className="text-xs text-fg-muted tabular-nums">{usd(savingsTotal)} / mo</span>
            }
            className="xl:col-span-5"
          >
            {savings.length === 0 ? (
              <p className="py-8 text-center text-xs text-fg-muted flex items-center justify-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-ok" /> No obvious savings in this design.
              </p>
            ) : (
              <div className="-mx-2 -my-1">
                {visibleSavings.map((s) => {
                  const item = estimate.items.find((i) => i.nodeId === s.nodeId);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => openInCanvas(s.nodeId, s.envId)}
                      title={`Open ${item?.label} in ${environments[s.envId].name}`}
                      className="group w-full text-left px-2 py-2.5 rounded-md hover:bg-raised transition-colors flex items-start gap-3"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="text-xs font-medium text-fg">{s.title}</div>
                        <div className="text-xs text-fg-muted flex items-center gap-1.5 min-w-0">
                          <EnvDot color={environments[s.envId].color} className="w-1.5 h-1.5" />
                          <span className="truncate">
                            {item?.label} · {envLabel(s.envId)}
                          </span>
                        </div>
                        <p className="text-xs text-fg-faint leading-relaxed">{s.detail}</p>
                      </div>
                      <span className="text-xs font-medium text-ok tabular-nums shrink-0 flex items-center gap-1">
                        <ArrowDown className="w-3 h-3" />
                        {usd(s.monthlyUsd)}
                      </span>
                    </button>
                  );
                })}
                {savings.length > 3 && (
                  <Button variant="ghost" className="mt-1 ml-0.5" onClick={() => setShowAllSavings(!showAllSavings)}>
                    {showAllSavings ? 'Show fewer' : `Show all ${savings.length}`}
                  </Button>
                )}
              </div>
            )}
          </Card>

          {/* Every resource, every environment */}
          <Card
            title="Resources"
            aside={
              <label className="flex items-center gap-2 text-xs text-fg-muted cursor-pointer">
                Show free resources
                <Switch checked={showFree} onChange={setShowFree} />
              </label>
            }
            className="xl:col-span-12"
          >
            <div className="-mx-4 -mb-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line text-fg-muted">
                    <th className="pl-4 pr-3 py-2 text-left font-normal">Resource</th>
                    <th className="px-3 py-2 text-left font-normal">Sizing in {envLabel(activeEnv)}</th>
                    {ENV_IDS.map((id) => (
                      <th key={id} className="px-3 py-2 text-right font-normal w-[92px]">
                        <button
                          type="button"
                          onClick={() => setSortEnv(id)}
                          title={`Sort by ${environments[id].name}`}
                          className={cn(
                            'inline-flex items-center gap-1.5 hover:text-fg transition-colors',
                            sortBy === id && 'text-fg'
                          )}
                        >
                          <EnvDot color={environments[id].color} className="w-1.5 h-1.5" />
                          {envLabel(id)}
                          {sortBy === id && <ArrowDown className="w-3 h-3" />}
                        </button>
                      </th>
                    ))}
                    <th className="pl-3 pr-4 py-2 text-left font-normal w-[160px]">Share of {envLabel(activeEnv)}</th>
                  </tr>
                </thead>
                <tbody>
                  {tableItems.map((item) => {
                    const svc = SERVICE_BY_TYPE[item.serviceType];
                    const share = total > 0 ? item.monthlyUsd[activeEnv] / total : 0;
                    return (
                      <tr
                        key={item.nodeId}
                        onClick={() => openInCanvas(item.nodeId)}
                        className="group border-b border-line last:border-b-0 hover:bg-raised cursor-pointer transition-colors"
                      >
                        <td className="pl-4 pr-3 py-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {svc && <ServiceGlyph iconName={svc.iconName} color={svc.color} size="sm" />}
                            <div className="min-w-0">
                              <div className="text-fg truncate">{item.label}</div>
                              <div className="text-fg-faint truncate">{svc?.name ?? item.serviceType}</div>
                            </div>
                            <ArrowRight className="w-3 h-3 text-fg-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-fg-muted max-w-[260px] truncate">{item.sizingNotes[activeEnv]}</td>
                        {ENV_IDS.map((id) => (
                          <td
                            key={id}
                            className={cn(
                              'px-3 py-2 text-right tabular-nums',
                              item.monthlyUsd[id] === 0 ? 'text-fg-faint' : id === activeEnv ? 'text-fg' : 'text-fg-muted'
                            )}
                          >
                            {item.sizingNotes[id] === 'Disabled' ? 'off' : usd(item.monthlyUsd[id])}
                          </td>
                        ))}
                        <td className="pl-3 pr-4 py-2">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-overlay overflow-hidden">
                              <div className="h-full rounded-full bg-fg-muted" style={{ width: `${share * 100}%` }} />
                            </div>
                            <span className="w-9 text-right text-fg-muted tabular-nums">{Math.round(share * 100)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong">
                    <td className="pl-4 pr-3 py-2.5 text-fg-muted" colSpan={2}>
                      Total
                    </td>
                    {ENV_IDS.map((id) => (
                      <td key={id} className={cn('px-3 py-2.5 text-right tabular-nums font-medium', id === activeEnv ? 'text-fg' : 'text-fg-muted')}>
                        {usd(estimate.totalsByEnv[id])}
                      </td>
                    ))}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Inputs that drive every usage-priced service */}
          <Card
            title="Usage assumptions"
            aside={
              <Button
                variant="ghost"
                disabled={usageIsDefault}
                onClick={() => ENV_IDS.forEach((id) => updateEnvironmentProfile(id, { usage: { ...DEFAULT_ENVIRONMENTS[id].usage } }))}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </Button>
            }
            className="xl:col-span-12"
          >
            <p className="-mt-1 mb-4 text-xs text-fg-muted leading-relaxed max-w-[760px]">
              Lambda, API Gateway, queues, DynamoDB and other usage-priced services each see the full request volume.
              Instances, databases and clusters are priced from their configuration, not these numbers. Saved with the
              project.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-fg-muted">
                    <th className="pb-2 pr-4 text-left font-normal">Assumption</th>
                    {ENV_IDS.map((id) => (
                      <th key={id} className="pb-2 px-2 text-left font-normal">
                        <span className="flex items-center gap-1.5">
                          <EnvDot color={environments[id].color} className="w-1.5 h-1.5" />
                          {environments[id].name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {USAGE_FIELDS.map((field) => (
                    <tr key={field.key}>
                      <td className="py-1 pr-4 text-fg whitespace-nowrap">
                        {field.label} <span className="text-fg-faint">{field.unit}</span>
                      </td>
                      {ENV_IDS.map((id) => (
                        <td key={id} className="py-1 px-2 min-w-[120px]">
                          <input
                            type="number"
                            min={0}
                            step={field.step}
                            aria-label={`${field.label} in ${environments[id].name}`}
                            value={usageFor(environments[id], id)[field.key]}
                            onChange={(e) => setUsage(id, field.key, e.target.value)}
                            className={cn(fieldCls, 'font-mono tabular-nums')}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
