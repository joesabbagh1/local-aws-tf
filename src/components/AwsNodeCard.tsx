import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CloudNode, EnvironmentId } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import {
  Copy,
  Trash2,
  Sparkles,
  EyeOff,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Database,
} from 'lucide-react';

const ENV_LIST: { id: EnvironmentId; label: string; dotColor: string }[] = [
  { id: 'dev', label: 'D', dotColor: '#38bdf8' },
  { id: 'testing', label: 'T', dotColor: '#a855f7' },
  { id: 'staging', label: 'S', dotColor: '#f59e0b' },
  { id: 'prod', label: 'P', dotColor: '#10b981' },
];

export const AwsNodeCard = memo(({ id, data, selected }: NodeProps<CloudNode>) => {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const selectNode = useCloudStore((s) => s.selectNode);
  const duplicateNode = useCloudStore((s) => s.duplicateNode);
  const deleteNode = useCloudStore((s) => s.deleteNode);
  const setRightTab = useCloudStore((s) => s.setRightTab);

  const svc = SERVICE_BY_TYPE[data.serviceType];
  const isSelected = selected || selectedNodeId === id;
  const isEnabledInActiveEnv = data.envEnabled?.[activeEnv] !== false;

  const resolvedConfig = {
    ...(data.baseConfig || {}),
    ...(data.envOverrides?.[activeEnv] || {}),
  };

  const overrideKeys = Object.keys(data.envOverrides?.[activeEnv] || {});
  const hasActiveOverrides = overrideKeys.length > 0;
  const provState = data.provisioningStatus?.[activeEnv] || 'unapplied';

  const isDataPlaneExplorable = [
    'aws_s3_bucket',
    'aws_dynamodb_table',
    'aws_sqs_queue',
    'aws_lambda_function',
  ].includes(data.serviceType);

  const previewFields = (svc?.schema || []).slice(0, 3);
  const color = svc?.color || '#f97316';

  let borderStyle = isSelected ? `1.5px solid ${color}` : '1px solid #1e2433';
  if (provState === 'provisioned' && !isSelected) {
    borderStyle = '1.5px solid #10b98188';
  } else if (provState === 'provisioning' || provState === 'planning') {
    borderStyle = '1.5px solid #f59e0b';
  }

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectNode(id);
      }}
      className={`group relative w-[264px] rounded-xl transition-all duration-150 ${
        isEnabledInActiveEnv ? 'opacity-100' : 'opacity-45 grayscale-[40%]'
      }`}
      style={{
        background: '#11141d',
        border: borderStyle,
        boxShadow: isSelected
          ? `0 0 0 3px ${color}25, 0 18px 35px -10px rgba(0,0,0,0.75)`
          : '0 10px 25px -8px rgba(0, 0, 0, 0.6)',
      }}
    >
      {/* Top Accent Bar */}
      <div
        className="h-1 w-full rounded-t-xl"
        style={{
          background: `linear-gradient(90deg, ${color}, ${color}66)`,
        }}
      />

      {/* Input Handle (Left) */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !rounded-full"
        style={{ background: color }}
      />

      {/* Quick Hover Actions */}
      <div className="absolute -top-3 right-2 hidden group-hover:flex items-center gap-1 bg-[#161b26] border border-slate-700/80 rounded-lg px-1.5 py-0.5 shadow-lg z-20">
        {isDataPlaneExplorable && (
          <button
            type="button"
            title="Open Data-Plane Explorer (S3 / DynamoDB / SQS / Lambda)"
            onClick={(e) => {
              e.stopPropagation();
              selectNode(id);
              setRightTab('explorer');
            }}
            className="p-1 text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <Database className="w-3 h-3" />
          </button>
        )}
        <button
          type="button"
          title="Duplicate Resource (Cmd+D)"
          onClick={(e) => {
            e.stopPropagation();
            duplicateNode(id);
          }}
          className="p-1 text-slate-400 hover:text-slate-100 transition-colors"
        >
          <Copy className="w-3 h-3" />
        </button>
        <button
          type="button"
          title="Delete Resource (Backspace)"
          onClick={(e) => {
            e.stopPropagation();
            deleteNode(id);
          }}
          className="p-1 text-slate-400 hover:text-rose-400 transition-colors"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Header */}
      <div className="p-3 pb-2.5 flex items-start justify-between gap-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border"
            style={{
              backgroundColor: `${color}18`,
              borderColor: `${color}45`,
              color,
            }}
          >
            <AwsServiceIcon iconName={svc?.iconName || 'Server'} className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.2 rounded"
                style={{
                  backgroundColor: `${color}20`,
                  color,
                }}
              >
                {svc?.shortName || 'AWS'}
              </span>
              {hasActiveOverrides && (
                <span
                  title={`${overrideKeys.length} override(s) in ${activeEnv.toUpperCase()}`}
                  className="inline-flex items-center gap-0.5 text-[9px] font-medium px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30"
                >
                  <Sparkles className="w-2.5 h-2.5" />
                  {activeEnv.toUpperCase()}
                </span>
              )}
            </div>
            <h3 className="text-xs font-semibold text-slate-100 truncate mt-0.5">
              {data.label}
            </h3>
            <p className="text-[10px] font-mono text-slate-400 truncate">
              {data.serviceType}.{data.resourceName}
            </p>
          </div>
        </div>
      </div>

      {/* Disabled in current env banner */}
      {!isEnabledInActiveEnv && (
        <div className="px-3 py-1.5 bg-rose-950/40 border-b border-rose-500/20 flex items-center gap-1.5 text-[10px] text-rose-300">
          <EyeOff className="w-3 h-3 shrink-0" />
          <span>Skipped in {activeEnv.toUpperCase()} environment</span>
        </div>
      )}

      {/* Live Resolved Specs for Active Environment */}
      <div className="px-3 py-2 space-y-1 bg-[#0d1017]/60">
        {previewFields.map((field) => {
          const val = resolvedConfig[field.key];
          const isOverridden = overrideKeys.includes(field.key);
          const displayVal =
            typeof val === 'boolean'
              ? val
                ? 'true'
                : 'false'
              : val === undefined || val === ''
              ? '—'
              : String(val);

          return (
            <div
              key={field.key}
              className="flex items-center justify-between text-[11px] gap-2"
            >
              <span className="text-slate-400 truncate">{field.label.split(' ')[0]}:</span>
              <span
                className={`font-mono text-[10px] truncate max-w-[140px] px-1 rounded ${
                  isOverridden
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold'
                    : 'text-slate-200'
                }`}
              >
                {displayVal}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer: Multi-Env Matrix Pips & Live Provisioning Badge */}
      <div className="px-3 py-1.5 flex items-center justify-between border-t border-slate-800/80 rounded-b-xl bg-[#11141d]">
        <div className="flex items-center gap-1" title="Enabled Environments (Dev / Test / Staging / Prod)">
          {ENV_LIST.map((env) => {
            const enabled = data.envEnabled?.[env.id] !== false;
            const hasEnvOverride =
              Object.keys(data.envOverrides?.[env.id] || {}).length > 0;
            const isCurrent = activeEnv === env.id;

            return (
              <span
                key={env.id}
                className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center transition-all ${
                  enabled
                    ? 'text-slate-950'
                    : 'bg-slate-800/70 text-slate-600 line-through'
                } ${isCurrent ? 'ring-1 ring-white scale-105' : ''}`}
                style={{
                  backgroundColor: enabled ? env.dotColor : undefined,
                }}
                title={`${env.id.toUpperCase()}: ${enabled ? 'Enabled' : 'Disabled'}${
                  hasEnvOverride ? ' (Has Env Overrides)' : ''
                }`}
              >
                {env.label}
              </span>
            );
          })}
        </div>

        {/* Provisioning Status Indicator */}
        <div className="flex items-center gap-1">
          {provState === 'provisioning' || provState === 'planning' ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-amber-300">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {provState}
            </span>
          ) : provState === 'provisioned' ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400">
              <CheckCircle2 className="w-2.5 h-2.5" />
              applied
            </span>
          ) : provState === 'failed' ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-rose-400">
              <AlertTriangle className="w-2.5 h-2.5" />
              check logs
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              aws-emulator
            </span>
          )}
        </div>
      </div>

      {/* Output Handle (Right) */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !rounded-full"
        style={{ background: color }}
      />
    </div>
  );
});

AwsNodeCard.displayName = 'AwsNodeCard';
