import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';

// 'hv-kvp-daemon-init' does not exist on Ubuntu 26.04 LTS (confirmed via
// `apt-cache policy` against a real guest); 'linux-cloud-tools-virtual' does,
// and its hv-kvp-daemon.service starts cleanly once the guest reboots (which
// setup-guest-unix's isolation step already does before anything depends on
// the daemon being up) — no manual `udevadm trigger` needed in that flow.
export const KVP_DAEMON_PACKAGE = 'linux-cloud-tools-virtual';

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
