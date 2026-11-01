import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

const KERNEL_FAILURE = /Oops|BUG:|general protection fault|Kernel panic/;

/**
 * The first serial line that is an unambiguous kernel failure, or undefined.
 * Deliberately narrow: quiet phases of a healthy install must never match.
 */
export function findKernelFailure(serialText: string): string | undefined {
  return serialText.split(/\r?\n/).find((line) => KERNEL_FAILURE.test(line));
}

export interface AttemptPaths {
  current: string;
  previous: string;
}

/**
 * Starts a new build attempt under `root`: the old `previous/` is dropped,
 * `current/` (if any) becomes `previous/`, and an empty `current/` is created.
 */
export function rotateAttempt(root: string): AttemptPaths {
  const current = join(root, 'current'),
    previous = join(root, 'previous');
  rmSync(previous, { recursive: true, force: true });
  try {
    renameSync(current, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(current, { recursive: true });
  return { current, previous };
}

/** VM state as text, for the evidence directory; the VM is gone by the time anyone looks. */
export function buildVmEvidenceCommand(vmName: string): string {
  return (
    `Get-VM -Name ${quoteForPowerShell(vmName)} | ` +
    'Select-Object State, Uptime, CPUUsage, MemoryAssigned, MemoryDemand, Heartbeat | ' +
    'Format-List | Out-String'
  );
}
