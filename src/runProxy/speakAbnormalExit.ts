import { spawn as spawnProcess } from 'node:child_process';
import { homedir } from 'node:os';

export interface SpeakAbnormalExitDeps {
  /** Fire-and-forget process launch; the caller never awaits or inspects the result. */
  spawn: (command: string, args: string[]) => void;
}

const SPEAK_SCRIPT = "(New-Object -ComObject SAPI.SpVoice).Speak('Configamatron is down')";

/**
 * Best-effort, bounded audible alert (ADR-0017): speaks "Configamatron is down"
 * through the native Windows SAPI COM voice, via a detached PowerShell one-liner
 * (chosen over the managed `System.Speech` synthesizer to avoid a NuGet/.NET-Core
 * dependency under pwsh 7). The operator normally works inside the guest and does
 * not watch `run-proxy`'s host console, so a silent failure looks like a guest
 * problem instead of a host one.
 *
 * Never throws and is never awaited by the caller: a failed or hung PowerShell
 * spawn must not change, delay, or replace `run-proxy`'s original exit result.
 */
export function speakAbnormalExit(deps: SpeakAbnormalExitDeps = createSpeakDeps()): void {
  try {
    deps.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SPEAK_SCRIPT]);
  } catch {
    // Best-effort: swallow any synchronous spawn failure.
  }
}

/**
 * Wires a real, detached, fire-and-forget PowerShell spawn; the only non-test caller.
 * The best-effort guarantee (never throws) is owned by `speakAbnormalExit`'s own
 * try/catch around `deps.spawn`, not repeated here.
 */
export function createSpeakDeps(): SpeakAbnormalExitDeps {
  return {
    spawn: (command, args) => {
      // Explicit cwd: the detached child outlives the caller, so it must never sit
      // inside a directory the caller (e.g. a test harness) may delete right after
      // this returns — that would lock the directory and fail the caller's cleanup.
      const child = spawnProcess(command, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        cwd: homedir(),
      });
      child.on('error', () => {
        // Best-effort: nothing to recover, nothing to propagate.
      });
      child.unref();
    },
  };
}
