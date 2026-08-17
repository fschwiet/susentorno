import { execa } from 'execa';
import { quoteForRemoteShell } from './quoteForRemoteShell';

export interface RemoteExecResult {
  exitCode: number;
}

export interface RemoteExecCaptureResult extends RemoteExecResult {
  stdout: string;
}

/**
 * Injectable seam for "run this command on the guest and get its exit code
 * back." Production wires this to real ssh/scp (createSshRemoteExec, below);
 * tests/guest/ wires it to the existing QEMU-guest harness; unit tests wire
 * it to an in-memory fake. mountShare and runPreScripts are written once
 * against this interface.
 */
export interface RemoteExec {
  run(remoteCommand: string): Promise<RemoteExecResult>;
  copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult>;
}

/**
 * Widens RemoteExec with a read-only, stdout-capturing variant of run() — for
 * queries with no interactive output expected (sudo prompts, package-manager
 * progress), not a replacement for it. Kept as a separate interface rather
 * than added to RemoteExec directly, so every existing fake RemoteExec in the
 * test suite (which only ever implements run/copyFile) keeps compiling
 * unchanged; only code that actually needs captured stdout asks for this
 * wider type.
 */
export interface RemoteExecWithCapture extends RemoteExec {
  capture(remoteCommand: string): Promise<RemoteExecCaptureResult>;
}

export interface SshTarget {
  address: string;
  username: string;
}

/**
 * ssh joins trailing argv elements with a plain space and sends the result
 * to the remote shell as one string — it does not preserve argv boundaries
 * over the wire. remoteCommand must therefore already be a single,
 * shell-quoted argument by the time it reaches `bash -ic`, or bash -c would
 * treat only the first word as the script and the rest as positional
 * parameters.
 */
export function buildSshRunArgv(target: SshTarget, remoteCommand: string): string[] {
  return [
    '-t',
    `${target.username}@${target.address}`,
    'bash',
    '-ic',
    quoteForRemoteShell(remoteCommand),
  ];
}

export function buildScpArgv(
  target: SshTarget,
  localPath: string,
  remoteDestPath: string,
): string[] {
  return [localPath, `${target.username}@${target.address}:${remoteDestPath}`];
}

export function createSshRemoteExec(target: SshTarget): RemoteExecWithCapture {
  return {
    async run(remoteCommand: string): Promise<RemoteExecResult> {
      const result = await execa('ssh', buildSshRunArgv(target, remoteCommand), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
    async copyFile(localPath: string, remoteDestPath: string): Promise<RemoteExecResult> {
      const result = await execa('scp', buildScpArgv(target, localPath, remoteDestPath), {
        stdio: 'inherit',
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1 };
    },
    async capture(remoteCommand: string): Promise<RemoteExecCaptureResult> {
      const result = await execa('ssh', buildSshRunArgv(target, remoteCommand), {
        reject: false,
        all: true,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.all ?? '' };
    },
  };
}
