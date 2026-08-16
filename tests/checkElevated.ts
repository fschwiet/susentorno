import { createRealPowerShellExec } from '../src/guestSetup/powerShellExec';
import { isElevated } from '../src/guestSetup/elevationCheck';

/**
 * Guard: the host-network and guest tiers both create and delete real Hyper-V
 * objects — switches, firewall rules, VMs, VHDs, SMB shares, and a Windows
 * local account — all of which require an elevated process token. Check up
 * front and fail fast with a message that names the fix, rather than letting
 * the first PowerShell call fail deep inside a test.
 */
export async function checkElevated(): Promise<void> {
  const exec = createRealPowerShellExec();
  if (!(await isElevated(exec))) {
    throw new Error(
      'This terminal is not elevated (Administrator). This tier creates and deletes real Hyper-V ' +
        'objects, firewall rules, and Windows local accounts, which requires it. Re-run from an ' +
        'Administrator PowerShell/terminal.',
    );
  }
}
