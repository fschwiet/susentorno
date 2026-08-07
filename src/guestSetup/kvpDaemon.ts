import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';

// Candidates seen for the Hyper-V Data Exchange (KVP) daemon on Ubuntu LTS
// releases: 'hv-kvp-daemon-init' and 'linux-cloud-tools-virtual'. This is the
// modern init-based package cited by Ubuntu's hv_kvp_daemon manpage and
// Microsoft's Hyper-V IP-discovery troubleshooting doc — confirm it against
// the specific Ubuntu LTS version setup-guest.md targets during manual
// verification before relying on it in production; see the manual-verification
// checklist.
export const KVP_DAEMON_PACKAGE = 'hv-kvp-daemon-init';

export class EnsureKvpDaemonError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`ensureKvpDaemon: install exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * Guarantees the KVP daemon package is installed, the same way mountShare
 * guarantees cifs-utils — a stock Ubuntu Server image doesn't ship it, and
 * without it (Get-VMNetworkAdapter -VMName <name>).IPAddresses never reports
 * an address, breaking Hyper-V-based guest discovery for the rest of this
 * run and every rerun after it.
 */
export async function ensureKvpDaemon(
  remoteExec: RemoteExec,
  onStep?: (message: string) => void,
): Promise<void> {
  const step = onStep ?? (() => {});
  step(`install ${KVP_DAEMON_PACKAGE}`);
  const { exitCode } = await remoteExec.run(
    `sudo apt-get install -y ${quoteForRemoteShell(KVP_DAEMON_PACKAGE)}`,
  );
  if (exitCode !== 0) throw new EnsureKvpDaemonError(exitCode);
}
