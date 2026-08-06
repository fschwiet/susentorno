import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';
import { buildFstabReplaceCommand } from './fstabLine';

export interface RemountShareOptions {
  shareName: string;
  hostIp: string;
  onStep?: (message: string) => void;
}

export class RemountShareError extends Error {
  readonly step: string;
  constructor(step: string, exitCode: number) {
    super(`remountShare: '${step}' exited with code ${exitCode}`);
    this.step = step;
  }
}

async function runStep(
  remoteExec: RemoteExec,
  step: string,
  command: string,
  onStep: (message: string) => void,
): Promise<void> {
  onStep(step);
  const { exitCode } = await remoteExec.run(command);
  if (exitCode !== 0) throw new RemountShareError(step, exitCode);
}

/**
 * Re-points an already-mounted share's /etc/fstab entry at `hostIp` — the
 * credentials file installed by mountShare stays as-is. For a guest whose
 * network adapter has moved (e.g. Default Switch -> susentorno-internal), the
 * old cifs source is unreachable and the automount unit is left in a failed
 * state, which systemd caches: further access to the mountpoint returns
 * ENODEV ("no such device") instead of retrying. `daemon-reload` alone
 * regenerates the unit from the new fstab line but doesn't clear that cached
 * failure or drop a mount still pinned to the old source, so both are cleared
 * explicitly before confirming the share is reachable again.
 */
export async function remountShare(remoteExec: RemoteExec, opts: RemountShareOptions): Promise<void> {
  const onStep = opts.onStep ?? (() => {});
  const mountPoint = `/mnt/${opts.shareName}`;
  const quotedMountPoint = quoteForRemoteShell(mountPoint);

  await runStep(
    remoteExec,
    'update fstab',
    buildFstabReplaceCommand({ shareName: opts.shareName, hostIp: opts.hostIp }),
    onStep,
  );
  await runStep(remoteExec, 'reload systemd units', 'sudo systemctl daemon-reload', onStep);
  // Best-effort: unmounting a mountpoint that isn't mounted, or resetting
  // failed state when nothing failed, both "fail" harmlessly — the real
  // check is the `stat` below, so this step always reports success.
  await runStep(
    remoteExec,
    'clear stale mount state',
    `sudo umount ${quotedMountPoint} > /dev/null 2>&1; sudo systemctl reset-failed > /dev/null 2>&1; true`,
    onStep,
  );
  await runStep(remoteExec, 'confirm share is reachable', `stat ${quotedMountPoint} > /dev/null`, onStep);
}
