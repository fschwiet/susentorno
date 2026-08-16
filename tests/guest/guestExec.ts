import { execa } from 'execa';
import { join } from 'node:path';
import {
  buildScpArgv,
  buildSshRunArgv,
  type RemoteExec,
  type RemoteExecResult,
  type SshTarget,
} from '../../src/guestSetup/remoteExec';
import { harnessKeyPath, imageCacheDir } from './hyperv/imageCache';
export const HARNESS_KNOWN_HOSTS_PATH = join(imageCacheDir, 'harness-known-hosts');
export function buildHarnessSshOptions(): string[] {
  return [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${HARNESS_KNOWN_HOSTS_PATH}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    harnessKeyPath,
  ];
}
export function createHarnessRemoteExec(target: SshTarget): RemoteExec {
  const options = buildHarnessSshOptions();
  const run = async (command: 'ssh' | 'scp', args: string[]): Promise<RemoteExecResult> => {
    const result = await execa(command, [...options, ...args], { reject: false, all: true });
    return { exitCode: result.exitCode ?? 1 };
  };
  return {
    run: (remoteCommand) => run('ssh', buildSshRunArgv(target, remoteCommand)),
    copyFile: (localPath, remoteDestPath) =>
      run('scp', buildScpArgv(target, localPath, remoteDestPath)),
  };
}
export async function guestCapture(
  target: SshTarget,
  remoteCommand: string,
): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa(
    'ssh',
    [...buildHarnessSshOptions(), ...buildSshRunArgv(target, remoteCommand)],
    { reject: false, all: true },
  );
  return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
}
