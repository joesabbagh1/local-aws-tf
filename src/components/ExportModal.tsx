import { useMemo, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { auditAwsExport, AWS_EXPORT_DIR, groupAwsExportNotes } from '../utils/awsExport';
import type { EnvironmentId } from '../types/cloud';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { Button, EnvDot, IconButton, cn } from './ui';
import { envIdsOf, envLabel } from '../utils/environments';

type Status = { kind: 'ok'; written: number; kept: number } | { kind: 'error'; message: string } | null;

export function ExportModal() {
  const isOpen = useCloudStore((s) => s.isExportModalOpen);
  const setOpen = useCloudStore((s) => s.setExportModalOpen);
  const nodes = useCloudStore((s) => s.nodes);
  const edges = useCloudStore((s) => s.edges);
  const environments = useCloudStore((s) => s.environments);
  const exportForAws = useCloudStore((s) => s.exportForAws);
  const selectNode = useCloudStore((s) => s.selectNode);
  const setActiveEnv = useCloudStore((s) => s.setActiveEnv);
  const setRightTab = useCloudStore((s) => s.setRightTab);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const notes = useMemo(
    () => (isOpen ? auditAwsExport(nodes, edges, environments) : []),
    [isOpen, nodes, edges, environments]
  );

  if (!isOpen) return null;
  const ENV_IDS = envIdsOf(environments);

  const close = () => {
    setOpen(false);
    setStatus(null);
  };

  const runExport = async () => {
    setBusy(true);
    const res = await exportForAws();
    setBusy(false);
    setStatus(
      res.ok
        ? { kind: 'ok', written: res.writtenFiles?.length || 0, kept: res.keptFiles?.length || 0 }
        : { kind: 'error', message: res.error || 'Export failed' }
    );
  };

  const showNode = (envId: EnvironmentId, nodeId?: string) => {
    setActiveEnv(envId);
    if (!nodeId) return;
    selectNode(nodeId);
    setRightTab('inspector');
    close();
  };

  return (
    <div onClick={close} className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-lg bg-panel border border-line shadow-2xl shadow-black/50 overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-medium text-fg">Export for AWS</h2>
            <p className="text-xs text-fg-muted mt-1 leading-relaxed">
              Writes Terraform for your real accounts to{' '}
              <span className="font-mono text-fg">./{AWS_EXPORT_DIR}</span>: no emulator endpoints or credentials,
              remote state in S3, and real values wherever the local build uses stand-ins. LocalCloud never runs
              it; deploy it with your usual pipeline.
            </p>
          </div>
          <IconButton onClick={close} title="Close" className="-mr-2 -mt-1">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Per-environment readiness */}
          <div className="px-5 py-4 border-b border-line">
            <div className="divide-y divide-line">
              {ENV_IDS.map((envId) => {
                const env = environments[envId];
                const count = nodes.filter((n) => n.data.envEnabled?.[envId] !== false).length;
                const todo = notes.filter((n) => n.envId === envId).length;
                return (
                  <div key={envId} className="h-9 flex items-center gap-2.5 text-xs">
                    <EnvDot color={env.color} />
                    <span className="text-fg w-24">{env.name}</span>
                    <span className="font-mono text-[12.5px] text-fg-faint w-24">{env.region}</span>
                    <span className="text-fg-faint">
                      {count} resource{count === 1 ? '' : 's'}
                    </span>
                    <span className={cn('ml-auto flex items-center gap-1.5', todo ? 'text-warn' : 'text-fg-muted')}>
                      <span className={cn('w-1.5 h-1.5 rounded-full', todo ? 'bg-warn' : 'bg-ok')} />
                      {todo ? `${todo} to fix` : 'ready'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* What AWS needs that the emulator lets slide */}
          {notes.length > 0 && (
            <div className="px-5 py-4 border-b border-line">
              <h3 className="text-xs font-medium text-fg-muted mb-2">To fix before deploying</h3>
              <div className="-mx-2">
                {groupAwsExportNotes(notes).map((note, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => showNode(note.envIds[0], note.nodeId)}
                    disabled={!note.nodeId}
                    className="w-full px-2 py-1.5 rounded-md text-left flex items-start gap-2.5 enabled:hover:bg-raised transition-colors"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-warn shrink-0 mt-0.5" />
                    <span className="text-xs leading-relaxed">
                      <span className="text-fg-faint">
                        {note.envIds.length === ENV_IDS.length
                          ? 'All environments'
                          : note.envIds.map(envLabel).join(', ')}
                        :
                      </span>{' '}
                      <span className="text-fg-muted">{note.message}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[12.5px] text-fg-faint mt-2">
                You can export now and fix these in the exported files, or fix them on the canvas and export again.
              </p>
            </div>
          )}

          {/* First deploy */}
          <div className="px-5 py-4">
            <h3 className="text-xs font-medium text-fg-muted mb-2">First deploy</h3>
            <ol className="text-xs text-fg-muted leading-relaxed space-y-1.5 list-decimal pl-4">
              <li>
                Create an S3 bucket for Terraform state and put its name in each environment's{' '}
                <span className="font-mono text-fg">backend.tfbackend</span>. Exporting again keeps that file.
              </li>
              <li>Then, per environment, with your AWS credentials for that account:</li>
            </ol>
            <pre className="mt-2 rounded-md border border-line bg-base p-3 font-mono text-[12.5px] leading-relaxed text-fg/90 select-text overflow-x-auto">
              {`cd ${AWS_EXPORT_DIR}/environments/dev
terraform init -backend-config=backend.tfbackend
terraform plan -var-file=dev.tfvars`}
            </pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-4">
          <div className="text-xs min-w-0">
            {status?.kind === 'ok' && (
              <span className="text-fg-muted flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-ok shrink-0" />
                <span>
                  Wrote {status.written} files to <span className="font-mono">./{AWS_EXPORT_DIR}</span>
                  {status.kept > 0 && `, kept your ${status.kept} backend settings`}.
                </span>
              </span>
            )}
            {status?.kind === 'error' && (
              <span className="text-err flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {status.message}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" onClick={close}>
              {status?.kind === 'ok' ? 'Done' : 'Cancel'}
            </Button>
            <Button variant="primary" disabled={busy} onClick={runExport}>
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {status?.kind === 'ok' ? 'Export again' : 'Export'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
