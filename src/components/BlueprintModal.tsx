import { useCloudStore } from '../store/useCloudStore';
import { ARCHITECTURE_TEMPLATES } from '../data/templates';
import { X } from 'lucide-react';
import { Button, IconButton } from './ui';

export function BlueprintModal() {
  const isOpen = useCloudStore((s) => s.isTemplateModalOpen);
  const setOpen = useCloudStore((s) => s.setTemplateModalOpen);
  const loadTemplate = useCloudStore((s) => s.loadTemplate);

  if (!isOpen) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-lg bg-panel border border-line shadow-2xl shadow-black/50 overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-medium text-fg">Blueprints</h2>
            <p className="text-xs text-fg-muted mt-1">
              Pre-wired architectures with per-environment overrides. Loading one replaces the canvas; undo with ⌘Z.
            </p>
          </div>
          <IconButton onClick={() => setOpen(false)} title="Close" className="-mr-2 -mt-1">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="max-h-[70vh] overflow-y-auto divide-y divide-line">
          {ARCHITECTURE_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="px-5 py-4 flex items-start justify-between gap-6 hover:bg-raised/50 transition-colors">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[14px] font-medium text-fg">{tpl.name}</h3>
                  <span className="text-[12.5px] text-fg-faint">
                    {tpl.nodes.length} resources · {tpl.edges.length} connections
                  </span>
                </div>
                <p className="text-[12.5px] font-mono text-fg-muted mt-1">{tpl.subtitle}</p>
                <p className="text-xs text-fg-muted leading-relaxed mt-2">{tpl.description}</p>
              </div>
              <Button onClick={() => loadTemplate(tpl.id)} className="shrink-0 mt-0.5">
                Load
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
