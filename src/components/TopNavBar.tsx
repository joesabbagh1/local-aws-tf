import { useEffect, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import type { EnvironmentId } from '../types/cloud';
import {
  Cloud,
  LayoutGrid,
  Sparkles,
  Terminal,
  Trash2,
  Download,
  Check,
  Code2,
  Sliders,
  Layers,
  Undo2,
  Redo2,
  Upload,
  Play,
  Database,
  ShieldAlert,
  Loader2,
} from 'lucide-react';

const ENV_ORDER: EnvironmentId[] = ['dev', 'testing', 'staging', 'prod'];

export function TopNavBar() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const setActiveEnv = useCloudStore((s) => s.setActiveEnv);
  const targetLocalEmulator = useCloudStore((s) => s.targetLocalEmulator);
  const setTargetLocalEmulator = useCloudStore((s) => s.setTargetLocalEmulator);
  const nodes = useCloudStore((s) => s.nodes);
  const autoLayoutCanvas = useCloudStore((s) => s.autoLayoutCanvas);
  const clearCanvas = useCloudStore((s) => s.clearCanvas);
  const setTemplateModalOpen = useCloudStore((s) => s.setTemplateModalOpen);
  const setImportModalOpen = useCloudStore((s) => s.setImportModalOpen);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  const rightTab = useCloudStore((s) => s.rightTab);
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const refreshEmulatorStatuses = useCloudStore((s) => s.refreshEmulatorStatuses);
  const syncTerraformToDisk = useCloudStore((s) => s.syncTerraformToDisk);
  const runTerraformCommand = useCloudStore((s) => s.runTerraformCommand);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const undo = useCloudStore((s) => s.undo);
  const redo = useCloudStore((s) => s.redo);
  const pastCount = useCloudStore((s) => s.past.length);
  const futureCount = useCloudStore((s) => s.future.length);

  const [exportStatus, setExportStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    refreshEmulatorStatuses();
    // Auto-sync initial Terraform files to ./terraform-out on startup
    syncTerraformToDisk();
    const timer = setInterval(refreshEmulatorStatuses, 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentEnvProfile = environments[activeEnv];
  const currentPortStatus = emulatorStatuses[currentEnvProfile.emulatorPort];

  const handleExportAllEnvsToDisk = async () => {
    setExportStatus('saving');
    const res = await syncTerraformToDisk();
    if (res.ok) {
      setExportStatus('saved');
      setTimeout(() => setExportStatus('idle'), 3000);
    } else {
      setExportStatus('idle');
    }
  };

  const handleQuickApply = async () => {
    setRightTab('emulator');
    await runTerraformCommand('apply', activeEnv);
  };

  return (
    <header className="h-14 shrink-0 bg-[#0d1017] border-b border-slate-800/80 px-3.5 flex items-center justify-between gap-3 select-none z-30">
      {/* Brand Title */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
          <Cloud className="w-4 h-4 text-slate-950 stroke-[2.3]" />
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-xs font-bold tracking-tight text-white">
              LocalCloud Studio
            </h1>
            <span className="text-[9px] font-mono px-1.5 py-0.2 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 font-semibold">
              aws-emulator 2D
            </span>
          </div>
          <p className="text-[10px] text-slate-400 hidden xl:block">
            Visual AWS Canvas • Multi-Env Terraform & Live Emulator OS
          </p>
        </div>
      </div>

      {/* Multi-Environment Switcher (DEV / TESTING / STAGING / PROD) */}
      <div className="flex items-center gap-1 bg-[#141824] p-1 rounded-xl border border-slate-800">
        {ENV_ORDER.map((envId) => {
          const env = environments[envId];
          const isActive = activeEnv === envId;
          const activeNodeCount = nodes.filter(
            (n) => n.data.envEnabled?.[envId] !== false
          ).length;
          const portOnline = emulatorStatuses[env.emulatorPort]?.running;

          return (
            <button
              key={envId}
              type="button"
              onClick={() => setActiveEnv(envId)}
              className={`relative px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                isActive
                  ? 'bg-[#1f2637] text-white shadow-sm border border-slate-700/80'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: env.color,
                  boxShadow: isActive ? `0 0 8px ${env.color}` : undefined,
                }}
              />
              <span className="font-semibold text-[11px]">{env.shortLabel}</span>
              <span className="text-[10px] font-mono text-slate-400 hidden md:inline">
                :{env.emulatorPort}
              </span>
              <span
                className={`text-[9px] font-mono px-1 py-0.2 rounded ${
                  isActive
                    ? 'bg-slate-900/90 text-slate-200'
                    : 'bg-slate-800/60 text-slate-400'
                }`}
              >
                {activeNodeCount}
              </span>
              {portOnline && (
                <span
                  title={`Emulator online on port ${env.emulatorPort}`}
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping absolute top-1 right-1"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Right Action Bar */}
      <div className="flex items-center gap-1.5">
        {/* Undo / Redo */}
        <div className="flex items-center bg-[#141824] rounded-lg border border-slate-800 p-0.5">
          <button
            type="button"
            disabled={pastCount === 0}
            onClick={undo}
            title="Undo (Cmd+Z)"
            className="p-1.5 rounded text-slate-300 hover:text-white disabled:opacity-30 transition-opacity"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={futureCount === 0}
            onClick={redo}
            title="Redo (Cmd+Shift+Z)"
            className="p-1.5 rounded text-slate-300 hover:text-white disabled:opacity-30 transition-opacity"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Emulator Target Toggle */}
        <button
          type="button"
          onClick={() => setTargetLocalEmulator(!targetLocalEmulator)}
          title="Switch Terraform provider between Local AWS Emulator (127.0.0.1:9297+) and Production AWS"
          className={`px-2 py-1.5 rounded-lg text-[11px] font-medium border flex items-center gap-1.5 transition-all ${
            targetLocalEmulator
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15'
              : 'bg-slate-800/70 text-slate-300 border-slate-700 hover:bg-slate-800'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              currentPortStatus?.running
                ? 'bg-emerald-400'
                : targetLocalEmulator
                ? 'bg-amber-400'
                : 'bg-sky-400'
            }`}
          />
          <span className="font-mono">
            {targetLocalEmulator
              ? `:${currentEnvProfile.emulatorPort}`
              : currentEnvProfile.region}
          </span>
        </button>

        {/* Blueprints & Import HCL/JSON */}
        <button
          type="button"
          onClick={() => setTemplateModalOpen(true)}
          className="px-2 py-1.5 rounded-lg text-[11px] font-medium bg-[#141824] hover:bg-[#1c2233] text-slate-200 border border-slate-700/80 flex items-center gap-1 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden lg:inline">Blueprints</span>
        </button>

        <button
          type="button"
          onClick={() => setImportModalOpen(true)}
          title="Import existing Terraform .tf HCL or Save/Load Project JSON"
          className="px-2 py-1.5 rounded-lg text-[11px] font-medium bg-[#141824] hover:bg-[#1c2233] text-slate-200 border border-slate-700/80 flex items-center gap-1 transition-colors"
        >
          <Upload className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden lg:inline">Import / Save</span>
        </button>

        {/* Auto-Arrange & Clear */}
        <button
          type="button"
          onClick={autoLayoutCanvas}
          title="Auto-arrange canvas topology"
          className="p-1.5 rounded-lg bg-[#141824] hover:bg-[#1c2233] text-slate-300 border border-slate-700/80 transition-colors"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={clearCanvas}
          title="Clear canvas"
          className="p-1.5 rounded-lg bg-[#141824] hover:bg-rose-950/50 text-slate-400 hover:text-rose-300 border border-slate-700/80 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>

        {/* Drawer Mode Switchers */}
        <div className="flex items-center bg-[#141824] p-0.5 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => setRightTab('inspector')}
            title="Resource Config Inspector"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'inspector'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders className="w-3 h-3" />
            <span className="hidden 2xl:inline">Config</span>
          </button>
          <button
            type="button"
            onClick={() => setRightTab('env-matrix')}
            title="4-Environment Matrix & Diffs"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'env-matrix'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3 h-3" />
            <span className="hidden 2xl:inline">Matrix</span>
          </button>
          <button
            type="button"
            onClick={() => setRightTab('terraform')}
            title="Compiled Terraform HCL"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'terraform'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 className="w-3 h-3" />
            <span className="hidden 2xl:inline">HCL</span>
          </button>
          <button
            type="button"
            onClick={() => setRightTab('emulator')}
            title="AWS Emulator Runner & Terraform Apply Console"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'emulator'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3 h-3" />
            <span className="hidden 2xl:inline">Runner</span>
          </button>
          <button
            type="button"
            onClick={() => setRightTab('explorer')}
            title="Live Data-Plane Resource Explorer (S3, DynamoDB, SQS, Lambda)"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'explorer'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Database className="w-3 h-3" />
            <span className="hidden 2xl:inline">Data</span>
          </button>
          <button
            type="button"
            onClick={() => setRightTab('audit')}
            title="Architecture Linter & Multi-Env Cost Estimator"
            className={`px-2 py-1 rounded text-[11px] font-medium flex items-center gap-1 transition-colors ${
              rightTab === 'audit'
                ? 'bg-orange-500 text-slate-950 font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <ShieldAlert className="w-3 h-3" />
            <span className="hidden 2xl:inline">Cost & Audit</span>
          </button>
        </div>

        {/* One-Click Apply to Emulator */}
        <button
          type="button"
          disabled={isRunningCommand}
          onClick={handleQuickApply}
          title={`Run terraform apply for [${activeEnv.toUpperCase()}] against local AWS Emulator`}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 flex items-center gap-1 transition-all disabled:opacity-50"
        >
          {isRunningCommand ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5 fill-current" />
          )}
          <span>Apply {activeEnv.toUpperCase()}</span>
        </button>

        {/* Sync Terraform to Disk */}
        <button
          type="button"
          onClick={handleExportAllEnvsToDisk}
          className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-slate-950 shadow-md shadow-orange-500/15 flex items-center gap-1 transition-all"
        >
          {exportStatus === 'saved' ? (
            <>
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Synced</span>
            </>
          ) : (
            <>
              <Download className="w-3.5 h-3.5 stroke-[2.2]" />
              <span>Sync TF</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}
