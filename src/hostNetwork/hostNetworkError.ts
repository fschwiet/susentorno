import type { PowerShellExec } from '../guestSetup/powerShellExec';

/**
 * Thrown by every module under src/hostNetwork/ for a domain failure. The two
 * command-glue files (createHostNetwork.ts, deleteHostNetwork.ts commands)
 * catch exactly this type to print a clean, prefixed message.
 */
export class HostNetworkError extends Error {}

const ERROR_PREFIX = 'ERROR: ';

/**
 * Runs a mutating PowerShell command built with the project's
 * `-ErrorAction Stop` + try/catch convention (see Global Constraints) and
 * turns its result into either success or a thrown HostNetworkError. The
 * shared PowerShellExec wrapper never captures stderr, so a failing
 * mutation's message travels through stdout as "ERROR: <message>" instead.
 */
export async function runMutation(exec: PowerShellExec, command: string): Promise<void> {
  const result = await exec.run(command);
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith(ERROR_PREFIX)) {
    throw new HostNetworkError(trimmed.slice(ERROR_PREFIX.length));
  }
  if (result.exitCode !== 0) {
    throw new HostNetworkError(`PowerShell command failed with exit code ${result.exitCode}`);
  }
}
