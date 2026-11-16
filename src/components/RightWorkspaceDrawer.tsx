import { useState, useMemo, type ReactNode } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import {
  compileTerraformForEnvironment,
  resolveNodeConfigForEnv,
  isFieldOverriddenInEnv,
  EXTRA_HCL_KEY,
  type CompileTarget,
} from '../utils/terraformCompiler';
import { AWS_EXPORT_DIR } from '../utils/awsExport';
import { emulatorSupport } from '../utils/emulatorSupport';
import { accessLevelsFor, callWiring } from '../utils/wiringCatalog';
import { envIdsOf, envLabel, isProductionEnv } from '../utils/environments';
import type { SchemaField } from '../types/cloud';
import { RunnerConsole } from './RunnerConsole';
import { LambdaWatchSection } from './LambdaWatchSection';
import { ResourceExplorerPanel } from './ResourceExplorerPanel';
import { ArchitectureAuditPanel } from './ArchitectureAuditPanel';
import type { RightDrawerTab } from '../store/useCloudStore';
import {
  Copy,
  Check,
  RotateCcw,
  Trash2,
  Plus,
  X,
  ArrowRight,
  RefreshCw,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
  Layers,
  FileCode2,
  SquareTerminal,
  Database,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  IconButton,
  EnvDot,
  Kbd,
  Section,
  Segmented,
  ServiceGlyph,
  Switch,
  cn,
  fieldCls,
  monoFieldCls,
} from './ui';

const DRAWER_TABS: { id: RightDrawerTab; label: string; icon: LucideIcon }[] = [
  { id: 'inspector', label: 'Inspect', icon: SlidersHorizontal },
  { id: 'env-matrix', label: 'Envs', icon: Layers },
  { id: 'terraform', label: 'Terraform', icon: FileCode2 },
  { id: 'emulator', label: 'Run', icon: SquareTerminal },
  { id: 'explorer', label: 'Data', icon: Database },
  { id: 'audit', label: 'Audit', icon: ShieldCheck },
];

const envShort = envLabel;

export function RightWorkspaceDrawer() {
  const rightTab = useCloudStore((s) => s.rightTab);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  const isOpen = useCloudStore((s) => s.isDrawerOpen);
  const setOpen = useCloudStore((s) => s.setDrawerOpen);

  if (!isOpen) {
    return (
      <aside className="w-10 shrink-0 h-full bg-panel border-l border-line flex flex-col items-center select-none">
        <div className="h-10 shrink-0 w-full border-b border-line flex items-center justify-center">
          <IconButton onClick={() => setOpen(true)} title="Show panel (⌘⌥B)">
            <PanelRightOpen className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="py-2 flex flex-col gap-1">
          {DRAWER_TABS.map(({ id, label, icon: Icon }) => (
            <IconButton
              key={id}
              onClick={() => setRightTab(id)}
              title={label}
              className={cn(rightTab === id && 'text-fg')}
            >
              <Icon className="w-4 h-4" />
            </IconButton>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[400px] shrink-0 h-full bg-panel border-l border-line flex flex-col select-none">
      <nav className="h-10 shrink-0 pl-2 pr-1.5 border-b border-line flex items-stretch">
        {DRAWER_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setRightTab(id)}
            className={cn(
              'relative px-2.5 text-[14px] transition-colors',
              rightTab === id ? 'text-fg' : 'text-fg-muted hover:text-fg'
            )}
          >
            {label}
            {rightTab === id && <span className="absolute left-2.5 right-2.5 -bottom-px h-px bg-fg" />}
          </button>
        ))}
        <IconButton onClick={() => setOpen(false)} title="Hide panel (⌘⌥B)" className="ml-auto self-center">
          <PanelRightClose className="w-4 h-4" />
        </IconButton>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {rightTab === 'inspector' && <NodeAndEdgeInspector />}
        {rightTab === 'env-matrix' && <MultiEnvMatrixPanel />}
        {rightTab === 'terraform' && <LiveTerraformPanel />}
        {rightTab === 'emulator' && <AwsEmulatorCommandCenter />}
        {rightTab === 'explorer' && <ResourceExplorerPanel />}
        {rightTab === 'audit' && <ArchitectureAuditPanel />}
      </div>
    </aside>
  );
}

/** What the emulator test run found for this service. */
function SupportLine({ support }: { support: ReturnType<typeof emulatorSupport> }) {
  const text =
    support.level === 'verified'
      ? 'Applies and destroys on the emulator'
      : support.level === 'adjusted'
        ? 'Works on the emulator with an adjustment'
        : support.level === 'second-apply'
        ? 'Works on the emulator; LocalCloud applies twice'
        : support.level === 'fails'
        ? `Fails on the emulator: ${support.errors[0] || 'see npm run test:emulator'}`
        : 'Not tested on the emulator';
  return (
    <div
      className="text-[12.5px] mt-1 flex items-center gap-1.5 min-w-0"
      title={[text, ...(support.level === 'fails' ? support.errors.slice(1) : support.errors), support.testedAt ? `Tested ${support.testedAt.slice(0, 10)}` : ''].filter(Boolean).join('\n')}
    >
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full shrink-0',
          support.level === 'verified' || support.level === 'adjusted' || support.level === 'second-apply'
            ? 'bg-ok'
            : support.level === 'fails'
              ? 'bg-warn'
              : 'bg-fg-faint/50'
        )}
      />
      <span className={cn('truncate', support.level === 'fails' ? 'text-warn' : 'text-fg-faint')}>{text}</span>
      {support.upstreamIssueUrl && (
        <a
          href={support.upstreamIssueUrl}
          target="_blank"
          rel="noreferrer"
          title="Reported to the emulator team"
          className="shrink-0 font-mono text-fg-muted hover:text-fg underline decoration-line-strong underline-offset-2"
        >
          #{support.upstreamIssueUrl.split('/').pop()}
        </a>
      )}
    </div>
  );
}

/** Two-column property grid row: label on the left, control on the right. */
function PropRow({
  label,
  hint,
  overridden,
  children,
}: {
  label: ReactNode;
  hint?: string;
  overridden?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="self-start h-7 flex items-center gap-1.5 min-w-0" title={hint}>
        {overridden && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
        <span className={cn('text-xs leading-tight', overridden ? 'text-fg' : 'text-fg-muted')}>{label}</span>
      </div>
      <div className="min-w-0 flex items-start gap-1">{children}</div>
    </>
  );
}

const PROP_GRID = 'grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2.5';

// ============================================================================
// 1. NODE & EDGE PROPERTY INSPECTOR
// ============================================================================
function NodeAndEdgeInspector() {
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const selectedEdgeId = useCloudStore((s) => s.selectedEdgeId);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const updateNodeMetadata = useCloudStore((s) => s.updateNodeMetadata);
  const updateNodeProperty = useCloudStore((s) => s.updateNodeProperty);
  const resetNodeEnvOverride = useCloudStore((s) => s.resetNodeEnvOverride);
  const toggleNodeInEnvironment = useCloudStore((s) => s.toggleNodeInEnvironment);
  const updateNodeTags = useCloudStore((s) => s.updateNodeTags);
  const duplicateNode = useCloudStore((s) => s.duplicateNode);
  const deleteNode = useCloudStore((s) => s.deleteNode);
  const updateEdgeData = useCloudStore((s) => s.updateEdgeData);
  const deleteEdge = useCloudStore((s) => s.deleteEdge);

  const [editScope, setEditScope] = useState<'env' | 'base'>('env');
  const [newTagKey, setNewTagKey] = useState('');
  const [newTagVal, setNewTagVal] = useState('');

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId);
  const ENV_IDS = envIdsOf(environments);

  if (selectedEdge) {
    const srcNode = nodes.find((n) => n.id === selectedEdge.source);
    const dstNode = nodes.find((n) => n.id === selectedEdge.target);
    // Only a call that grants access, to a target whose grant can be narrowed
    const accessLevels =
      srcNode && dstNode && selectedEdge.data?.relationshipType !== 'depends_on' && callWiring(srcNode.data.serviceType, dstNode.data.serviceType)?.grant
        ? accessLevelsFor(dstNode.data.serviceType)
        : [];

    return (
      <>
        <div className="px-4 py-4 border-b border-line flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-fg-muted">Connection</div>
            <div className="mt-1 flex items-center gap-2 text-[14px] font-medium text-fg min-w-0">
              <span className="truncate">{srcNode?.data.label || selectedEdge.source}</span>
              <ArrowRight className="w-3.5 h-3.5 text-fg-faint shrink-0" />
              <span className="truncate">{dstNode?.data.label || selectedEdge.target}</span>
            </div>
          </div>
          <IconButton variant="danger" onClick={() => deleteEdge(selectedEdge.id)} title="Remove connection">
            <Trash2 className="w-3.5 h-3.5" />
          </IconButton>
        </div>

        <Section>
          <div className={PROP_GRID}>
            <PropRow label="Type" hint="How the compiler wires these two resources together">
              <select
                value={selectedEdge.data?.relationshipType || 'data_flow'}
                onChange={(e) =>
                  updateEdgeData(selectedEdge.id, {
                    relationshipType: e.target.value as any,
                  })
                }
                className={fieldCls}
              >
                <option value="event_trigger">Event trigger / API route</option>
                <option value="iam_grant">IAM access grant</option>
                <option value="target_route">Load balancer / CDN origin</option>
                <option value="network_attachment">Network placement</option>
                <option value="data_flow">Data flow</option>
                <option value="depends_on">depends_on only</option>
              </select>
            </PropRow>
            <PropRow label="Label" hint="Shown on the canvas; route key for API routes, e.g. ANY /orders/*">
              <input
                type="text"
                value={selectedEdge.data?.label || ''}
                placeholder="ANY /orders/*"
                onChange={(e) => updateEdgeData(selectedEdge.id, { label: e.target.value })}
                className={monoFieldCls}
              />
            </PropRow>
            {accessLevels.length > 0 && (
              <PropRow label="Access" hint={`What ${srcNode?.data.label} may do with ${dstNode?.data.label}: the IAM policy on its role`}>
                <Segmented
                  value={selectedEdge.data?.access ?? 'readwrite'}
                  options={accessLevels}
                  // The full grant is the default, so it is stored as no level at all
                  onChange={(value) => updateEdgeData(selectedEdge.id, { access: value === 'readwrite' ? undefined : value })}
                />
              </PropRow>
            )}
          </div>
        </Section>
      </>
    );
  }

  if (!selectedNode) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-[14px] text-fg-muted">Select a resource or connection to edit it.</p>
        <div className="mt-6 inline-grid grid-cols-[auto_auto] gap-x-4 gap-y-2 text-xs text-fg-faint text-left">
          <Kbd>⌘Z</Kbd> <span>Undo</span>
          <Kbd>⌘D</Kbd> <span>Duplicate</span>
          <Kbd>⌫</Kbd> <span>Delete</span>
          <Kbd>Esc</Kbd> <span>Deselect</span>
        </div>
      </div>
    );
  }

  const svc = SERVICE_BY_TYPE[selectedNode.data.serviceType];
  const resolvedConfig = resolveNodeConfigForEnv(selectedNode, activeEnv);
  const envOverridesCount = Object.keys(selectedNode.data.envOverrides?.[activeEnv] || {}).length;
  const currentEnvProfile = environments[activeEnv];

  const handleFieldValueChange = (field: SchemaField, rawVal: any) => {
    const scope = editScope === 'env' ? activeEnv : 'base';
    updateNodeProperty(selectedNode.id, field.key, rawVal, scope);
  };

  const addTag = () => {
    if (!newTagKey.trim()) return;
    updateNodeTags(selectedNode.id, {
      ...(selectedNode.data.tags || {}),
      [newTagKey.trim()]: newTagVal.trim() || 'true',
    });
    setNewTagKey('');
    setNewTagVal('');
  };

  const removeTag = (k: string) => {
    const next = { ...(selectedNode.data.tags || {}) };
    delete next[k];
    updateNodeTags(selectedNode.id, next);
  };

  const tags = Object.entries(selectedNode.data.tags || {});

  return (
    <>
      {/* Header */}
      <div className="px-4 py-4 border-b border-line flex items-center gap-3">
        <ServiceGlyph iconName={svc?.iconName || 'Server'} color={svc?.color || '#9CA1A4'} size="lg" />
        <div className="min-w-0 flex-1" title={svc?.description}>
          <div className="text-[15px] font-medium text-fg truncate">{svc?.name || selectedNode.data.label}</div>
          <div className="text-[12.5px] font-mono text-fg-faint truncate mt-0.5">{svc?.terraformResourceType}</div>
          {svc?.deprecated ? (
            <div className="text-[12.5px] mt-1 flex items-center gap-1.5 min-w-0" title={svc.deprecated}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-warn" />
              <span className="truncate text-warn">Deprecated: {svc.deprecated}</span>
            </div>
          ) : (
            <SupportLine support={emulatorSupport(svc)} />
          )}
        </div>
        <div className="flex items-center shrink-0">
          <IconButton onClick={() => duplicateNode(selectedNode.id)} title="Duplicate (⌘D)">
            <Copy className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton variant="danger" onClick={() => deleteNode(selectedNode.id)} title="Delete (⌫)">
            <Trash2 className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      </div>

      {/* Identity & presence */}
      <Section>
        <div className={PROP_GRID}>
          <PropRow label="Name">
            <input
              type="text"
              value={selectedNode.data.label}
              onChange={(e) => updateNodeMetadata(selectedNode.id, { label: e.target.value })}
              className={fieldCls}
            />
          </PropRow>
          <PropRow label="Resource ID" hint="Terraform resource name">
            <input
              type="text"
              value={selectedNode.data.resourceName}
              onChange={(e) =>
                updateNodeMetadata(selectedNode.id, {
                  resourceName: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'),
                })
              }
              className={monoFieldCls}
            />
          </PropRow>
          <PropRow label="Deploy to" hint="Turn this resource off for individual environments">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1 w-full">
              {ENV_IDS.map((envId) => {
                const env = environments[envId];
                const enabled = selectedNode.data.envEnabled?.[envId] !== false;
                return (
                  <button
                    key={envId}
                    type="button"
                    onClick={() => toggleNodeInEnvironment(selectedNode.id, envId)}
                    title={`${enabled ? 'Deployed' : 'Skipped'} in ${env.name}`}
                    className={cn(
                      'h-7 px-1 min-w-0 rounded-md border text-xs inline-flex items-center justify-center gap-1 transition-colors',
                      enabled
                        ? 'border-line-strong bg-raised text-fg'
                        : 'border-line text-fg-faint hover:text-fg-muted'
                    )}
                  >
                    <EnvDot color={env.color} hollow={!enabled} className="w-1.5 h-1.5" />
                    <span className="truncate">{envShort(envId)}</span>
                  </button>
                );
              })}
            </div>
          </PropRow>
        </div>
      </Section>

      {/* Parameters */}
      <Section
        title="Configuration"
        aside={
          envOverridesCount > 0 && (
            <button
              type="button"
              onClick={() => resetNodeEnvOverride(selectedNode.id, activeEnv)}
              className="text-xs text-fg-muted hover:text-fg flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Reset {envOverridesCount} {envShort(activeEnv)} override{envOverridesCount > 1 ? 's' : ''}
            </button>
          )
        }
      >
        <Segmented
          value={editScope}
          onChange={setEditScope}
          options={[
            {
              value: 'env',
              label: (
                <>
                  <EnvDot color={currentEnvProfile.color} className="w-1.5 h-1.5" />
                  {envShort(activeEnv)} only
                </>
              ),
            },
            { value: 'base', label: 'All environments' },
          ]}
        />
        <p className="text-[12.5px] text-fg-faint mt-2 mb-4">
          {editScope === 'env' ? (
            <>
              Edits override the base value in <span className="font-mono">{activeEnv}.tfvars</span> only.
            </>
          ) : (
            <>Edits change the base value every environment inherits unless it overrides it.</>
          )}
        </p>

        <div className={PROP_GRID}>
          {(svc?.schema || []).map((field) => {
            const val =
              editScope === 'base'
                ? selectedNode.data.baseConfig?.[field.key] ?? field.defaultValue
                : resolvedConfig[field.key] ?? field.defaultValue;
            const isOverridden = isFieldOverriddenInEnv(selectedNode, activeEnv, field.key);

            return (
              <PropRow
                key={field.key}
                label={field.label}
                hint={`${field.key}${field.description ? ` · ${field.description}` : ''}${
                  isOverridden ? `\nOverridden in ${activeEnv}` : ''
                }`}
                overridden={isOverridden}
              >
                {field.type === 'boolean' ? (
                  <div className="h-7 flex items-center flex-1">
                    <Switch checked={Boolean(val)} onChange={(next) => handleFieldValueChange(field, next)} />
                  </div>
                ) : field.type === 'select' ? (
                  <select
                    value={String(val ?? '')}
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className={monoFieldCls}
                  >
                    {(field.options || []).map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    value={Number(val ?? 0)}
                    onChange={(e) => handleFieldValueChange(field, Number(e.target.value))}
                    className={monoFieldCls}
                  />
                ) : field.type === 'json' ? (
                  <textarea
                    rows={3}
                    value={typeof val === 'string' ? val : JSON.stringify(val, null, 2)}
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className={cn(monoFieldCls, 'resize-y leading-relaxed')}
                  />
                ) : (
                  <input
                    type="text"
                    value={String(val ?? '')}
                    placeholder={field.placeholder}
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className={monoFieldCls}
                  />
                )}

                {isOverridden && (
                  <IconButton
                    title="Revert to base value"
                    onClick={() => resetNodeEnvOverride(selectedNode.id, activeEnv, field.key)}
                    className="w-6 h-7"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </IconButton>
                )}
              </PropRow>
            );
          })}
        </div>
      </Section>

      {/* Arguments the form does not model, written straight into the resource block */}
      <Section
        title={
          <span className="flex items-center gap-1.5">
            {isFieldOverriddenInEnv(selectedNode, activeEnv, EXTRA_HCL_KEY) && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            )}
            Extra HCL
          </span>
        }
        aside={
          isFieldOverriddenInEnv(selectedNode, activeEnv, EXTRA_HCL_KEY) && (
            <button
              type="button"
              onClick={() => resetNodeEnvOverride(selectedNode.id, activeEnv, EXTRA_HCL_KEY)}
              className="text-xs text-fg-muted hover:text-fg flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Revert to base
            </button>
          )
        }
      >
        <textarea
          value={String(
            (editScope === 'base' ? selectedNode.data.baseConfig?.[EXTRA_HCL_KEY] : resolvedConfig[EXTRA_HCL_KEY]) ?? ''
          )}
          onChange={(e) =>
            updateNodeProperty(selectedNode.id, EXTRA_HCL_KEY, e.target.value, editScope === 'env' ? activeEnv : 'base')
          }
          rows={4}
          spellCheck={false}
          placeholder={'publish = true\n\nlifecycle {\n  prevent_destroy = true\n}'}
          className={cn(monoFieldCls, 'p-3 text-[13px] leading-relaxed resize-y')}
        />
        <p className="text-[12.5px] text-fg-faint mt-2">
          Added inside the <span className="font-mono">{svc?.terraformResourceType}</span> block as written, for{' '}
          {editScope === 'env' ? `${envShort(activeEnv)} only` : 'all environments'}. Don't repeat arguments the
          form already sets.
        </p>
      </Section>

      {/* Lambda code: inline, or a folder in the project zipped as-is (dependencies included) */}
      {selectedNode.data.serviceType === 'aws_lambda_function' && (
        <Section
          title="Code"
          aside={
            <span className="text-[12.5px] font-mono text-fg-faint">
              handler {String(resolvedConfig.handler || 'index.handler')}
            </span>
          }
        >
          <Segmented
            value={selectedNode.data.sourceDir === undefined ? 'inline' : 'folder'}
            onChange={(mode) =>
              updateNodeMetadata(selectedNode.id, { sourceDir: mode === 'folder' ? selectedNode.data.sourceDir ?? '' : undefined })
            }
            options={[
              { value: 'inline', label: 'Inline' },
              { value: 'folder', label: 'Folder' },
            ]}
            className="mb-3"
          />
          {selectedNode.data.sourceDir === undefined ? (
            <>
              <textarea
                value={selectedNode.data.inlineCode || ''}
                onChange={(e) => updateNodeMetadata(selectedNode.id, { inlineCode: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== 'Tab') return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const { selectionStart, selectionEnd, value } = el;
                  const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
                  updateNodeMetadata(selectedNode.id, { inlineCode: next });
                  requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2));
                }}
                rows={12}
                spellCheck={false}
                placeholder="Leave empty to deploy a default echo handler"
                className={cn(monoFieldCls, 'p-3 text-[13px] leading-relaxed resize-y')}
              />
              <p className="text-[12.5px] text-fg-faint mt-2">
                Saved as{' '}
                <span className="font-mono">
                  {String(resolvedConfig.handler || 'index.handler').split('.').slice(0, -1).join('.') || 'index'}.
                  {String(resolvedConfig.runtime || 'nodejs20.x').startsWith('python') ? 'py' : 'mjs'}
                </span>{' '}
                and zipped on sync and apply. One file, no dependencies.
              </p>
            </>
          ) : (
            <>
              <input
                type="text"
                value={selectedNode.data.sourceDir}
                placeholder="functions/orders"
                spellCheck={false}
                onChange={(e) => updateNodeMetadata(selectedNode.id, { sourceDir: e.target.value })}
                className={monoFieldCls}
              />
              <p className={cn('text-[12.5px] mt-2 leading-relaxed', selectedNode.data.sourceDir.trim() ? 'text-fg-faint' : 'text-warn')}>
                {selectedNode.data.sourceDir.trim()
                  ? 'Relative to the project folder. Zipped as-is on sync, apply and export, including node_modules or vendored packages, so build or install first. The handler is a path inside it.'
                  : 'Set a folder relative to the project. Until then the inline code is used.'}
              </p>
            </>
          )}
        </Section>
      )}

      {/* Live outputs captured after terraform apply */}
      {selectedNode.data.provisionedOutputs?.[activeEnv] && (
        <Section
          title={
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-ok" />
              Outputs in {envShort(activeEnv)}
            </span>
          }
        >
          <dl className="space-y-1.5">
            {Object.entries(selectedNode.data.provisionedOutputs[activeEnv]!).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 text-xs">
                <dt className="text-fg-muted truncate">{k}</dt>
                <dd className="font-mono text-[12.5px] text-fg break-all select-text">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {/* Tags */}
      <Section title="Tags">
        {tags.length > 0 && (
          <div className="mb-3 space-y-1">
            {tags.map(([k, v]) => (
              <div key={k} className="group grid grid-cols-[112px_minmax(0,1fr)_auto] gap-3 items-center h-6 text-xs font-mono">
                <span className="text-fg-muted truncate">{k}</span>
                <span className="text-fg truncate">{v}</span>
                <button
                  type="button"
                  onClick={() => removeTag(k)}
                  title={`Remove ${k}`}
                  className="text-fg-faint hover:text-err opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addTag();
          }}
        >
          <input
            type="text"
            placeholder="key"
            value={newTagKey}
            onChange={(e) => setNewTagKey(e.target.value)}
            className={monoFieldCls}
          />
          <input
            type="text"
            placeholder="value"
            value={newTagVal}
            onChange={(e) => setNewTagVal(e.target.value)}
            className={monoFieldCls}
          />
          <IconButton type="submit" title="Add tag" disabled={!newTagKey.trim()} className="border border-line">
            <Plus className="w-3.5 h-3.5" />
          </IconButton>
        </form>
      </Section>
    </>
  );
}

// ============================================================================
// 2. MULTI-ENVIRONMENT MATRIX & COMPARISON PANEL (DEV / TEST / STAGING / PROD)
// ============================================================================
function MultiEnvMatrixPanel() {
  const nodes = useCloudStore((s) => s.nodes);
  const selectedNodeId = useCloudStore((s) => s.selectedNodeId);
  const selectNode = useCloudStore((s) => s.selectNode);
  const environments = useCloudStore((s) => s.environments);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const setActiveEnv = useCloudStore((s) => s.setActiveEnv);
  const updateEnvironmentProfile = useCloudStore((s) => s.updateEnvironmentProfile);
  const toggleNodeInEnvironment = useCloudStore((s) => s.toggleNodeInEnvironment);
  const addEnvironment = useCloudStore((s) => s.addEnvironment);
  const removeEnvironment = useCloudStore((s) => s.removeEnvironment);

  const [newEnvId, setNewEnvId] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const ENV_IDS = envIdsOf(environments);
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];
  const svc = selectedNode ? SERVICE_BY_TYPE[selectedNode.data.serviceType] : null;

  const submitNewEnvironment = () => {
    const id = newEnvId.trim().toLowerCase();
    if (!id) return;
    const problem = addEnvironment(id, { copyFrom: copyFrom || undefined });
    setAddError(problem);
    if (!problem) {
      setNewEnvId('');
      setCopyFrom('');
    }
  };
  /** Applied resources would be orphaned: their state stays behind in terraform-out/environments/<id>. */
  const appliedIn = (envId: string) => nodes.filter((n) => n.data.provisioningStatus?.[envId] === 'provisioned').length;

  const th = 'h-8 px-2 text-left text-[12.5px] font-normal text-fg-faint';

  return (
    <>
      {/* Environment profiles */}
      <Section title="Environments">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className={cn(th, 'pl-0')}>Name</th>
              <th className={th}>Region</th>
              <th className={th}>Port</th>
              <th
                className={cn(th, 'px-1')}
                title="Production environments get the stricter audit checks; the others get cost-saving suggestions"
              >
                Prod
              </th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {ENV_IDS.map((envId) => {
              const env = environments[envId];
              const isActive = activeEnv === envId;
              const applied = appliedIn(envId);
              if (confirmRemove === envId) {
                return (
                  <tr key={envId} className="border-b border-line last:border-b-0">
                    <td colSpan={5} className="py-1.5">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-fg-muted flex-1 min-w-0">
                          Remove <span className="font-mono text-fg">{envId}</span> and every override made for it?
                        </span>
                        <Button
                          variant="danger"
                          onClick={() => {
                            removeEnvironment(envId);
                            setConfirmRemove(null);
                          }}
                        >
                          Remove
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={envId} className="group border-b border-line last:border-b-0">
                  <td className="py-1.5 pr-2 max-w-0 w-full">
                    <button
                      type="button"
                      onClick={() => setActiveEnv(envId)}
                      title={`${env.name} (${envId})`}
                      className={cn(
                        'flex items-center gap-2 text-[14px] max-w-full',
                        isActive ? 'text-fg' : 'text-fg-muted hover:text-fg'
                      )}
                    >
                      <EnvDot color={env.color} />
                      <span className="truncate">{env.name}</span>
                    </button>
                  </td>
                  <td className="py-1.5 px-1 min-w-[112px]">
                    <select
                      value={env.region}
                      onChange={(e) => updateEnvironmentProfile(envId, { region: e.target.value })}
                      className={cn(monoFieldCls, 'py-1 text-[12.5px]')}
                    >
                      <option value="us-east-1">us-east-1</option>
                      <option value="us-west-2">us-west-2</option>
                      <option value="eu-west-1">eu-west-1</option>
                      <option value="ap-southeast-1">ap-southeast-1</option>
                    </select>
                  </td>
                  <td className="py-1.5 px-1 min-w-[72px]">
                    <input
                      type="number"
                      value={env.emulatorPort}
                      onChange={(e) => {
                        const p = Number(e.target.value) || 9297;
                        updateEnvironmentProfile(envId, {
                          emulatorPort: p,
                          emulatorEndpoint: `https://127.0.0.1:${p}`,
                        });
                      }}
                      className={cn(monoFieldCls, 'py-1 px-1.5 text-[12.5px]')}
                    />
                  </td>
                  <td className="py-1.5 px-1 text-center">
                    <Switch
                      checked={isProductionEnv(env)}
                      onChange={(next) => updateEnvironmentProfile(envId, { production: next })}
                      title={isProductionEnv(env) ? 'Treated as production' : 'Not production'}
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <IconButton
                      variant="danger"
                      disabled={ENV_IDS.length <= 1 || applied > 0}
                      onClick={() => setConfirmRemove(envId)}
                      title={
                        applied > 0
                          ? `${applied} resource${applied === 1 ? ' is' : 's are'} applied in ${envId}. Destroy it first.`
                          : ENV_IDS.length <= 1
                            ? 'A project needs at least one environment'
                            : `Remove ${envId}`
                      }
                      className="w-6 h-6"
                    >
                      <X className="w-3 h-3" />
                    </IconButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <form
          className="mt-3 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submitNewEnvironment();
          }}
        >
          <input
            type="text"
            value={newEnvId}
            onChange={(e) => {
              setNewEnvId(e.target.value);
              setAddError(null);
            }}
            placeholder="New environment, e.g. qa"
            aria-label="New environment name"
            spellCheck={false}
            className={monoFieldCls}
          />
          <select
            value={copyFrom}
            onChange={(e) => setCopyFrom(e.target.value)}
            aria-label="Start the new environment from"
            title="Start from base values, or copy another environment's region, usage and overrides"
            className={cn(fieldCls, 'w-[124px] shrink-0')}
          >
            <option value="">Base values</option>
            {ENV_IDS.map((id) => (
              <option key={id} value={id}>
                Copy {envShort(id)}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!newEnvId.trim()} className="shrink-0">
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </form>
        {addError && <p className="text-[12.5px] text-err mt-2">{addError}</p>}
      </Section>

      {/* Which resource ships where */}
      <Section title={`Resources · ${nodes.length}`}>
        <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className={cn(th, 'pl-0')}>Resource</th>
              {ENV_IDS.map((envId) => (
                <th key={envId} className={cn(th, 'text-center w-12 px-0')}>
                  {envShort(envId)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const isSelected = selectedNode?.id === node.id;
              return (
                <tr
                  key={node.id}
                  onClick={() => selectNode(node.id)}
                  className={cn(
                    'cursor-pointer border-b border-line last:border-b-0 transition-colors',
                    isSelected ? 'bg-raised' : 'hover:bg-raised/60'
                  )}
                >
                  <td className="py-1.5 pr-2">
                    <div className={cn('text-xs truncate max-w-[180px]', isSelected ? 'text-fg' : 'text-fg-muted')}>
                      {node.data.label}
                    </div>
                  </td>
                  {ENV_IDS.map((envId) => {
                    const enabled = node.data.envEnabled?.[envId] !== false;
                    const overridesCount = Object.keys(node.data.envOverrides?.[envId] || {}).length;
                    return (
                      <td key={envId} className="py-1 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleNodeInEnvironment(node.id, envId);
                          }}
                          title={
                            enabled
                              ? overridesCount > 0
                                ? `Deployed with ${overridesCount} override(s)`
                                : 'Deployed with base values'
                              : 'Skipped in this environment'
                          }
                          className="w-8 h-6 rounded inline-flex items-center justify-center gap-1 hover:bg-overlay"
                        >
                          <EnvDot color={environments[envId].color} hollow={!enabled} className="w-1.5 h-1.5" />
                          {enabled && overridesCount > 0 && (
                            <span className="text-[11.5px] font-mono text-accent">{overridesCount}</span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <p className="text-[12.5px] text-fg-faint mt-3">
          Click a dot to turn a resource on or off. Numbers count overridden parameters.
        </p>
      </Section>

      {/* Side-by-side parameter diff for the selected resource */}
      {selectedNode && svc && (
        <Section title={`Compare · ${selectedNode.data.label}`}>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full border-collapse font-mono text-[12.5px]">
              <thead>
                <tr className="border-b border-line">
                  <th className={cn(th, 'font-sans')}>Parameter</th>
                  {ENV_IDS.map((e) => (
                    <th key={e} className={cn(th, 'font-sans')}>
                      {envShort(e)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {svc.schema.map((field) => (
                  <tr key={field.key} className="border-b border-line last:border-b-0">
                    <td className="py-1.5 px-2 text-fg-muted truncate max-w-[110px]" title={field.key}>
                      {field.key}
                    </td>
                    {ENV_IDS.map((envId) => {
                      const val = resolveNodeConfigForEnv(selectedNode, envId)[field.key];
                      const isOver = isFieldOverriddenInEnv(selectedNode, envId, field.key);
                      return (
                        <td
                          key={envId}
                          className={cn('py-1.5 px-2 truncate max-w-[64px]', isOver ? 'text-accent' : 'text-fg-faint')}
                          title={String(val)}
                        >
                          {String(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
}

// ============================================================================
// 3. LIVE TERRAFORM HCL CODE VIEWER & COMPILER PANEL
// ============================================================================
const HCL_BLOCK = /^(resource|data|variable|output|provider|terraform|locals|module)\b/;

function HclLine({ line }: { line: string }) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return <span className="text-fg-faint">{line}</span>;
  }
  const block = line.match(HCL_BLOCK);
  if (block) {
    return (
      <>
        <span className="text-info">{block[0]}</span>
        {line.slice(block[0].length)}
      </>
    );
  }
  return <>{line || ' '}</>;
}

// Short labels so the AWS set fits; the full path is shown above the tabs
const TERRAFORM_FILES = [
  { id: 'main.tf', label: 'main' },
  { id: 'provider.tf', label: 'provider' },
  { id: 'backend', label: 'backend', awsOnly: true },
  { id: 'tfvars', label: 'tfvars' },
  { id: 'variables.tf', label: 'variables' },
  { id: 'outputs.tf', label: 'outputs' },
] as const;

type TerraformFile = (typeof TERRAFORM_FILES)[number]['id'];

function LiveTerraformPanel() {
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const setExportModalOpen = useCloudStore((s) => s.setExportModalOpen);

  // Preview either what runs locally or what Export for AWS writes
  const [target, setTarget] = useState<CompileTarget>('emulator');
  const [selectedFile, setSelectedFile] = useState<TerraformFile>('main.tf');
  const [copied, setCopied] = useState(false);

  const compiled = useMemo(() => {
    return compileTerraformForEnvironment(nodes, edges, environments[activeEnv], environments, target);
  }, [nodes, edges, activeEnv, environments, target]);

  const files = TERRAFORM_FILES.filter((f) => target === 'aws' || !('awsOnly' in f));
  const file = files.some((f) => f.id === selectedFile) ? selectedFile : 'main.tf';

  const codeContent = useMemo(() => {
    switch (file) {
      case 'backend':
        return `# ---- backend.tf ----\n\n${compiled.backendTf}\n# ---- backend.tfbackend ----\n\n${compiled.backendConfig}`;
      case 'main.tf':
        return compiled.mainTf;
      case 'provider.tf':
        return compiled.providerTf;
      case 'tfvars':
        return compiled.tfvars;
      case 'variables.tf':
        return compiled.variablesTf;
      case 'outputs.tf':
        return compiled.outputsTf;
    }
  }, [file, compiled]);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = codeContent.split('\n');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b border-line">
        <div className="px-4 pt-3 flex items-center gap-2">
          <Segmented
            value={target}
            onChange={setTarget}
            className="flex-1"
            options={[
              { value: 'emulator', label: 'Emulator' },
              { value: 'aws', label: 'AWS export' },
            ]}
          />
          {target === 'aws' && (
            <Button onClick={() => setExportModalOpen(true)} className="shrink-0">
              Export…
            </Button>
          )}
        </div>
        <div className="h-9 px-4 flex items-center justify-between">
          <span className="text-[12.5px] font-mono text-fg-faint truncate">
            {target === 'aws' ? AWS_EXPORT_DIR : 'terraform-out'}/environments/{activeEnv}/
            {file === 'tfvars' ? `${activeEnv}.tfvars` : file === 'backend' ? 'backend.tf, backend.tfbackend' : file}
          </span>
          <Button variant="ghost" onClick={handleCopy} className="-mr-2">
            {copied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="px-2 flex items-stretch overflow-x-auto">
          {files.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedFile(f.id)}
              className={cn(
                'relative h-8 px-1.5 text-[12.5px] font-mono shrink-0 transition-colors',
                file === f.id ? 'text-fg' : 'text-fg-faint hover:text-fg-muted'
              )}
            >
              {f.label}
              {file === f.id && <span className="absolute left-1.5 right-1.5 -bottom-px h-px bg-fg" />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-base py-3 font-mono text-[13px] leading-[1.7] select-text">
        <pre className="text-fg/90">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-10 pr-4 text-right text-fg-faint/60 select-none shrink-0 tabular-nums">{i + 1}</span>
              <span className="whitespace-pre pr-4">
                <HclLine line={line} />
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

// ============================================================================
// 4. AWS EMULATOR (https://github.com/aws/aws-emulator) COMMAND CENTER
// ============================================================================
function AwsEmulatorCommandCenter() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const refreshEmulatorStatuses = useCloudStore((s) => s.refreshEmulatorStatuses);

  const [artifactTab, setArtifactTab] = useState<'shell' | 'compose' | 'dockerfile'>('shell');
  const [copied, setCopied] = useState(false);

  const ENV_IDS = envIdsOf(environments);
  const envProfile = environments[activeEnv];
  const compiled = useMemo(
    () =>
      compileTerraformForEnvironment(nodes, edges, envProfile, environments),
    [nodes, edges, envProfile, environments]
  );

  const activeSnippet =
    artifactTab === 'shell'
      ? compiled.emulatorScriptSh
      : artifactTab === 'compose'
      ? compiled.dockerComposeYml
      : compiled.dockerfile;

  const copySnippet = () => {
    navigator.clipboard.writeText(activeSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Section>
        <RunnerConsole />
      </Section>

      <LambdaWatchSection />

      {/* Health of every environment's emulator port */}
      <Section
        title="Emulators"
        aside={
          <div className="flex items-center gap-1 -mr-2">
            <a
              href="https://github.com/aws/aws-emulator"
              target="_blank"
              rel="noreferrer"
              className="h-7 px-2 rounded-md text-xs text-fg-muted hover:text-fg hover:bg-raised flex items-center gap-1"
            >
              aws/aws-emulator <ExternalLink className="w-3 h-3" />
            </a>
            <IconButton onClick={() => refreshEmulatorStatuses()} title="Check ports">
              <RefreshCw className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        }
      >
        <div className="divide-y divide-line">
          {ENV_IDS.map((id) => {
            const env = environments[id];
            const isOnline = emulatorStatuses[env.emulatorPort]?.running;
            return (
              <div key={id} className="h-8 flex items-center gap-2.5 text-xs">
                <EnvDot color={env.color} />
                <span className={id === activeEnv ? 'text-fg' : 'text-fg-muted'}>{env.name}</span>
                <span className="font-mono text-[12.5px] text-fg-faint">:{env.emulatorPort}</span>
                <span className={cn('ml-auto flex items-center gap-1.5', isOnline ? 'text-fg-muted' : 'text-fg-faint')}>
                  <span className={cn('w-1.5 h-1.5 rounded-full', isOnline ? 'bg-ok' : 'bg-fg-faint/50')} />
                  {isOnline ? 'running' : 'stopped'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[12.5px] text-fg-faint mt-3">
          Each emulator serves HTTPS with a local CA in{' '}
          <span className="font-mono">~/.aws/emulator/&lt;port&gt;/</span>.
        </p>
      </Section>

      {/* Shell / compose / Dockerfile snippets */}
      <Section
        title="Setup files"
        aside={
          <Button variant="ghost" onClick={copySnippet} className="-mr-2">
            {copied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        }
      >
        <Segmented
          value={artifactTab}
          onChange={setArtifactTab}
          options={[
            { value: 'shell', label: `Shell env · ${envShort(activeEnv)}` },
            { value: 'compose', label: 'docker-compose' },
            { value: 'dockerfile', label: 'Dockerfile' },
          ]}
        />
        <pre className="mt-3 rounded-md border border-line bg-base p-3 font-mono text-[12.5px] leading-relaxed text-fg/90 select-text overflow-x-auto max-h-96">
          {activeSnippet}
        </pre>
      </Section>
    </>
  );
}
