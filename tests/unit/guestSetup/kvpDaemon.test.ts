import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import {
  ensureKvpDaemon,
  EnsureKvpDaemonError,
  KVP_DAEMON_PACKAGE,
} from '../../../src/guestSetup/kvpDaemon';

describe('ensureKvpDaemon', () => {
  it('installs the KVP daemon package', async () => {
    const calls: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        calls.push(command);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('ensureKvpDaemon should never call copyFile');
      },
    };
    await ensureKvpDaemon(remoteExec);
    expect(calls).toEqual([`sudo apt-get install -y '${KVP_DAEMON_PACKAGE}'`]);
  });

  it('reports the step before running it', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('unused');
      },
    };
    await ensureKvpDaemon(remoteExec, (message) => events.push(`step:${message}`));
    expect(events[0]).toBe(`step:install ${KVP_DAEMON_PACKAGE}`);
    expect(events[1]).toBe(`run:sudo apt-get install -y '${KVP_DAEMON_PACKAGE}'`);
  });

  it('throws EnsureKvpDaemonError on a non-zero exit', async () => {
    const remoteExec: RemoteExec = {
      async run(): Promise<RemoteExecResult> {
        return { exitCode: 1 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('unused');
      },
    };
    await expect(ensureKvpDaemon(remoteExec)).rejects.toThrow(EnsureKvpDaemonError);
  });
});
