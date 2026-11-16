import { useEffect, useState } from 'react';
import { useCloudStore, type ActiveProject } from '../store/useCloudStore';
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
  FileOutput,
  FolderPlus,
  TriangleAlert,
} from 'lucide-react';
import { Button, IconButton, EnvDot, Segmented, cn, fieldCls } from './ui';
import { planHasChanges } from '../utils/planSummary';
import { envIdsOf, envLabel } from '../utils/environments';

export function TopNavBar() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const setActiveEnv = useCloudStore((s) => s.setActiveEnv);
  const nodes = useCloudStore((s) => s.nodes);
  const view = useCloudStore((s) => s.view);
  const setView = useCloudStore((s) => s.setView);
  const autoLayoutCanvas = useCloudStore((s) => s.autoLayoutCanvas);
  const clearCanvas = useCloudStore((s) => s.clearCanvas);
  const setTemplateModalOpen = useCloudStore((s) => s.setTemplateModalOpen);
  const setImportModalOpen = useCloudStore((s) => s.setImportModalOpen);
  const setExportModalOpen = useCloudStore((s) => s.setExportModalOpen);
  const setRightTab = useCloudStore((s) => s.setRightTab);
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const refreshEmulatorStatuses = useCloudStore((s) => s.refreshEmulatorStatuses);
  const syncTerraformToDisk = useCloudStore((s) => s.syncTerraformToDisk);
  const requestApply = useCloudStore((s) => s.requestApply);
  const loadProjectFromDisk = useCloudStore((s) => s.loadProjectFromDisk);
  const syncStatusFromState = useCloudStore((s) => s.syncStatusFromState);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const runningCommand = useCloudStore((s) => s.runningCommand);
  const projectFile = useCloudStore((s) => s.projectFile);
  const activeProject = useCloudStore((s) => s.activeProject);
  const projectVersion = useCloudStore((s) => s.projectVersion);
  const projectConflict = useCloudStore((s) => s.projectConflict);
  const openProject = useCloudStore((s) => s.openProject);
  const createProject = useCloudStore((s) => s.createProject);

  const [projects, setProjects] = useState<ActiveProject[]>([]);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDir, setNewProjectDir] = useState('');
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    // The backend's head version wins over browser storage; then write its Terraform to ./terraform-out
    // and read what each environment actually has from its Terraform state
    loadProjectFromDisk().finally(() => {
      syncTerraformToDisk();
      syncStatusFromState();
    });
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setProjects(d.projects || []);
      })
      .catch(() => {});
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

  const handleCreateProject = async () => {
    setCreating(true);
    setNewProjectError(null);
    const res = await createProject(newProjectName.trim() || 'project', newProjectDir.trim());
    if (!res.ok) {
      setNewProjectError(res.error || 'Could not create the project');
      setCreating(false);
    }
  };

  return (
    <>
    <header className="h-12 shrink-0 bg-panel border-b border-line pl-4 pr-3 flex items-center gap-3 2xl:gap-4 select-none z-30">
      {/* Brand */}
      <div className="flex items-center gap-2.5 shrink-0 2xl:w-[224px]">
        <div className="w-5 h-5 rounded-[5px] bg-accent flex items-center justify-center">
          <span className="w-2 h-2 rounded-[2px] bg-accent-ink" />
        </div>
        <span className="text-[14px] font-semibold tracking-tight text-fg">LocalCloud</span>
        <span className="text-[14px] text-fg-faint">Studio</span>
      </div>

      {/* Project switcher: designs live in the backend's database */}
      <div className="flex items-center gap-1 shrink-0">
        <select
          aria-label="Project"
          value={activeProject?.id ?? ''}
          onChange={(e) => e.target.value && openProject(e.target.value)}
          disabled={projects.length === 0}
          className="h-7 px-1.5 text-[12.5px] bg-panel border border-line rounded-md text-fg max-w-[150px] 2xl:max-w-[200px] truncate"
          title={activeProject ? `${activeProject.name} — ${activeProject.working_dir}` : 'No projects yet'}
        >
          {projects.length === 0 && <option value="">{activeProject?.name || 'No project'}</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <IconButton
          onClick={() => {
            setNewProjectName('');
            setNewProjectDir('');
            setNewProjectError(null);
            setNewProjectOpen(true);
          }}
          title="New project…"
        >
          <FolderPlus className="w-4 h-4" />
        </IconButton>
      </div>

      {/* Environment switcher */}
      <nav className="flex items-center h-full shrink-0 max-w-[36vw] overflow-x-auto" aria-label="Environment">
        {envIdsOf(environments).map((envId) => {
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
                'relative h-full px-3 shrink-0 flex items-center gap-2 text-[14px] transition-colors',
                isActive ? 'text-fg' : 'text-fg-muted hover:text-fg'
              )}
            >
              <EnvDot color={env.color} hollow={!portOnline} />
              <span>{envLabel(envId)}</span>
              {isActive && <span className="absolute left-3 right-3 -bottom-px h-px bg-fg" />}
            </button>
          );
        })}
      </nav>

      <span className="hidden 2xl:block w-px h-5 bg-line" />

      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: 'design', label: 'Design' },
          { value: 'costs', label: 'Costs' },
          { value: 'history', label: 'History' },
        ]}
      />

      <div className="flex-1" />

      {/* Where the design is saved */}
      {activeProject && (
        <span
          className="hidden xl:flex items-center gap-1.5 text-[12.5px] text-fg-faint whitespace-nowrap font-mono"
          title={
            projectFile.state === 'error'
              ? `Save failed: ${projectFile.error}`
              : `Versioned in the backend and materialized to ${activeProject.working_dir}/${projectFile.file ?? 'localcloud.json'} as you edit`
          }
        >
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              projectFile.state === 'error' ? 'bg-err' : projectFile.state === 'saving' ? 'bg-warn' : 'bg-ok'
            )}
          />
          v{projectVersion}
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

      <span className="hidden 2xl:block w-px h-5 bg-line" />

      <div className="flex items-center gap-1">
        <Button variant="ghost" onClick={() => setTemplateModalOpen(true)}>
          <LayoutTemplate className="w-3.5 h-3.5" />
          <span className="hidden 2xl:inline">Blueprints</span>
        </Button>
        <Button
          variant="ghost"
          onClick={() => setImportModalOpen(true)}
          title="Import Terraform, or save / load a project file"
        >
          <FileInput className="w-3.5 h-3.5" />
          <span className="hidden 2xl:inline">Import</span>
        </Button>
        <Button
          variant="ghost"
          onClick={() => setExportModalOpen(true)}
          title="Write Terraform for your real AWS accounts to ./terraform-aws"
        >
          <FileOutput className="w-3.5 h-3.5" />
          <span className="hidden 2xl:inline">Export for AWS</span>
        </Button>
      </div>

      <span className="hidden 2xl:block w-px h-5 bg-line" />

      <div className="flex items-center gap-2">
        {/* Everything the app runs goes to this environment's local emulator */}
        <span
          className="hidden 2xl:flex h-7 px-1 text-xs font-mono text-fg-muted items-center gap-1.5 whitespace-nowrap"
          title={`Plan and apply run against the ${activeEnv} emulator. Use Export for AWS to deploy for real.`}
        >
          <span className="font-sans text-fg-faint">emulator</span>
          127.0.0.1:{currentEnvProfile.emulatorPort}
        </span>

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

      {/* A second writer (another tab or an agent) moved the design underneath this one */}
      {projectConflict && (
        <div className="h-9 shrink-0 bg-panel border-b border-err flex items-center justify-center gap-3 text-[13px] text-err z-30">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span>This project changed elsewhere (another tab or an agent). Your view is stale — reload to continue.</span>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            <RefreshCw className="w-3.5 h-3.5" />
            Reload
          </Button>
        </div>
      )}

      {/* New project */}
      {newProjectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setNewProjectOpen(false)}>
          <div
            className="w-[420px] max-w-[92vw] bg-panel border border-line rounded-lg shadow-xl p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold text-fg">New project</div>
            <p className="text-[12.5px] text-fg-muted">
              Designs live in the backend database. The folder holds terraform-out/, Lambda code and the materialized localcloud.json.
            </p>
            <label className="text-[12px] text-fg-muted flex flex-col gap-1">
              Name
              <input
                className={fieldCls}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="my-infra"
                autoFocus
              />
            </label>
            <label className="text-[12px] text-fg-muted flex flex-col gap-1">
              Folder (on the machine running LocalCloud)
              <input
                className={fieldCls}
                value={newProjectDir}
                onChange={(e) => setNewProjectDir(e.target.value)}
                placeholder="./my-infra"
              />
            </label>
            {newProjectError && <div className="text-[12.5px] text-err">{newProjectError}</div>}
            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" onClick={() => setNewProjectOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!newProjectDir.trim() || creating} onClick={handleCreateProject}>
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
                Create project
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
