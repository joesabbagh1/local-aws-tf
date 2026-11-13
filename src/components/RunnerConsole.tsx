import { useEffect, useRef } from 'react';
import { useCloudStore } from '../store/useCloudStore';
import { Play, Square, Loader2, Eraser } from 'lucide-react';
import { Button, IconButton, cn } from './ui';

const TF_ACTIONS = [
  { command: 'init', label: 'init' },
  { command: 'validate', label: 'validate' },
  { command: 'plan', label: 'plan' },
  { command: 'apply', label: 'apply' },
  { command: 'destroy', label: 'destroy' },
] as const;

function lineTone(line: string): string {
  if (/Error:|error:|│ Error/.test(line)) return 'text-err';
  if (/Warning:/.test(line)) return 'text-warn';
  if (/complete after|Apply complete|No changes|Success|succeeded|completed successfully|Synced|Captured/.test(line))
    return 'text-ok';
  if (/\] \$ terraform/.test(line)) return 'text-fg';
  if (/Creating\.\.\.|Destroying\.\.\.|Still /.test(line)) return 'text-fg-muted';
  return 'text-fg-muted';
}

export function RunnerConsole() {
  const activeEnv = useCloudStore((s) => s.activeEnv);
  const environments = useCloudStore((s) => s.environments);
  const emulatorStatuses = useCloudStore((s) => s.emulatorStatuses);
  const isRunningCommand = useCloudStore((s) => s.isRunningCommand);
  const terminalLogs = useCloudStore((s) => s.terminalLogs);
  const controlEmulatorContainer = useCloudStore((s) => s.controlEmulatorContainer);
  const runTerraformCommand = useCloudStore((s) => s.runTerraformCommand);
  const requestApply = useCloudStore((s) => s.requestApply);
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
    if (command === 'apply') requestApply(activeEnv);
    else runTerraformCommand(command, activeEnv);
  };

  return (
    <div className="space-y-3">
      {/* Emulator container for the active environment */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-fg flex items-center gap-2">
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', online ? 'bg-ok' : 'bg-fg-faint/60')} />
            {env.name} emulator
          </div>
          <div className="text-[11px] font-mono text-fg-faint mt-0.5 pl-3.5">
            127.0.0.1:{env.emulatorPort} · {online ? 'running' : 'stopped'}
          </div>
        </div>
        {online ? (
          <Button
            disabled={isRunningCommand}
            onClick={() => controlEmulatorContainer('stop', activeEnv)}
          >
            <Square className="w-3 h-3 fill-current" /> Stop
          </Button>
        ) : (
          <Button
            disabled={isRunningCommand}
            onClick={() => controlEmulatorContainer('start', activeEnv)}
          >
            <Play className="w-3 h-3 fill-current" /> Start
          </Button>
        )}
      </div>

      {!targetLocalEmulator && (
        <p className="text-[11px] text-warn">
          The provider targets real AWS ({env.region}). Switch the target in the top bar back to the
          emulator before applying locally.
        </p>
      )}

      {/* Terraform lifecycle */}
      <div className="flex rounded-md border border-line overflow-hidden divide-x divide-line">
        {TF_ACTIONS.map(({ command, label }) => (
          <button
            key={command}
            type="button"
            disabled={isRunningCommand}
            onClick={() => runTf(command)}
            className={cn(
              'flex-1 h-7 text-xs font-mono transition-colors disabled:opacity-40',
              command === 'destroy'
                ? 'text-fg-muted hover:text-err hover:bg-err/10'
                : 'text-fg-muted hover:text-fg hover:bg-raised'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Live terminal */}
      <div className="rounded-md border border-line bg-base overflow-hidden">
        <div className="h-8 pl-3 pr-1 border-b border-line flex items-center justify-between">
          <span className="text-[11px] font-mono text-fg-faint flex items-center gap-1.5">
            {isRunningCommand && <Loader2 className="w-3 h-3 animate-spin text-warn" />}
            terraform-out/environments/{activeEnv}
          </span>
          <IconButton onClick={clearTerminalLogs} title="Clear output" className="w-6 h-6">
            <Eraser className="w-3 h-3" />
          </IconButton>
        </div>
        <div
          ref={terminalRef}
          className="h-72 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed select-text"
        >
          {terminalLogs.length === 0 ? (
            <span className="text-fg-faint">No output yet.</span>
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
