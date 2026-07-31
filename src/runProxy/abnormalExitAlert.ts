import { execa } from 'execa';

export interface AbnormalExitAlertDeps {
  platform: NodeJS.Platform;
  speak: () => void;
}

export interface AbnormalExitAlert {
  trigger: () => void;
}

/**
 * Speaks at most once per process, even if multiple failure signals fire in sequence
 * (e.g. a caught fatal error followed by an uncaughtException during teardown).
 * Windows-only: the SAPI voice this drives has no non-Windows equivalent in this project.
 */
export function createAbnormalExitAlert(deps: AbnormalExitAlertDeps): AbnormalExitAlert {
  let spoken = false;
  return {
    trigger(): void {
      if (spoken || deps.platform !== 'win32') return;
      spoken = true;
      try {
        deps.speak();
      } catch {
        // best-effort: a failed/slow alert must never affect run-proxy's exit result
      }
    },
  };
}

const SPOKEN_MESSAGE = 'Configamatron is down';

/** Builds the PowerShell one-liner that drives the SAPI COM voice (not System.Speech: SAPI needs no NuGet package under pwsh 7). */
export function buildSpeakCommand(message: string): string {
  const escaped = message.replace(/'/g, "''");
  return `(New-Object -ComObject SAPI.SpVoice).Speak('${escaped}')`;
}

/**
 * Fires a detached, unreferenced PowerShell process and returns immediately — never
 * awaited, so a slow or failed spawn cannot delay or change run-proxy's own exit.
 */
export function speakAlert(): void {
  const child = execa(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      buildSpeakCommand(SPOKEN_MESSAGE),
    ],
    { detached: true, stdio: 'ignore', reject: false },
  );
  child.unref();
}

/** Wires real process.platform + the real SAPI spawn; the only non-test caller. */
export function createRealAbnormalExitAlert(): AbnormalExitAlert {
  return createAbnormalExitAlert({ platform: process.platform, speak: speakAlert });
}
