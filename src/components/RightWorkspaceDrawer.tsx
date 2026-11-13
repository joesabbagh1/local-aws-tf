import { useState, useMemo } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { SERVICE_BY_TYPE } from '../data/awsCatalog';
import {
  compileTerraformForEnvironment,
  resolveNodeConfigForEnv,
  isFieldOverriddenInEnv,
} from '../utils/terraformCompiler';
import type { EnvironmentId, SchemaField } from '../types/cloud';
import { AwsServiceIcon } from './AwsServiceIcon';
import { RunnerConsole } from './RunnerConsole';
import { ResourceExplorerPanel } from './ResourceExplorerPanel';
import { ArchitectureAuditPanel } from './ArchitectureAuditPanel';
import type { RightDrawerTab } from '../store/useCloudStore';
import {
  Sliders,
  Code2,
  Layers,
  Terminal,
  Copy,
  Check,
  RotateCcw,
  Trash2,
  Sparkles,
  Plus,
  X,
  ArrowRight,
  RefreshCw,
  ShieldCheck,
  ExternalLink,
  Database,
  ShieldAlert,
  FileCode,
  Radio,
} from 'lucide-react';

const ENV_IDS: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

const DRAWER_TABS: { id: RightDrawerTab; label: string; icon: typeof Sliders; tone: string }[] = [
  { id: 'inspector', label: 'Inspect', icon: Sliders, tone: 'text-orange-400' },
  { id: 'env-matrix', label: 'Envs', icon: Layers, tone: 'text-purple-400' },
  { id: 'terraform', label: 'HCL', icon: Code2, tone: 'text-sky-400' },
  { id: 'emulator', label: 'Runner', icon: Terminal, tone: 'text-emerald-400' },
  { id: 'explorer', label: 'Data', icon: Database, tone: 'text-teal-300' },
  { id: 'audit', label: 'Audit', icon: ShieldAlert, tone: 'text-rose-300' },
];

export function RightWorkspaceDrawer() {
  const rightTab = useCloudStore((s) => s.rightTab);
  const setRightTab = useCloudStore((s) => s.setRightTab);

  return (
    <aside className="w-[460px] shrink-0 h-full bg-[#0d1017] border-l border-slate-800/80 flex flex-col select-none">
      {/* Top Sub-Tab Bar */}
      <div className="px-2 pt-2.5 pb-2 border-b border-slate-800/80 grid grid-cols-6 gap-0.5 bg-[#11141d]/70">
        {DRAWER_TABS.map(({ id, label, icon: Icon, tone }) => (
          <button
            key={id}
            type="button"
            onClick={() => setRightTab(id)}
            className={`py-1.5 rounded-lg text-[10.5px] font-medium flex flex-col items-center justify-center gap-0.5 transition-all ${
              rightTab === id
                ? 'bg-[#1c2233] text-white border border-slate-700/80 shadow-sm'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 ${tone}`} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
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
      <div className="p-4 space-y-5">
        <div className="p-3.5 rounded-xl bg-[#141824] border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-orange-500/15 text-orange-400">
              Connection Inspector
            </span>
            <button
              type="button"
              onClick={() => deleteEdge(selectedEdge.id)}
              className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove Wire
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold text-white pt-1">
            <span className="truncate">{srcNode?.data.label || selectedEdge.source}</span>
            <ArrowRight className="w-3.5 h-3.5 text-orange-400 shrink-0" />
            <span className="truncate">{dstNode?.data.label || selectedEdge.target}</span>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              Relationship / Terraform Wiring Type
            </label>
            <select
              value={selectedEdge.data?.relationshipType || 'data_flow'}
              onChange={(e) =>
                updateEdgeData(selectedEdge.id, {
                  relationshipType: e.target.value as any,
                })
              }
              className="w-full bg-[#141824] border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-orange-500"
            >
              <option value="event_trigger">Event Trigger (Event Source Mapping / API Route)</option>
              <option value="iam_grant">IAM Policy Grant & Data Access</option>
              <option value="target_route">Load Balancer / CDN Origin Target</option>
              <option value="network_attachment">VPC / Subnet / Security Group Placement</option>
              <option value="data_flow">Service-to-Service Data Connection</option>
              <option value="depends_on">Explicit Terraform depends_on</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1">
              Edge Label / Route Key (e.g. ANY /orders/*)
            </label>
            <input
              type="text"
              value={selectedEdge.data?.label || ''}
              onChange={(e) => updateEdgeData(selectedEdge.id, { label: e.target.value })}
              className="w-full bg-[#141824] border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>
      </div>
    );
  }

  if (!selectedNode) {
    return (
      <div className="p-6 text-center space-y-3">
        <div className="w-11 h-11 rounded-xl bg-slate-800/70 border border-slate-700/60 flex items-center justify-center mx-auto text-slate-400">
          <Sliders className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h3 className="text-xs font-semibold text-slate-200">
            Select Any Resource or Wire on the Canvas
          </h3>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Click a node to inspect and configure its AWS parameters, toggle availability across{' '}
            <span className="text-sky-400 font-mono">dev</span>,{' '}
            <span className="text-purple-400 font-mono">testing</span>,{' '}
            <span className="text-amber-400 font-mono">staging</span>, and{' '}
            <span className="text-emerald-400 font-mono">prod</span>, or customize environment-specific overrides.
          </p>
        </div>
      </div>
    );
  }

  const svc = SERVICE_BY_TYPE[selectedNode.data.serviceType];
  const resolvedConfig = resolveNodeConfigForEnv(selectedNode, activeEnv);
  const envOverridesCount = Object.keys(
    selectedNode.data.envOverrides?.[activeEnv] || {}
  ).length;
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

  return (
    <div className="p-4 space-y-5">
      {/* Node Header Card */}
      <div className="p-3.5 rounded-xl bg-[#141824] border border-slate-800/90 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border"
              style={{
                backgroundColor: `${svc?.color || '#f97316'}18`,
                borderColor: `${svc?.color || '#f97316'}45`,
                color: svc?.color || '#f97316',
              }}
            >
              <AwsServiceIcon iconName={svc?.iconName || 'Server'} className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                  {svc?.terraformResourceType}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                  aws-emulator
                </span>
              </div>
              <h2 className="text-sm font-bold text-white truncate mt-1">
                {svc?.name || selectedNode.data.label}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => duplicateNode(selectedNode.id)}
              title="Duplicate Node"
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => deleteNode(selectedNode.id)}
              title="Delete Node"
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-rose-950/80 text-slate-300 hover:text-rose-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          {svc?.description}
        </p>

        {/* Display Label & Terraform Identifier */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
              Display Label
            </label>
            <input
              type="text"
              value={selectedNode.data.label}
              onChange={(e) =>
                updateNodeMetadata(selectedNode.id, { label: e.target.value })
              }
              className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
              Terraform Resource ID
            </label>
            <input
              type="text"
              value={selectedNode.data.resourceName}
              onChange={(e) =>
                updateNodeMetadata(selectedNode.id, {
                  resourceName: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'),
                })
              }
              className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs font-mono text-orange-300 focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>
      </div>

      {/* Environment Presence Toggles (Dev, Testing, Staging, Prod) */}
      <div className="p-3 rounded-xl bg-[#141824] border border-slate-800/90 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-200">
            Deploy Resource in Environments
          </span>
          <span className="text-[10px] text-slate-400">Click to toggle</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {ENV_IDS.map((envId) => {
            const env = environments[envId];
            const enabled = selectedNode.data.envEnabled?.[envId] !== false;
            return (
              <button
                key={envId}
                type="button"
                onClick={() => toggleNodeInEnvironment(selectedNode.id, envId)}
                className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                  enabled
                    ? 'bg-slate-800/90 text-white border-slate-600'
                    : 'bg-slate-900/40 text-slate-500 border-slate-800/60 line-through'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: enabled ? env.color : '#475569',
                  }}
                />
                <span>{env.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Edit Scope Selector: Override for Active Environment vs Shared Base Config */}
      <div className="p-3 rounded-xl bg-[#141824] border border-slate-800/90 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            Configuration Scope
          </span>
          {envOverridesCount > 0 && (
            <button
              type="button"
              onClick={() => resetNodeEnvOverride(selectedNode.id, activeEnv)}
              className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Reset {envOverridesCount} {activeEnv.toUpperCase()} override(s)
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5 bg-[#0d1017] p-1 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => setEditScope('env')}
            className={`py-1.5 px-2.5 rounded-md text-[11px] font-medium transition-all flex items-center justify-center gap-1.5 ${
              editScope === 'env'
                ? 'bg-[#1f2637] text-white border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: currentEnvProfile.color }}
            />
            <span>{activeEnv.toUpperCase()} Override</span>
          </button>

          <button
            type="button"
            onClick={() => setEditScope('base')}
            className={`py-1.5 px-2.5 rounded-md text-[11px] font-medium transition-all flex items-center justify-center gap-1.5 ${
              editScope === 'base'
                ? 'bg-[#1f2637] text-white border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>Shared Base Default</span>
          </button>
        </div>

        <p className="text-[10px] text-slate-400">
          {editScope === 'env' ? (
            <>
              Changes below apply specifically to{' '}
              <strong className="text-white">{currentEnvProfile.name}</strong> (
              <code className="text-amber-300">{activeEnv}.tfvars</code>).
            </>
          ) : (
            <>
              Changes below update the shared base configuration inherited by all environments without an override.
            </>
          )}
        </p>
      </div>

      {/* Dynamic Service Schema Fields */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Service Parameters ({svc?.schema.length || 0})
          </h3>
          <span className="text-[10px] font-mono text-slate-400">
            Viewing: {activeEnv.toUpperCase()}
          </span>
        </div>

        <div className="space-y-3">
          {(svc?.schema || []).map((field) => {
            const val =
              editScope === 'base'
                ? selectedNode.data.baseConfig?.[field.key] ?? field.defaultValue
                : resolvedConfig[field.key] ?? field.defaultValue;
            const isOverridden = isFieldOverriddenInEnv(
              selectedNode,
              activeEnv,
              field.key
            );

            return (
              <div
                key={field.key}
                className={`p-3 rounded-xl border transition-colors ${
                  isOverridden
                    ? 'bg-amber-500/5 border-amber-500/35'
                    : 'bg-[#141824] border-slate-800/80'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <label className="text-xs font-medium text-slate-200 truncate">
                      {field.label}
                    </label>
                    {isOverridden && (
                      <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        {activeEnv.toUpperCase()} override
                      </span>
                    )}
                  </div>

                  {isOverridden && (
                    <button
                      type="button"
                      title="Revert to shared base value"
                      onClick={() =>
                        resetNodeEnvOverride(selectedNode.id, activeEnv, field.key)
                      }
                      className="text-[10px] text-slate-400 hover:text-amber-300 flex items-center gap-0.5 shrink-0"
                    >
                      <RotateCcw className="w-2.5 h-2.5" />
                      <span>Revert</span>
                    </button>
                  )}
                </div>

                {/* Input Control by FieldType */}
                {field.type === 'boolean' ? (
                  <label className="flex items-center justify-between cursor-pointer pt-0.5">
                    <span className="text-[11px] font-mono text-slate-400">
                      {field.key} = {Boolean(val) ? 'true' : 'false'}
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(val)}
                      onChange={(e) => handleFieldValueChange(field, e.target.checked)}
                      className="w-4 h-4 accent-orange-500 rounded cursor-pointer"
                    />
                  </label>
                ) : field.type === 'select' ? (
                  <select
                    value={String(val ?? '')}
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
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
                    onChange={(e) =>
                      handleFieldValueChange(field, Number(e.target.value))
                    }
                    className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
                  />
                ) : field.type === 'json' ? (
                  <textarea
                    rows={2}
                    value={
                      typeof val === 'string' ? val : JSON.stringify(val, null, 2)
                    }
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-emerald-300 font-mono focus:outline-none focus:border-orange-500"
                  />
                ) : (
                  <input
                    type="text"
                    value={String(val ?? '')}
                    onChange={(e) => handleFieldValueChange(field, e.target.value)}
                    className="w-full bg-[#0d1017] border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
                  />
                )}

                {field.description && (
                  <p className="text-[10px] text-slate-400 mt-1">
                    {field.description}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Lambda handler source, zipped into artifacts/<name>.zip on every sync */}
      {selectedNode.data.serviceType === 'aws_lambda_function' && (
        <div className="p-3 rounded-xl bg-[#141824] border border-slate-800/90 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-orange-400" />
              Handler code
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              {String(resolvedConfig.handler || 'index.handler').split('.').slice(0, -1).join('.') || 'index'}.
              {String(resolvedConfig.runtime || 'nodejs20.x').startsWith('python') ? 'py' : 'mjs'}
            </span>
          </div>
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
            className="w-full bg-[#080a0f] border border-slate-700/80 rounded-lg p-2.5 text-[11px] leading-relaxed text-emerald-200 font-mono focus:outline-none focus:border-orange-500"
          />
          <p className="text-[10px] text-slate-400">
            Shared by every environment. Packaged on Sync TF / Apply into{' '}
            <code className="text-slate-300">environments/&lt;env&gt;/artifacts/</code>.
          </p>
        </div>
      )}

      {/* Live outputs captured after terraform apply */}
      {selectedNode.data.provisionedOutputs?.[activeEnv] && (
        <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/25 space-y-1.5">
          <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5" />
            Live in {activeEnv.toUpperCase()}
          </span>
          {Object.entries(selectedNode.data.provisionedOutputs[activeEnv]!).map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 text-[10.5px]">
              <span className="text-slate-400 shrink-0">{k}</span>
              <code className="text-slate-100 font-mono break-all text-right select-text">{v}</code>
            </div>
          ))}
        </div>
      )}

      {/* Resource Tags Editor */}
      <div className="p-3 rounded-xl bg-[#141824] border border-slate-800/90 space-y-2.5">
        <span className="text-xs font-semibold text-slate-200 block">
          Resource AWS Tags
        </span>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(selectedNode.data.tags || {}).map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md bg-[#0d1017] border border-slate-700 text-slate-200"
            >
              <span className="text-orange-400">{k}:</span> {v}
              <button
                type="button"
                onClick={() => removeTag(k)}
                className="text-slate-500 hover:text-rose-400 ml-0.5"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <input
            type="text"
            placeholder="Tag key"
            value={newTagKey}
            onChange={(e) => setNewTagKey(e.target.value)}
            className="w-1/2 bg-[#0d1017] border border-slate-700/80 rounded-lg px-2 py-1 text-xs text-white font-mono"
          />
          <input
            type="text"
            placeholder="Tag value"
            value={newTagVal}
            onChange={(e) => setNewTagVal(e.target.value)}
            className="w-1/2 bg-[#0d1017] border border-slate-700/80 rounded-lg px-2 py-1 text-xs text-white font-mono"
          />
          <button
            type="button"
            onClick={addTag}
            className="p-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-slate-950 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
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

  return (
    <div className="p-4 space-y-5">
      {/* Environment Profiles Overview & Port Allocation */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Simultaneous Environment Profiles
          </h3>
          <span className="text-[10px] font-mono text-slate-400">
            Isolated Ports & Regions
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {ENV_IDS.map((envId) => {
            const env = environments[envId];
            const isActive = activeEnv === envId;
            return (
              <div
                key={envId}
                onClick={() => setActiveEnv(envId)}
                className={`p-3 rounded-xl border cursor-pointer transition-all space-y-2 ${
                  isActive
                    ? 'bg-[#181e2e] border-orange-500/60 shadow-md'
                    : 'bg-[#141824] border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: env.color }}
                    />
                    <span className="text-xs font-bold text-white">
                      {env.name}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-300">
                    :{env.emulatorPort}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <div>
                    <label className="block text-[9px] uppercase text-slate-400">
                      AWS Region
                    </label>
                    <select
                      value={env.region}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        updateEnvironmentProfile(envId, { region: e.target.value })
                      }
                      className="w-full mt-0.5 bg-[#0d1017] border border-slate-700/80 rounded px-1.5 py-1 text-[10px] font-mono text-slate-200"
                    >
                      <option value="us-east-1">us-east-1</option>
                      <option value="us-west-2">us-west-2</option>
                      <option value="eu-west-1">eu-west-1</option>
                      <option value="ap-southeast-1">ap-southeast-1</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[9px] uppercase text-slate-400">
                      Emulator Port
                    </label>
                    <input
                      type="number"
                      value={env.emulatorPort}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const p = Number(e.target.value) || 9297;
                        updateEnvironmentProfile(envId, {
                          emulatorPort: p,
                          emulatorEndpoint: `https://127.0.0.1:${p}`,
                        });
                      }}
                      className="w-full mt-0.5 bg-[#0d1017] border border-slate-700/80 rounded px-1.5 py-1 text-[10px] font-mono text-orange-300"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Resource Availability Matrix Table across all 4 Environments */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
          Resource Topology Matrix ({nodes.length} Nodes)
        </h3>
        <div className="rounded-xl border border-slate-800 overflow-hidden bg-[#141824]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-[#0d1017] text-[10px] font-mono uppercase text-slate-400">
                <th className="py-2 px-2.5">Resource</th>
                <th className="py-2 px-1.5 text-center text-sky-400">DEV</th>
                <th className="py-2 px-1.5 text-center text-purple-400">TEST</th>
                <th className="py-2 px-1.5 text-center text-amber-400">STG</th>
                <th className="py-2 px-1.5 text-center text-emerald-400">PROD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {nodes.map((node) => {
                const isSelected = selectedNode?.id === node.id;
                return (
                  <tr
                    key={node.id}
                    onClick={() => selectNode(node.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-orange-500/10' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <td className="py-2 px-2.5">
                      <div className="font-medium text-slate-200 truncate max-w-[175px]">
                        {node.data.label}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 truncate max-w-[175px]">
                        {node.data.serviceType}
                      </div>
                    </td>
                    {ENV_IDS.map((envId) => {
                      const enabled = node.data.envEnabled?.[envId] !== false;
                      const overridesCount = Object.keys(
                        node.data.envOverrides?.[envId] || {}
                      ).length;
                      return (
                        <td key={envId} className="py-2 px-1.5 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleNodeInEnvironment(node.id, envId);
                            }}
                            className={`w-6 h-6 rounded-md text-[10px] font-mono font-bold inline-flex items-center justify-center border transition-all ${
                              enabled
                                ? overridesCount > 0
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-slate-900 text-slate-600 border-slate-800'
                            }`}
                            title={
                              enabled
                                ? overridesCount > 0
                                  ? `Enabled with ${overridesCount} override(s)`
                                  : 'Enabled (Base defaults)'
                                : 'Disabled in this environment'
                            }
                          >
                            {enabled ? (overridesCount > 0 ? `${overridesCount}*` : '✓') : '—'}
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
      </div>

      {/* Selected Resource Side-by-Side Parameter Diff Table */}
      {selectedNode && svc && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              4-Env Parameter Diff: {selectedNode.data.label}
            </h3>
          </div>
          <div className="rounded-xl border border-slate-800 overflow-x-auto bg-[#141824]">
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0d1017] text-[10px] font-mono text-slate-400">
                  <th className="py-2 px-2">Parameter</th>
                  {ENV_IDS.map((e) => (
                    <th key={e} className="py-2 px-2 uppercase">
                      {e}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-[10px]">
                {svc.schema.map((field) => (
                  <tr key={field.key}>
                    <td className="py-2 px-2 font-sans text-[11px] text-slate-300 font-medium">
                      {field.key}
                    </td>
                    {ENV_IDS.map((envId) => {
                      const val = resolveNodeConfigForEnv(selectedNode, envId)[field.key];
                      const isOver = isFieldOverriddenInEnv(
                        selectedNode,
                        envId,
                        field.key
                      );
                      return (
                        <td
                          key={envId}
                          className={`py-2 px-2 truncate max-w-[85px] ${
                            isOver
                              ? 'text-amber-300 font-semibold bg-amber-500/10'
                              : 'text-slate-400'
                          }`}
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
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 3. LIVE TERRAFORM HCL CODE VIEWER & COMPILER PANEL
// ============================================================================
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

  return (
    <div className="flex flex-col h-full">
      {/* File Switcher Bar */}
      <div className="p-3 border-b border-slate-800/80 bg-[#11141d] space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: environments[activeEnv].color }}
            />
            <span className="text-xs font-bold text-white">
              environments/{activeEnv}/
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1.5 transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span>Copied HCL</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy File</span>
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
          {(
            [
              { id: 'main.tf', label: 'main.tf' },
              { id: 'provider.tf', label: 'provider.tf' },
              { id: 'tfvars', label: `${activeEnv}.tfvars` },
              { id: 'variables.tf', label: 'variables.tf' },
              { id: 'outputs.tf', label: 'outputs.tf' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedFile(f.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-colors shrink-0 ${
                selectedFile === f.id
                  ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40 font-semibold'
                  : 'bg-[#141824] text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Code Viewer */}
      <div className="flex-1 overflow-auto p-3.5 bg-[#080a0f] font-mono text-[11px] leading-relaxed select-text">
        <pre className="text-slate-200 whitespace-pre overflow-x-auto">
          {codeContent}
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
    <div className="p-4 space-y-4">
      <RunnerConsole />

      {/* Official AWS Emulator Banner */}
      <div className="p-3.5 rounded-xl bg-gradient-to-br from-[#141a29] to-[#11141d] border border-slate-800 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold text-white">
              AWS Emulator Integration
            </h3>
          </div>
          <a
            href="https://github.com/aws/aws-emulator"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] font-mono text-orange-400 hover:underline flex items-center gap-1"
          >
            <span>aws/aws-emulator</span>
            <ExternalLink className="w-2.5 h-2.5" />
          </a>
        </div>

        <p className="text-[11px] text-slate-300 leading-relaxed">
          AWS Emulator serves a local HTTPS endpoint per environment (default port{' '}
          <code className="text-orange-300">9297</code>) with SigV4 credentials and a local CA certificate at{' '}
          <code className="text-emerald-300">~/.aws/emulator/&lt;port&gt;/</code>.
        </p>

        {/* Live Health Status across all 4 environment ports */}
        <div className="pt-1 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span>Multi-Env Emulator Endpoints (`/__admin/health`)</span>
            <button
              type="button"
              onClick={() => refreshEmulatorStatuses()}
              className="text-slate-300 hover:text-white flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Check Ports
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {ENV_IDS.map((id) => {
              const env = environments[id];
              const st = emulatorStatuses[env.emulatorPort];
              const isOnline = st?.running;
              return (
                <div
                  key={id}
                  className="px-2.5 py-1.5 rounded-lg bg-[#0d1017] border border-slate-800 flex items-center justify-between text-[11px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isOnline ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                    <span className="font-semibold text-slate-200">
                      {env.shortLabel}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      :{env.emulatorPort}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] font-mono ${
                      isOnline ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    {isOnline ? 'OK (200)' : 'Standby'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Script & Container Switcher */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 bg-[#141824] p-1 rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => setArtifactTab('shell')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                artifactTab === 'shell'
                  ? 'bg-orange-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              SDK & CLI Env ({activeEnv})
            </button>
            <button
              type="button"
              onClick={() => setArtifactTab('compose')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                artifactTab === 'compose'
                  ? 'bg-orange-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              4-Env Docker Compose
            </button>
            <button
              type="button"
              onClick={() => setArtifactTab('dockerfile')}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                artifactTab === 'dockerfile'
                  ? 'bg-orange-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Dockerfile
            </button>
          </div>

          <button
            type="button"
            onClick={copySnippet}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#080a0f] p-3 font-mono text-[10.5px] leading-relaxed select-text overflow-x-auto">
          <pre className="text-slate-200 whitespace-pre">{activeSnippet}</pre>
        </div>
      </div>
    </div>
  );
}
