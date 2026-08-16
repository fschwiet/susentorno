import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RemoteExec } from './remoteExec';
import { quoteForRemoteShell } from './quoteForRemoteShell';
import { buildFstabReplaceCommand } from './fstabLine';

export interface MountShareOptions {
  shareName: string;
  accountName: string;
  password: string;
  hostIp: string;
  onStep?: (message: string) => void;
}

export class MountShareError extends Error {
  readonly step: string;
  constructor(step: string, exitCode: number) {
    super(`mountShare: '${step}' exited with code ${exitCode}`);
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
  if (exitCode !== 0) throw new MountShareError(step, exitCode);
}

export async function mountShare(remoteExec: RemoteExec, opts: MountShareOptions): Promise<void> {
  const onStep = opts.onStep ?? (() => {});

  await runStep(remoteExec, 'install cifs-utils', 'sudo apt-get install -y cifs-utils', onStep);

  const suffix = randomBytes(8).toString('hex');
  const localTempPath = join(tmpdir(), `susentorno-share-cred-${suffix}`);
  // Guest home directory, not /tmp: scp resolves a `~/...` destination against
  // the login user's home server-side, same as ssh does for any other path.
  const remoteTempFilename = `.susentorno-share-cred-${suffix}`;
  const remoteTempPath = `~/${remoteTempFilename}`;
  // The remote shell does not expand `~` inside single quotes. Use the fixed
  // shell variable for the same home directory that scp resolved above.
  const remoteHomeTempPath = `"$HOME/${remoteTempFilename}"`;
  writeFileSync(localTempPath, `username=${opts.accountName}\npassword=${opts.password}\n`, {
    mode: 0o600,
  });
  try {
    onStep('copy credentials file');
    const { exitCode: copyExitCode } = await remoteExec.copyFile(localTempPath, remoteTempPath);
    if (copyExitCode !== 0) throw new MountShareError('copy credentials file', copyExitCode);

    // `;` between install and cleanup, not `&&`: the remote temp file (which
    // holds the plaintext share password) must be removed whether or not
    // `install` succeeds. `install_exit` is captured immediately after
    // `install` runs, before `rm` can overwrite `$?`, and `exit $install_exit`
    // makes the whole invocation still report install's own outcome.
    await runStep(
      remoteExec,
      'install credentials file',
      `sudo install -m 600 -o root -g root ${remoteHomeTempPath} /etc/susentorno-share.cred; ` +
        `install_exit=$?; rm -f ${remoteHomeTempPath}; exit $install_exit`,
      onStep,
    );
  } finally {
    rmSync(localTempPath, { force: true });
  }

  const mountPoint = `/mnt/${opts.shareName}`;
  // This check-and-unmount must run before 'create mount point' touches the
  // path at all: the fstab entry uses x-systemd.automount, so after isolation
  // re-points the source at a different host IP, the *old* autofs mount can
  // still be live at this path pointing at the now-unreachable Default-Switch
  // host IP — and merely stat'ing it (which `mkdir -p` does) trips ENODEV,
  // failing 'create mount point' before this cleanup ever got a chance to run.
  // Distinguish "not mounted" (skip straight past) from "mounted but failed to
  // unmount" (stop — swallowing a real unmount failure here would leave the
  // stale mount for 'mount -a' to silently skip over later).
  onStep('check active mount');
  const { exitCode: mountpointExitCode } = await remoteExec.run(
    `mountpoint -q ${quoteForRemoteShell(mountPoint)}`,
  );
  if (mountpointExitCode === 0) {
    await runStep(
      remoteExec,
      'unmount stale mount',
      `sudo umount ${quoteForRemoteShell(mountPoint)}`,
      onStep,
    );
  }
  await runStep(
    remoteExec,
    'create mount point',
    `sudo mkdir -p ${quoteForRemoteShell(mountPoint)}`,
    onStep,
  );
  await runStep(
    remoteExec,
    'update fstab',
    buildFstabReplaceCommand({
      shareName: opts.shareName,
      hostIp: opts.hostIp,
    }),
    onStep,
  );
  // Starting the generated automount unit, rather than `mount -a`, preserves
  // fstab's x-systemd.automount behaviour. `mount -a` eagerly performs a CIFS
  // mount and leaves the generated .automount unit inactive, which defeats the
  // reconnect behaviour needed when the VM changes switches.
  const automountUnit = `$(systemd-escape -p --suffix=automount ${quoteForRemoteShell(mountPoint)})`;
  await runStep(
    remoteExec,
    'mount share',
    `sudo systemctl daemon-reload && sudo systemctl start ${automountUnit}`,
    onStep,
  );
}
