import { useRef, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { X, FolderOpen, Download, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button, IconButton, cn, monoFieldCls } from './ui';

type Tab = 'terraform' | 'project';
type Status = { kind: 'ok' | 'error'; message: string; details?: string[] } | null;

const MAX_DETAILS = 8;

export function ImportExportModal() {
  const isOpen = useCloudStore((s) => s.isImportModalOpen);
  const setOpen = useCloudStore((s) => s.setImportModalOpen);
  const importTerraformHcl = useCloudStore((s) => s.importTerraformHcl);
  const exportProjectJson = useCloudStore((s) => s.exportProjectJson);
  const importProjectJson = useCloudStore((s) => s.importProjectJson);
  const nodeCount = useCloudStore((s) => s.nodes.length);
  const projectFile = useCloudStore((s) => s.projectFile);

  const [tab, setTab] = useState<Tab>('terraform');
  const [hcl, setHcl] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const tfFileInput = useRef<HTMLInputElement>(null);
  const jsonFileInput = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const close = () => {
    setOpen(false);
    setStatus(null);
  };

  const loadTfFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const texts = await Promise.all(
      Array.from(files).map(async (f) => `# --- ${f.name} ---\n${await f.text()}`)
    );
    setHcl(texts.join('\n\n'));
    setStatus(null);
  };

  const importHcl = () => {
    const result = importTerraformHcl(hcl);
    if (result.importedCount === 0) {
      setStatus({ kind: 'error', message: 'No supported `resource "aws_*"` blocks found.' });
      return;
    }
    setHcl('');
    // Say what didn't come across as-is, so nothing disappears silently
    const details = [
      ...result.dropped.map((d) => `Not imported: ${d.key} on ${d.address} (${d.reason})`),
      ...(result.skippedResources.length
        ? [`No canvas service for ${result.skippedResources.length} resource(s): ${result.skippedResources.join(', ')}`]
        : []),
      ...result.warnings,
    ];
    setStatus({
      kind: 'ok',
      message: `Imported ${result.importedCount} resource${result.importedCount === 1 ? '' : 's'}${
        result.extraArgCount ? `; ${result.extraArgCount} argument${result.extraArgCount === 1 ? '' : 's'} kept as Extra HCL` : ''
      }.`,
      details,
    });
  };

  const downloadProject = () => {
    const blob = new Blob([exportProjectJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `localcloud-${new Date().toISOString().slice(0, 10)}.localcloud.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus({ kind: 'ok', message: 'Project downloaded.' });
  };

  const loadProject = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    // A successful load closes the modal from the store
    if (importProjectJson(await file.text())) setStatus(null);
    else setStatus({ kind: 'error', message: `${file.name} is not a LocalCloud project file.` });
  };

  return (
    <div onClick={close} className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-lg bg-panel border border-line shadow-2xl shadow-black/50 overflow-hidden"
      >
        <div className="h-12 pl-3 pr-3 border-b border-line flex items-stretch justify-between">
          <nav className="flex items-stretch">
            {(
              [
                { id: 'terraform', label: 'Import Terraform' },
                { id: 'project', label: 'Project file' },
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setStatus(null);
                }}
                className={cn(
                  'relative px-2.5 text-[14px] transition-colors',
                  tab === id ? 'text-fg' : 'text-fg-muted hover:text-fg'
                )}
              >
                {label}
                {tab === id && <span className="absolute left-2.5 right-2.5 -bottom-px h-px bg-fg" />}
              </button>
            ))}
          </nav>
          <IconButton onClick={close} title="Close" className="self-center">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="p-5 space-y-4">
          {tab === 'terraform' ? (
            <>
              <p className="text-xs text-fg-muted leading-relaxed">
                Paste HCL or choose <span className="font-mono text-fg">.tf</span> files. Each{' '}
                <span className="font-mono text-fg">resource "aws_*"</span> block becomes a node and references
                become connections. This replaces the current canvas ({nodeCount} nodes); undo with ⌘Z.
              </p>
              <textarea
                value={hcl}
                onChange={(e) => setHcl(e.target.value)}
                rows={12}
                spellCheck={false}
                placeholder={'resource "aws_s3_bucket" "assets" {\n  bucket = "my-assets"\n}'}
                className={cn(monoFieldCls, 'p-3 text-[13px] leading-relaxed resize-y')}
              />
              <div className="flex items-center justify-between">
                <Button onClick={() => tfFileInput.current?.click()}>
                  <FolderOpen className="w-3.5 h-3.5" /> Choose files
                </Button>
                <input
                  ref={tfFileInput}
                  type="file"
                  accept=".tf,.hcl,text/plain"
                  multiple
                  hidden
                  onChange={(e) => {
                    loadTfFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Button variant="primary" disabled={!hcl.trim()} onClick={importHcl}>
                  Import to canvas
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-fg-muted leading-relaxed">
                {projectFile.file && projectFile.state !== 'error' ? (
                  <>
                    The canvas saves to <span className="font-mono text-fg">./{projectFile.file}</span> as you edit,
                    so you can commit it next to your Terraform. After pulling changes to that file, reload this
                    page to pick them up.
                  </>
                ) : (
                  <>The canvas is saved in this browser only.</>
                )}{' '}
                A downloaded copy holds every node, connection, override and environment profile.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={downloadProject}
                  className="p-4 rounded-md border border-line hover:border-line-strong hover:bg-raised text-left transition-colors"
                >
                  <Download className="w-4 h-4 text-fg-muted" />
                  <div className="text-[14px] text-fg mt-3">Download project</div>
                  <div className="text-[12.5px] text-fg-faint mt-0.5">{nodeCount} nodes · 4 environments</div>
                </button>
                <button
                  type="button"
                  onClick={() => jsonFileInput.current?.click()}
                  className="p-4 rounded-md border border-line hover:border-line-strong hover:bg-raised text-left transition-colors"
                >
                  <Upload className="w-4 h-4 text-fg-muted" />
                  <div className="text-[14px] text-fg mt-3">Load project file</div>
                  <div className="text-[12.5px] text-fg-faint mt-0.5">Replaces the canvas; undo with ⌘Z</div>
                </button>
                <input
                  ref={jsonFileInput}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    loadProject(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
            </>
          )}

          {status && (
            <div>
              <p className={cn('text-xs flex items-center gap-2', status.kind === 'ok' ? 'text-fg' : 'text-err')}>
                {status.kind === 'ok' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-ok" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" />
                )}
                {status.message}
              </p>
              {status.details && status.details.length > 0 && (
                <ul className="mt-2 pl-5 space-y-1 text-[12.5px] text-fg-muted leading-relaxed list-disc marker:text-fg-faint">
                  {status.details.slice(0, MAX_DETAILS).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                  {status.details.length > MAX_DETAILS && (
                    <li className="text-fg-faint">and {status.details.length - MAX_DETAILS} more</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
