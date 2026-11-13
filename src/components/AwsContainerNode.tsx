import { memo } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import { CheckCircle2, Copy, EyeOff, Loader2, Trash2, AlertTriangle } from 'lucide-react';

/**
 * Resizable VPC / Subnet group. Resources dragged inside become children
 * and compile with this network's vpc_id / subnet_id.
 */
export const AwsContainerNode = memo(({ id, data, selected }: NodeProps<CloudNode>) => {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const selectNode = useCloudStore((s) => s.selectNode);
  const duplicateNode = useCloudStore((s) => s.duplicateNode);
  const deleteNode = useCloudStore((s) => s.deleteNode);
  const pushHistory = useCloudStore((s) => s.pushHistory);
  const childCount = useCloudStore((s) => s.nodes.filter((n) => n.parentId === id).length);

  const svc = SERVICE_BY_TYPE[data.serviceType];
  const color = svc?.color || '#8b5cf6';
  const isSubnet = data.serviceType === 'aws_subnet';
  const isSelected = selected || selectedNodeId === id;
  const isEnabled = data.envEnabled?.[activeEnv] !== false;
  const provState = data.provisioningStatus?.[activeEnv] || 'unapplied';

  const cfg = { ...(data.baseConfig || {}), ...(data.envOverrides?.[activeEnv] || {}) };
  const isOverridden = (key: string) =>
    Object.prototype.hasOwnProperty.call(data.envOverrides?.[activeEnv] || {}, key);
  const tier = isSubnet ? String(cfg.tier || (cfg.map_public_ip_on_launch ? 'public' : 'private')) : null;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        selectNode(id);
      }}
      className={`group relative w-full h-full rounded-2xl transition-[opacity,box-shadow] duration-150 ${
        isEnabled ? 'opacity-100' : 'opacity-45'
      }`}
      style={{
        background: isSubnet ? `${color}0d` : `${color}08`,
        border: `1.5px dashed ${isSelected ? color : `${color}66`}`,
        boxShadow: isSelected ? `0 0 0 3px ${color}22` : undefined,
      }}
    >
      <NodeResizer
        isVisible={isSelected}
        minWidth={isSubnet ? 300 : 360}
        minHeight={isSubnet ? 200 : 240}
        color={color}
        onResizeStart={() => pushHistory()}
        handleStyle={{ width: 9, height: 9, borderRadius: 3 }}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <Handle type="target" position={Position.Left} className="!w-3 !h-3" style={{ background: color }} />

      {/* Header strip */}
      <div className="absolute top-0 inset-x-0 px-3 py-2 flex items-center justify-between gap-2 cursor-grab">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 border"
            style={{ backgroundColor: `${color}20`, borderColor: `${color}55`, color }}
          >
            <AwsServiceIcon iconName={svc?.iconName || 'Network'} className="w-3.5 h-3.5" />
          </div>
          <span
            className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ backgroundColor: `${color}22`, color }}
          >
            {svc?.shortName}
          </span>
          <span className="text-xs font-semibold text-slate-100 truncate">{data.label}</span>
          {tier && (
            <span
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                tier === 'public'
                  ? 'bg-sky-500/10 text-sky-300 border-sky-500/30'
                  : 'bg-slate-700/30 text-slate-300 border-slate-600/50'
              }`}
            >
              {tier}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
              isOverridden('cidr_block')
                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                : 'text-slate-300 bg-slate-900/60'
            }`}
            title={`CIDR in ${activeEnv.toUpperCase()}`}
          >
            {String(cfg.cidr_block || '—')}
          </span>
          {isSubnet && cfg.availability_zone && (
            <span className="text-[10px] font-mono text-slate-400">{String(cfg.availability_zone)}</span>
          )}
          {provState === 'provisioning' || provState === 'planning' ? (
            <Loader2 className="w-3 h-3 animate-spin text-amber-300" />
          ) : provState === 'provisioned' ? (
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          ) : provState === 'failed' ? (
            <AlertTriangle className="w-3 h-3 text-rose-400" />
          ) : null}

          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              type="button"
              title="Duplicate (Cmd+D)"
              onClick={(e) => {
                e.stopPropagation();
                duplicateNode(id);
              }}
              className="p-1 rounded text-slate-400 hover:text-slate-100"
            >
              <Copy className="w-3 h-3" />
            </button>
            <button
              type="button"
              title="Delete container (resources inside are kept)"
              onClick={(e) => {
                e.stopPropagation();
                deleteNode(id);
              }}
              className="p-1 rounded text-slate-400 hover:text-rose-400"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {!isEnabled && (
        <div className="absolute top-10 left-3 flex items-center gap-1 text-[10px] text-rose-300">
          <EyeOff className="w-3 h-3" /> Skipped in {activeEnv.toUpperCase()}
        </div>
      )}

      {childCount === 0 && (
        <div className="absolute inset-0 top-10 flex items-center justify-center pointer-events-none">
          <span className="text-[11px] text-slate-500">
            Drag resources here to place them in this {isSubnet ? 'subnet' : 'VPC'}
          </span>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!w-3 !h-3" style={{ background: color }} />
    </div>
  );
});

AwsContainerNode.displayName = 'AwsContainerNode';
