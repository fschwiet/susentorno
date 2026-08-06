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
  defaultSwitchHostIp: string;
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
      hostIp: opts.defaultSwitchHostIp,
    }),
    onStep,
  );
  await runStep(remoteExec, 'mount share', 'sudo systemctl daemon-reload && sudo mount -a', onStep);
}
