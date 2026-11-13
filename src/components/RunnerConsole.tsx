import { useEffect, useRef } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import {
  Play,
  Square,
  Loader2,
  Trash2,
  FileSearch,
  ShieldCheck,
  Rocket,
  Bomb,
  Download,
} from 'lucide-react';

const TF_ACTIONS = [
  { command: 'init', label: 'Init', icon: Download, tone: 'text-slate-200' },
  { command: 'validate', label: 'Validate', icon: ShieldCheck, tone: 'text-sky-300' },
  { command: 'plan', label: 'Plan', icon: FileSearch, tone: 'text-amber-300' },
  { command: 'apply', label: 'Apply', icon: Rocket, tone: 'text-emerald-300' },
  { command: 'destroy', label: 'Destroy', icon: Bomb, tone: 'text-rose-300' },
] as const;

function lineTone(line: string): string {
  if (/❌|Error:|error:|│ Error/.test(line)) return 'text-rose-300';
  if (/⚠️|Warning:/.test(line)) return 'text-amber-300';
  if (/✅|complete after|Apply complete|No changes|Success/.test(line)) return 'text-emerald-300';
  if (/^\[[^\]]+\] \$ terraform/.test(line) || /🚀|🐳/.test(line)) return 'text-sky-300';
  if (/Creating\.\.\.|Destroying\.\.\.|Still /.test(line)) return 'text-amber-200';
  return 'text-slate-300';
}

export function RunnerConsole() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const terminalLogs = useCloudStore((s) => s.terminalLogs);
  const controlEmulatorContainer = useCloudStore((s) => s.controlEmulatorContainer);
  const runTerraformCommand = useCloudStore((s) => s.runTerraformCommand);
  const clearTerminalLogs = useCloudStore((s) => s.clearTerminalLogs);
  const targetLocalEmulator = useCloudStore((s) => s.targetLocalEmulator);

  const env = environments[activeEnv];
  const online = emulatorStatuses[env.emulatorPort]?.running;

  const terminalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = terminalRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalLogs.length]);

  const runTf = (command: (typeof TF_ACTIONS)[number]['command']) => {
    if (
      command === 'destroy' &&
      !window.confirm(`Destroy every resource in ${env.name} (port ${env.emulatorPort})?`)
    ) {
      return;
    }
    runTerraformCommand(command, activeEnv);
  };

  return (
    <div className="space-y-3">
      {/* Emulator container for the active environment */}
      <div className="p-3 rounded-xl bg-[#141824] border border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${online ? 'bg-emerald-400' : 'bg-slate-600'}`}
            style={online ? { boxShadow: '0 0 8px #34d399' } : undefined}
          />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              {env.name} emulator
            </div>
            <div className="text-[10px] font-mono text-slate-400">
              https://127.0.0.1:{env.emulatorPort} · {online ? 'running' : 'stopped'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={isRunningCommand || online}
            onClick={() => controlEmulatorContainer('start', activeEnv)}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 hover:bg-emerald-500/25 disabled:opacity-40 flex items-center gap-1"
          >
            <Play className="w-3 h-3 fill-current" /> Start
          </button>
          <button
            type="button"
            disabled={isRunningCommand || !online}
            onClick={() => controlEmulatorContainer('stop', activeEnv)}
            className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 disabled:opacity-40 flex items-center gap-1"
          >
            <Square className="w-3 h-3 fill-current" /> Stop
          </button>
        </div>
      </div>

      {!targetLocalEmulator && (
        <p className="text-[10px] text-amber-300 px-1">
          The compiled provider targets real AWS ({env.region}). Switch the top-bar target back to
          the emulator port before applying locally.
        </p>
      )}

      {/* Terraform lifecycle */}
      <div className="grid grid-cols-5 gap-1">
        {TF_ACTIONS.map(({ command, label, icon: Icon, tone }) => (
          <button
            key={command}
            type="button"
            disabled={isRunningCommand}
            onClick={() => runTf(command)}
            className="py-1.5 rounded-lg text-[11px] font-medium bg-[#141824] border border-slate-800 hover:border-slate-600 hover:bg-[#1a2030] disabled:opacity-40 flex flex-col items-center gap-0.5"
          >
            <Icon className={`w-3.5 h-3.5 ${tone}`} />
            <span className="text-slate-200">{label}</span>
          </button>
        ))}
      </div>

      {/* Live terminal */}
      <div className="rounded-xl border border-slate-800 bg-[#06080c] overflow-hidden">
        <div className="px-3 py-1.5 border-b border-slate-800/80 flex items-center justify-between">
          <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5">
            {isRunningCommand && <Loader2 className="w-3 h-3 animate-spin text-amber-300" />}
            terraform-out/environments/{activeEnv}
          </span>
          <button
            type="button"
            onClick={clearTerminalLogs}
            title="Clear terminal"
            className="text-slate-500 hover:text-slate-200"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
        <div
          ref={terminalRef}
          className="h-72 overflow-y-auto p-2.5 font-mono text-[10.5px] leading-relaxed select-text"
        >
          {terminalLogs.length === 0 ? (
            <span className="text-slate-600">No output yet.</span>
          ) : (
            terminalLogs.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap break-words ${lineTone(line)}`}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
