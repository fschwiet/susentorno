/** How long cleanup after a first Ctrl+C may take before the process exits anyway. */
export const CLEANUP_DEADLINE_MS = 30_000;

/** The exit code for a cancelled run. */
export const CANCELLED_EXIT_CODE = 130;

export interface InterruptSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface WatchForInterruptOptions {
  /** Normally `process`. */
  source: InterruptSource;
  /** Aborted on the first Ctrl+C so the in-flight guest work returns promptly. */
  controller: AbortController;
  print: (line: string) => void;
  exit: (code: number) => void;
  /** Starts a one-shot timer and returns how to cancel it. Defaults to an unref'd setTimeout. */
  setTimer?: (callback: () => void, ms: number) => () => void;
}

function defaultSetTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * The first Ctrl+C aborts the run and lets it clean up for about 30 seconds;
 * the second, or the end of that allowance, exits with 130 immediately. Returns
 * a function that stops watching once the run has finished.
 */
export function watchForInterrupt(options: WatchForInterruptOptions): () => void {
  const setTimer = options.setTimer ?? defaultSetTimer;
  let interrupts = 0;
  let cancelTimer: (() => void) | undefined;

  const onInterrupt = (): void => {
    interrupts++;
    if (interrupts > 1) {
      options.print('setup-guest-windows: second Ctrl+C, exiting immediately.');
      options.exit(CANCELLED_EXIT_CODE);
      return;
    }
    options.print(
      'setup-guest-windows: Ctrl+C received, cancelling and cleaning up (up to 30 seconds). ' +
        'Press Ctrl+C again to exit immediately.',
    );
    options.controller.abort();
    cancelTimer = setTimer(() => {
      options.print('setup-guest-windows: cleanup did not finish in time, exiting.');
      options.exit(CANCELLED_EXIT_CODE);
    }, CLEANUP_DEADLINE_MS);
  };

  options.source.on('SIGINT', onInterrupt);
  return () => {
    options.source.off('SIGINT', onInterrupt);
    cancelTimer?.();
  };
}
