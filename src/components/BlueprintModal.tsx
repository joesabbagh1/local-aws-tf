import { useCloudStore } from '../store/useCloudStore';
import { ARCHITECTURE_TEMPLATES } from '../data/templates';
import { Sparkles, X, ArrowRight, Layers, CheckCircle2 } from 'lucide-react';

export function BlueprintModal() {
  const isOpen = useCloudStore((s) => s.isTemplateModalOpen);
  const setOpen = useCloudStore((s) => s.setTemplateModalOpen);
  const loadTemplate = useCloudStore((s) => s.loadTemplate);

  if (!isOpen) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-2xl bg-[#11141d] border border-slate-800 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                AWS Multi-Environment Architecture Blueprints
              </h2>
              <p className="text-xs text-slate-400">
                Pre-wired topologies with built-in Dev, Testing, Staging, and Production overrides ready for AWS Emulator & Terraform.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Templates List */}
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {ARCHITECTURE_TEMPLATES.map((tpl) => (
            <div
              key={tpl.id}
              className="group p-4 rounded-xl bg-[#161b28] hover:bg-[#1c2233] border border-slate-800 hover:border-orange-500/50 transition-all flex items-start justify-between gap-4"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/30 font-semibold">
                    {tpl.badge}
                  </span>
                  <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
                    <Layers className="w-3 h-3" /> {tpl.nodes.length} Resources • {tpl.edges.length} Connections
                  </span>
                </div>
                <h3 className="text-sm font-bold text-white group-hover:text-orange-300 transition-colors">
                  {tpl.name}
                </h3>
                <p className="text-[11px] font-mono text-sky-400">
                  {tpl.subtitle}
                </p>
                <p className="text-xs text-slate-400 leading-relaxed pt-0.5">
                  {tpl.description}
                </p>
                <div className="flex items-center gap-3 pt-1 text-[11px] text-emerald-400">
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Multi-Env Overrides Included
                  </span>
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> AWS Emulator Compatible
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => loadTemplate(tpl.id)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-orange-500 hover:bg-orange-400 text-slate-950 shrink-0 flex items-center gap-1.5 shadow-md shadow-orange-500/10 transition-all self-center"
              >
                <span>Load Canvas</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
