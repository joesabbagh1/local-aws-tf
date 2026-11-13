import { useState, useMemo, type ReactNode } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import {
  compileTerraformForEnvironment,
  resolveNodeConfigForEnv,
  isFieldOverriddenInEnv,
  EXTRA_HCL_KEY,
} from '../utils/terraformCompiler';
import type { EnvironmentId, SchemaField } from '../types/cloud';
import { RunnerConsole } from './RunnerConsole';
import { ResourceExplorerPanel } from './ResourceExplorerPanel';
import { ArchitectureAuditPanel } from './ArchitectureAuditPanel';
import type { RightDrawerTab } from '../store/useCloudStore';
import { Copy, Check, RotateCcw, Trash2, Plus, X, ArrowRight, RefreshCw, ExternalLink } from 'lucide-react';
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

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

const DRAWER_TABS: { id: RightDrawerTab; label: string }[] = [
  { id: 'inspector', label: 'Inspect' },
  { id: 'env-matrix', label: 'Envs' },
  { id: 'terraform', label: 'Terraform' },
  { id: 'emulator', label: 'Run' },
  { id: 'explorer', label: 'Data' },
  { id: 'audit', label: 'Audit' },
];

const envShort = (envId: EnvironmentId) => (envId === 'testing' ? 'test' : envId);

export function RightWorkspaceDrawer() {
  const rightTab = useCloudStore((s) => s.rightTab);
  const setRightTab = useCloudStore((s) => s.setRightTab);

  return (
    <aside className="w-[400px] shrink-0 h-full bg-panel border-l border-line flex flex-col select-none">
      <nav className="h-10 shrink-0 px-2 border-b border-line flex items-stretch">
        {DRAWER_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setRightTab(id)}
            className={cn(
              'relative px-2.5 text-[13px] transition-colors',
              rightTab === id ? 'text-fg' : 'text-fg-muted hover:text-fg'
            )}
          >
            {label}
            {rightTab === id && <span className="absolute left-2.5 right-2.5 -bottom-px h-px bg-fg" />}
          </button>
        ))}
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

  if (selectedEdge) {
    const srcNode = nodes.find((n) => n.id === selectedEdge.source);
    const dstNode = nodes.find((n) => n.id === selectedEdge.target);

    return (
      <>
        <div className="px-4 py-4 border-b border-line flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-fg-muted">Connection</div>
            <div className="mt-1 flex items-center gap-2 text-[13px] font-medium text-fg min-w-0">
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
          </div>
        </Section>
      </>
    );
  }

  if (!selectedNode) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-[13px] text-fg-muted">Select a resource or connection to edit it.</p>
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
          <div className="text-[14px] font-medium text-fg truncate">{svc?.name || selectedNode.data.label}</div>
          <div className="text-[11px] font-mono text-fg-faint truncate mt-0.5">{svc?.terraformResourceType}</div>
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
            <div className="grid grid-cols-4 gap-1 w-full">
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
                      'h-7 px-1 rounded-md border text-xs inline-flex items-center justify-center gap-1 transition-colors',
                      enabled
                        ? 'border-line-strong bg-raised text-fg'
                        : 'border-line text-fg-faint hover:text-fg-muted'
                    )}
                  >
                    <EnvDot color={env.color} hollow={!enabled} className="w-1.5 h-1.5" />
                    {envShort(envId)}
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
        <p className="text-[11px] text-fg-faint mt-2 mb-4">
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
          className={cn(monoFieldCls, 'p-3 text-[11.5px] leading-relaxed resize-y')}
        />
        <p className="text-[11px] text-fg-faint mt-2">
          Added inside the <span className="font-mono">{svc?.terraformResourceType}</span> block as written, for{' '}
          {editScope === 'env' ? `${envShort(activeEnv)} only` : 'all environments'}. Don't repeat arguments the
          form already sets.
        </p>
      </Section>

      {/* Lambda handler source, zipped into artifacts/<name>.zip on every sync */}
      {selectedNode.data.serviceType === 'aws_lambda_function' && (
        <Section
          title="Handler code"
          aside={
            <span className="text-[11px] font-mono text-fg-faint">
              {String(resolvedConfig.handler || 'index.handler').split('.').slice(0, -1).join('.') || 'index'}.
              {String(resolvedConfig.runtime || 'nodejs20.x').startsWith('python') ? 'py' : 'mjs'}
            </span>
          }
        >
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
            className={cn(monoFieldCls, 'p-3 text-[11.5px] leading-relaxed resize-y')}
          />
          <p className="text-[11px] text-fg-faint mt-2">
            Shared by every environment. Zipped into{' '}
            <span className="font-mono">environments/&lt;env&gt;/artifacts/</span> on sync and apply.
          </p>
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
                <dd className="font-mono text-[11px] text-fg break-all select-text">{v}</dd>
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

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];
  const svc = selectedNode ? SERVICE_BY_TYPE[selectedNode.data.serviceType] : null;

  const th = 'h-8 px-2 text-left text-[11px] font-normal text-fg-faint';

  return (
    <>
      {/* Environment profiles */}
      <Section title="Environments">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className={cn(th, 'pl-0')}>Name</th>
              <th className={th}>Region</th>
              <th className={cn(th, 'pr-0')}>Emulator port</th>
            </tr>
          </thead>
          <tbody>
            {ENV_IDS.map((envId) => {
              const env = environments[envId];
              const isActive = activeEnv === envId;
              return (
                <tr key={envId} className="border-b border-line last:border-b-0">
                  <td className="py-1.5 pr-2">
                    <button
                      type="button"
                      onClick={() => setActiveEnv(envId)}
                      className={cn(
                        'flex items-center gap-2 text-[13px]',
                        isActive ? 'text-fg' : 'text-fg-muted hover:text-fg'
                      )}
                    >
                      <EnvDot color={env.color} />
                      {env.name}
                    </button>
                  </td>
                  <td className="py-1.5 px-2 w-[128px]">
                    <select
                      value={env.region}
                      onChange={(e) => updateEnvironmentProfile(envId, { region: e.target.value })}
                      className={cn(monoFieldCls, 'py-1 text-[11px]')}
                    >
                      <option value="us-east-1">us-east-1</option>
                      <option value="us-west-2">us-west-2</option>
                      <option value="eu-west-1">eu-west-1</option>
                      <option value="ap-southeast-1">ap-southeast-1</option>
                    </select>
                  </td>
                  <td className="py-1.5 pl-2 w-[88px]">
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
                      className={cn(monoFieldCls, 'py-1 text-[11px]')}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {/* Which resource ships where */}
      <Section title={`Resources · ${nodes.length}`}>
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
                            <span className="text-[10px] font-mono text-accent">{overridesCount}</span>
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
        <p className="text-[11px] text-fg-faint mt-3">
          Click a dot to turn a resource on or off. Numbers count overridden parameters.
        </p>
      </Section>

      {/* Side-by-side parameter diff for the selected resource */}
      {selectedNode && svc && (
        <Section title={`Compare · ${selectedNode.data.label}`}>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full border-collapse font-mono text-[11px]">
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

function LiveTerraformPanel() {
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const targetLocalEmulator = useCloudStore((s) => s.targetLocalEmulator);

  const [selectedFile, setSelectedFile] = useState<
    'main.tf' | 'provider.tf' | 'tfvars' | 'variables.tf' | 'outputs.tf'
  >('main.tf');
  const [copied, setCopied] = useState(false);

  const compiled = useMemo(() => {
    return compileTerraformForEnvironment(
      nodes,
      edges,
      environments[activeEnv],
      environments,
      targetLocalEmulator
    );
  }, [nodes, edges, activeEnv, environments, targetLocalEmulator]);

  const codeContent = useMemo(() => {
    switch (selectedFile) {
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
  }, [selectedFile, compiled]);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = codeContent.split('\n');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b border-line">
        <div className="h-9 px-4 flex items-center justify-between">
          <span className="text-[11px] font-mono text-fg-faint truncate">
            terraform-out/environments/{activeEnv}/{selectedFile === 'tfvars' ? `${activeEnv}.tfvars` : selectedFile}
          </span>
          <Button variant="ghost" onClick={handleCopy} className="-mr-2">
            {copied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="px-2 flex items-stretch overflow-x-auto">
          {(
            [
              { id: 'main.tf', label: 'main.tf' },
              { id: 'provider.tf', label: 'provider.tf' },
              { id: 'tfvars', label: 'tfvars' },
              { id: 'variables.tf', label: 'variables.tf' },
              { id: 'outputs.tf', label: 'outputs.tf' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedFile(f.id)}
              className={cn(
                'relative h-8 px-1.5 text-[11px] font-mono shrink-0 transition-colors',
                selectedFile === f.id ? 'text-fg' : 'text-fg-faint hover:text-fg-muted'
              )}
            >
              {f.label}
              {selectedFile === f.id && <span className="absolute left-1.5 right-1.5 -bottom-px h-px bg-fg" />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-base py-3 font-mono text-[11.5px] leading-[1.7] select-text">
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

  const envProfile = environments[activeEnv];
  const compiled = useMemo(
    () =>
      compileTerraformForEnvironment(
        nodes,
        edges,
        envProfile,
        environments,
        true
      ),
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
                <span className="font-mono text-[11px] text-fg-faint">:{env.emulatorPort}</span>
                <span className={cn('ml-auto flex items-center gap-1.5', isOnline ? 'text-fg-muted' : 'text-fg-faint')}>
                  <span className={cn('w-1.5 h-1.5 rounded-full', isOnline ? 'bg-ok' : 'bg-fg-faint/50')} />
                  {isOnline ? 'running' : 'stopped'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-fg-faint mt-3">
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
        <pre className="mt-3 rounded-md border border-line bg-base p-3 font-mono text-[11px] leading-relaxed text-fg/90 select-text overflow-x-auto max-h-96">
          {activeSnippet}
        </pre>
      </Section>
    </>
  );
}
