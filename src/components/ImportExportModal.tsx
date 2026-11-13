import { useRef, useState } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { X, FileCode2, FolderOpen, Download, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';

type Tab = 'terraform' | 'project';
type Status = { kind: 'ok' | 'error'; message: string } | null;

export function ImportExportModal() {
  const isOpen = useCloudStore((s) => s.isImportModalOpen);
  const setOpen = useCloudStore((s) => s.setImportModalOpen);
  const importTerraformHcl = useCloudStore((s) => s.importTerraformHcl);
  const exportProjectJson = useCloudStore((s) => s.exportProjectJson);
  const importProjectJson = useCloudStore((s) => s.importProjectJson);
  const nodeCount = useCloudStore((s) => s.nodes.length);

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
    // A successful import closes the modal from the store
    if (importTerraformHcl(hcl) > 0) {
      setHcl('');
      setStatus(null);
    } else {
      setStatus({ kind: 'error', message: 'No supported `resource "aws_*"` blocks found.' });
    }
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
    <div
      onClick={close}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl bg-[#11141d] border border-slate-800 shadow-2xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-1 bg-[#0d1017] p-1 rounded-xl border border-slate-800">
            {(
              [
                { id: 'terraform', label: 'Import Terraform', icon: FileCode2 },
                { id: 'project', label: 'Save / Load Project', icon: FolderOpen },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setStatus(null);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${
                  tab === id ? 'bg-[#1f2637] text-white border border-slate-700' : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {tab === 'terraform' ? (
            <>
              <p className="text-xs text-slate-400 leading-relaxed">
                Paste HCL or pick one or more <code className="text-orange-300">.tf</code> files. Each{' '}
                <code className="text-orange-300">resource "aws_*"</code> block becomes a node, and references
                between resources become connections. This replaces the current canvas ({nodeCount} nodes); undo
                with <kbd className="text-slate-200">⌘Z</kbd>.
              </p>
              <textarea
                value={hcl}
                onChange={(e) => setHcl(e.target.value)}
                rows={12}
                spellCheck={false}
                placeholder={'resource "aws_s3_bucket" "assets" {\n  bucket = "my-assets"\n}'}
                className="w-full bg-[#080a0f] border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-slate-200 focus:outline-none focus:border-orange-500"
              />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => tfFileInput.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1.5"
                >
                  <FolderOpen className="w-3.5 h-3.5" /> Choose .tf files
                </button>
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
                <button
                  type="button"
                  disabled={!hcl.trim()}
                  onClick={importHcl}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 hover:bg-orange-400 text-slate-950 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5" /> Import to canvas
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400 leading-relaxed">
                Your canvas auto-saves in this browser. Download a{' '}
                <code className="text-orange-300">.localcloud.json</code> file to back it up, share it, or commit it
                next to your Terraform. It includes every node, connection, environment override and environment
                profile.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={downloadProject}
                  className="p-4 rounded-xl border border-slate-800 bg-[#141824] hover:border-slate-600 text-left space-y-1"
                >
                  <Download className="w-4 h-4 text-emerald-400" />
                  <div className="text-xs font-semibold text-white">Download project</div>
                  <div className="text-[10px] text-slate-400">{nodeCount} nodes · all 4 environments</div>
                </button>
                <button
                  type="button"
                  onClick={() => jsonFileInput.current?.click()}
                  className="p-4 rounded-xl border border-slate-800 bg-[#141824] hover:border-slate-600 text-left space-y-1"
                >
                  <Upload className="w-4 h-4 text-sky-400" />
                  <div className="text-xs font-semibold text-white">Load project file</div>
                  <div className="text-[10px] text-slate-400">Replaces the canvas (undo with ⌘Z)</div>
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
            <div
              className={`px-3 py-2 rounded-lg text-xs flex items-center gap-2 ${
                status.kind === 'ok'
                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                  : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
              }`}
            >
              {status.kind === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              {status.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
