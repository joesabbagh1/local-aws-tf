import { memo } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { CloudNode } from '../types/cloud';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import { useCloudStore } from '../store/useCloudStore';
import { AwsServiceIcon } from './AwsServiceIcon';
import { Copy, Loader2, Trash2 } from 'lucide-react';
import { cn } from './ui';
import { PLAN_ACTION_STYLE } from './PlanReviewBar';

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
  const plannedAction = useCloudStore((s) =>
    s.pendingPlan?.envId === s.activeEnv ? s.pendingPlan.byNode[id] : undefined
  );

  const svc = SERVICE_BY_TYPE[data.serviceType];
  const color = svc?.color || '#8E8CD8';
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
      className={cn(
        'group relative w-full h-full rounded-xl border border-dashed transition-[opacity,border-color] duration-150',
        isSubnet ? 'bg-white/[0.02]' : 'bg-white/[0.012]',
        isSelected ? 'border-accent' : 'border-line-strong hover:border-fg-faint',
        !isEnabled && 'opacity-40'
      )}
    >
      <NodeResizer
        isVisible={isSelected}
        minWidth={isSubnet ? 300 : 360}
        minHeight={isSubnet ? 200 : 240}
        color="#E8C400"
        onResizeStart={() => pushHistory()}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <Handle type="target" position={Position.Left} />

      {/* Header strip */}
      <div className="absolute top-0 inset-x-0 h-10 px-3.5 flex items-center justify-between gap-3 cursor-grab">
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color }} className="shrink-0">
            <AwsServiceIcon iconName={svc?.iconName || 'Network'} className="w-3.5 h-3.5" />
          </span>
          <span className="text-xs text-fg-muted shrink-0">{svc?.shortName}</span>
          <span className="text-[14px] font-medium text-fg truncate">{data.label}</span>
          {tier && (
            <span className="text-[12.5px] text-fg-faint px-1.5 rounded border border-line shrink-0">{tier}</span>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0 font-mono text-[12.5px]">
          <span
            className={isOverridden('cidr_block') ? 'text-accent' : 'text-fg-muted'}
            title={`CIDR in ${activeEnv}${isOverridden('cidr_block') ? ' (override)' : ''}`}
          >
            {String(cfg.cidr_block || '—')}
          </span>
          {isSubnet && cfg.availability_zone && (
            <span className="text-fg-faint">{String(cfg.availability_zone)}</span>
          )}
          {!isEnabled ? (
            <span className="font-sans text-fg-faint">skipped in {activeEnv}</span>
          ) : plannedAction ? (
            <span className={PLAN_ACTION_STYLE[plannedAction].text}>
              {PLAN_ACTION_STYLE[plannedAction].symbol} {PLAN_ACTION_STYLE[plannedAction].label}
            </span>
          ) : provState === 'provisioning' || provState === 'planning' ? (
            <Loader2 className="w-3 h-3 animate-spin text-warn" />
          ) : provState === 'provisioned' ? (
            <span className="w-1.5 h-1.5 rounded-full bg-ok" title={`Applied in ${activeEnv}`} />
          ) : provState === 'failed' ? (
            <span className="w-1.5 h-1.5 rounded-full bg-err" title={`Failed in ${activeEnv}`} />
          ) : null}

          <div className="hidden group-hover:flex items-center">
            <button
              type="button"
              title="Duplicate (⌘D)"
              onClick={(e) => {
                e.stopPropagation();
                duplicateNode(id);
              }}
              className="p-1 rounded text-fg-muted hover:text-fg"
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
              className="p-1 rounded text-fg-muted hover:text-err"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {childCount === 0 && (
        <div className="absolute inset-0 top-10 flex items-center justify-center pointer-events-none">
          <span className="text-xs text-fg-faint">
            Drop resources here to place them in this {isSubnet ? 'subnet' : 'VPC'}
          </span>
        </div>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
});

AwsContainerNode.displayName = 'AwsContainerNode';
