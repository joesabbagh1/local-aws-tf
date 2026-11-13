import { useEffect, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import type { EnvironmentId } from '../types/cloud';
import {
  LayoutGrid,
  Trash2,
  Check,
  Undo2,
  Redo2,
  Play,
  Loader2,
  RefreshCw,
  LayoutTemplate,
  FileInput,
} from 'lucide-react';
import { Button, IconButton, EnvDot, cn } from './ui';
import { planHasChanges } from '../utils/planSummary';

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
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const refreshEmulatorStatuses = useCloudStore((s) => s.refreshEmulatorStatuses);
  const syncTerraformToDisk = useCloudStore((s) => s.syncTerraformToDisk);
  const requestApply = useCloudStore((s) => s.requestApply);
  const loadProjectFromDisk = useCloudStore((s) => s.loadProjectFromDisk);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const runningCommand = useCloudStore((s) => s.runningCommand);
  const projectFile = useCloudStore((s) => s.projectFile);
  const hasPlanToApply = useCloudStore(
    (s) => s.pendingPlan?.envId === s.activeEnv && planHasChanges(s.pendingPlan)
  );
  const undo = useCloudStore((s) => s.undo);
  const redo = useCloudStore((s) => s.redo);
  const pastCount = useCloudStore((s) => s.past.length);
  const futureCount = useCloudStore((s) => s.future.length);

  const [exportStatus, setExportStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    refreshEmulatorStatuses();
    // The project file on disk wins over browser storage; then write its Terraform to ./terraform-out
    loadProjectFromDisk().finally(() => syncTerraformToDisk());
    const timer = setInterval(refreshEmulatorStatuses, 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentEnvProfile = environments[activeEnv];

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
    await requestApply(activeEnv);
  };

  return (
    <header className="h-12 shrink-0 bg-panel border-b border-line pl-4 pr-3 flex items-center gap-4 select-none z-30">
      {/* Brand */}
      <div className="flex items-center gap-2.5 shrink-0 w-[224px]">
        <div className="w-5 h-5 rounded-[5px] bg-accent flex items-center justify-center">
          <span className="w-2 h-2 rounded-[2px] bg-accent-ink" />
        </div>
        <span className="text-[13px] font-semibold tracking-tight text-fg">LocalCloud</span>
        <span className="text-[13px] text-fg-faint">Studio</span>
      </div>

      {/* Environment switcher */}
      <nav className="flex items-center h-full" aria-label="Environment">
        {ENV_ORDER.map((envId) => {
          const env = environments[envId];
          const isActive = activeEnv === envId;
          const activeNodeCount = nodes.filter((n) => n.data.envEnabled?.[envId] !== false).length;
          const portOnline = emulatorStatuses[env.emulatorPort]?.running;

          return (
            <button
              key={envId}
              type="button"
              onClick={() => setActiveEnv(envId)}
              title={`${env.name} · ${activeNodeCount} resources · emulator :${env.emulatorPort} ${
                portOnline ? 'running' : 'stopped'
              }`}
              className={cn(
                'relative h-full px-3 flex items-center gap-2 text-[13px] transition-colors',
                isActive ? 'text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              <EnvDot color={env.color} hollow={!portOnline} />
              <span>{envId === 'testing' ? 'test' : envId}</span>
              {isActive && <span className="absolute left-3 right-3 -bottom-px h-px bg-fg" />}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Where the canvas is saved */}
      {projectFile.file && (
        <span
          className="hidden xl:flex items-center gap-1.5 text-[11px] font-mono text-fg-faint"
          title={
            projectFile.state === 'error'
              ? `Could not save ./${projectFile.file}: ${projectFile.error}`
              : `The canvas is saved to ./${projectFile.file} as you edit`
          }
        >
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              projectFile.state === 'error' ? 'bg-err' : projectFile.state === 'saving' ? 'bg-warn' : 'bg-ok'
            )}
          />
          {projectFile.file}
        </span>
      )}

      {/* Canvas tools */}
      <div className="flex items-center gap-0.5">
        <IconButton disabled={pastCount === 0} onClick={undo} title="Undo (⌘Z)">
          <Undo2 className="w-4 h-4" />
        </IconButton>
        <IconButton disabled={futureCount === 0} onClick={redo} title="Redo (⌘⇧Z)">
          <Redo2 className="w-4 h-4" />
        </IconButton>
        <IconButton onClick={autoLayoutCanvas} title="Auto-arrange canvas">
          <LayoutGrid className="w-4 h-4" />
        </IconButton>
        <IconButton variant="danger" onClick={clearCanvas} title="Clear canvas">
          <Trash2 className="w-4 h-4" />
        </IconButton>
      </div>

      <span className="w-px h-5 bg-line" />

      <div className="flex items-center gap-1">
        <Button variant="ghost" onClick={() => setTemplateModalOpen(true)}>
          <LayoutTemplate className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Blueprints</span>
        </Button>
        <Button
          variant="ghost"
          onClick={() => setImportModalOpen(true)}
          title="Import Terraform, or save / load a project file"
        >
          <FileInput className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Import</span>
        </Button>
      </div>

      <span className="w-px h-5 bg-line" />

      <div className="flex items-center gap-2">
        {/* Provider target: local emulator or real AWS */}
        <button
          type="button"
          onClick={() => setTargetLocalEmulator(!targetLocalEmulator)}
          title="Switch the Terraform provider between the local emulator and real AWS"
          className="h-7 px-2.5 rounded-md text-xs font-mono text-fg-muted hover:text-fg hover:bg-raised flex items-center gap-1.5 transition-colors"
        >
          <span className="font-sans text-fg-faint">target</span>
          {targetLocalEmulator ? `127.0.0.1:${currentEnvProfile.emulatorPort}` : `aws ${currentEnvProfile.region}`}
        </button>

        <Button onClick={handleExportAllEnvsToDisk} title="Write Terraform for every environment to ./terraform-out">
          {exportStatus === 'saved' ? (
            <Check className="w-3.5 h-3.5 text-ok" />
          ) : (
            <RefreshCw className={cn('w-3.5 h-3.5', exportStatus === 'saving' && 'animate-spin')} />
          )}
          {exportStatus === 'saved' ? 'Synced' : 'Sync'}
        </Button>

        <Button
          variant="primary"
          disabled={isRunningCommand}
          onClick={handleQuickApply}
          title={
            hasPlanToApply
              ? `Apply the reviewed plan to ${activeEnv}`
              : `Plan ${activeEnv} and review the changes before anything is applied`
          }
        >
          {isRunningCommand ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3 h-3 fill-current" />
          )}
          {runningCommand === 'plan' ? 'Planning' : runningCommand === 'apply' ? 'Applying' : 'Apply'} {activeEnv}
        </Button>
      </div>
    </header>
  );
}
