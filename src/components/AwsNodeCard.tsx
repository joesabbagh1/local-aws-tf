import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CloudNode, EnvironmentId } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { CARD_WIDTH } from '../utils/canvasLayout';
import { Copy, Trash2, Loader2, Database } from 'lucide-react';
import { EnvDot, ServiceGlyph, cn } from './ui';
import { PLAN_ACTION_STYLE } from './PlanReviewBar';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

export const AwsNodeCard = memo(({ id, data, selected }: NodeProps<CloudNode>) => {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const selectNode = useCloudStore((s) => s.selectNode);
  const duplicateNode = useCloudStore((s) => s.duplicateNode);
  const deleteNode = useCloudStore((s) => s.deleteNode);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  // What the pending plan would do to this resource, if a plan for this environment is under review
  const plannedChanges = useCloudStore((s) =>
    s.pendingPlan?.envId === s.activeEnv ? s.pendingPlan.changesByNode[id] : undefined
  );
  const plannedAction = useCloudStore((s) =>
    s.pendingPlan?.envId === s.activeEnv ? s.pendingPlan.byNode[id] : undefined
  );

  const svc = SERVICE_BY_TYPE[data.serviceType];
  const isSelected = selected || selectedNodeId === id;
  const isEnabledInActiveEnv = data.envEnabled?.[activeEnv] !== false;

  const resolvedConfig = {
    ...(data.baseConfig || {}),
    ...(data.envOverrides?.[activeEnv] || {}),
  };

  const overrideKeys = Object.keys(data.envOverrides?.[activeEnv] || {});
  const provState = data.provisioningStatus?.[activeEnv] || 'unapplied';
  const isBusy = provState === 'provisioning' || provState === 'planning';

  const isDataPlaneExplorable = [
    'aws_s3_bucket',
    'aws_dynamodb_table',
    'aws_sqs_queue',
    'aws_lambda_function',
  ].includes(data.serviceType);

  const previewFields = (svc?.schema || []).slice(0, 3);

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectNode(id);
      }}
      style={{ width: CARD_WIDTH }}
      className={cn(
        'group relative rounded-lg bg-raised border shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[border-color,box-shadow,opacity] duration-150',
        isSelected
          ? 'border-accent shadow-[0_0_0_3px_rgba(232,196,0,0.15)]'
          : plannedAction
          ? PLAN_ACTION_STYLE[plannedAction].border
          : isBusy
          ? 'border-warn/70'
          : provState === 'failed'
          ? 'border-err/60'
          : 'border-line hover:border-line-strong',
        !isEnabledInActiveEnv && 'opacity-40 border-dashed'
      )}
    >
      <Handle type="target" position={Position.Left} />

      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
        <ServiceGlyph iconName={svc?.iconName || 'Server'} color={svc?.color || '#9CA1A4'} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-fg truncate leading-tight">{data.label}</div>
          <div className="text-[12.5px] text-fg-faint truncate mt-0.5">
            {svc?.shortName || 'AWS'}
            <span className="mx-1">·</span>
            <span className="font-mono">{data.resourceName}</span>
          </div>
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute top-2 right-2 hidden group-hover:flex items-center bg-overlay border border-line-strong rounded-md">
        {isDataPlaneExplorable && (
          <button
            type="button"
            title="Browse live data"
            onClick={(e) => {
              e.stopPropagation();
              selectNode(id);
              setRightTab('explorer');
            }}
            className="p-1.5 text-fg-muted hover:text-fg"
          >
            <Database className="w-3 h-3" />
          </button>
        )}
        <button
          type="button"
          title="Duplicate (⌘D)"
          onClick={(e) => {
            e.stopPropagation();
            duplicateNode(id);
          }}
          className="p-1.5 text-fg-muted hover:text-fg"
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          type="button"
          title="Delete (⌫)"
          onClick={(e) => {
            e.stopPropagation();
            deleteNode(id);
          }}
          className="p-1.5 text-fg-muted hover:text-err"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Resolved config for the active environment */}
      {previewFields.length > 0 && (
        <dl className="px-3 py-2 space-y-1 border-t border-line">
          {previewFields.map((field) => {
            const val = resolvedConfig[field.key];
            const isOverridden = overrideKeys.includes(field.key);
            const displayVal =
              typeof val === 'boolean' ? String(val) : val === undefined || val === '' ? '—' : String(val);

            return (
              <div key={field.key} className="flex items-baseline justify-between gap-3 font-mono text-[12.5px]">
                <dt className="text-fg-faint truncate shrink-0 max-w-[45%]">{field.key}</dt>
                <dd
                  title={isOverridden ? `Overridden in ${activeEnv}` : undefined}
                  className={cn('truncate', isOverridden ? 'text-accent' : 'text-fg-muted')}
                >
                  {displayVal}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {/* Footer: environment presence + live status */}
      <div className="h-7 px-3 flex items-center justify-between border-t border-line">
        <div className="flex items-center gap-1" title="Deployed in dev · test · staging · prod">
          {ENV_IDS.map((envId) => (
            <EnvDot
              key={envId}
              color={environments[envId].color}
              hollow={data.envEnabled?.[envId] === false}
              className="w-1.5 h-1.5"
            />
          ))}
        </div>

        <span className="text-[12.5px] flex items-center gap-1.5">
          {!isEnabledInActiveEnv ? (
            <span className="text-fg-faint">skipped in {activeEnv}</span>
          ) : plannedAction && !isBusy ? (
            <span
              className={cn('font-mono', PLAN_ACTION_STYLE[plannedAction].text)}
              title={(plannedChanges || [])
                .map((c) => `${PLAN_ACTION_STYLE[c.action].symbol} ${c.address}`)
                .join('\n')}
            >
              {PLAN_ACTION_STYLE[plannedAction].symbol} {PLAN_ACTION_STYLE[plannedAction].label}
            </span>
          ) : isBusy ? (
            <span className="text-warn flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              {provState}
            </span>
          ) : provState === 'provisioned' ? (
            <span className="text-fg-muted flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-ok" />
              applied
            </span>
          ) : provState === 'failed' ? (
            <span className="text-err">failed</span>
          ) : overrideKeys.length > 0 ? (
            <span className="text-fg-faint">
              {overrideKeys.length} {activeEnv} override{overrideKeys.length > 1 ? 's' : ''}
            </span>
          ) : null}
        </span>
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
});

AwsNodeCard.displayName = 'AwsNodeCard';
