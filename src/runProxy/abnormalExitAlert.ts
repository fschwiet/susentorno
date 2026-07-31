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
