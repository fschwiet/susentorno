import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { isElevated } from '../../src/guestSetup/elevationCheck';

/**
 * Guard: every test in this tier creates/deletes real Hyper-V switches and
 * firewall rules, which requires an elevated process token. Check up front
 * and fail fast with a message that names the fix, rather than letting the
 * first `create-host-network` call fail deep inside a test.
 */
export async function checkElevated(): Promise<void> {
  const exec = createRealPowerShellExec();
  if (!(await isElevated(exec))) {
    throw new Error(
      'This terminal is not elevated (Administrator). The host-network tier creates and deletes real Hyper-V ' +
        'switches and firewall rules, which requires it. Re-run from an Administrator PowerShell/terminal.',
    );
  }
}
