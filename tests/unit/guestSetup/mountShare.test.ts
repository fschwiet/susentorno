import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import { mountShare, MountShareError } from '../../../src/guestSetup/mountShare';

function fakeRemoteExec(
  overrides: {
    runResults?: Record<string, number>;
    copyResult?: number;
  } = {},
): { remoteExec: RemoteExec; calls: string[]; copiedFiles: [string, string][] } {
  const calls: string[] = [];
  const copiedFiles: [string, string][] = [];
  const remoteExec: RemoteExec = {
    async run(command: string): Promise<RemoteExecResult> {
      calls.push(command);
      for (const [substring, exitCode] of Object.entries(overrides.runResults ?? {})) {
        if (command.includes(substring)) return { exitCode };
      }
      return { exitCode: 0 };
    },
    async copyFile(local: string, remote: string): Promise<RemoteExecResult> {
      copiedFiles.push([local, remote]);
      return { exitCode: overrides.copyResult ?? 0 };
    },
  };
  return { remoteExec, calls, copiedFiles };
}

describe('mountShare', () => {
  it('runs cifs-utils install, delivers credentials, creates the mount point, updates fstab, and mounts', async () => {
    const { remoteExec, calls, copiedFiles } = fakeRemoteExec();
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      defaultSwitchHostIp: '172.28.128.1',
    });

    expect(calls[0]).toBe('sudo apt-get install -y cifs-utils');
    expect(copiedFiles).toHaveLength(1);
    expect(
      calls.some(
        (c) => c.includes('sudo install -m 600') && c.includes('/etc/susentorno-share.cred'),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes('sudo mkdir -p') && c.includes('/mnt/vm-shared-linux')),
    ).toBe(true);
    expect(calls.some((c) => c.includes('/etc/fstab'))).toBe(true);
    expect(calls[calls.length - 1]).toBe('sudo systemctl daemon-reload && sudo mount -a');
  });

  it('writes the credentials file locally with the account name and password before copying it, then deletes it', async () => {
    let capturedContents = '';
    let capturedLocalPath = '';
    const remoteExec: RemoteExec = {
      async run(): Promise<RemoteExecResult> {
        return { exitCode: 0 };
      },
      async copyFile(local: string): Promise<RemoteExecResult> {
        capturedLocalPath = local;
        capturedContents = readFileSync(local, 'utf8');
        return { exitCode: 0 };
      },
    };
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      defaultSwitchHostIp: '172.28.128.1',
    });
    expect(capturedContents).toBe('username=susentorno-share\npassword=hunter2\n');
    expect(existsSync(capturedLocalPath)).toBe(false); // deleted after mountShare returns
  });

  it('stops at the first failing step and reports which one', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ runResults: { 'cifs-utils': 1 } });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        defaultSwitchHostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls).toEqual(['sudo apt-get install -y cifs-utils']); // nothing after the failure ran
  });

  it('stops if the credentials-file copy fails', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ copyResult: 1 });
    await expect(
      mountShare(remoteExec, {
        shareName: 'vm-shared-linux',
        accountName: 'susentorno-share',
        password: 'hunter2',
        defaultSwitchHostIp: '172.28.128.1',
      }),
    ).rejects.toThrow(MountShareError);
    expect(calls.some((c) => c.includes('sudo install -m 600'))).toBe(false);
  });

  it('constructs the install step so the remote temp file is removed even if install fails', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await mountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      accountName: 'susentorno-share',
      password: 'hunter2',
      defaultSwitchHostIp: '172.28.128.1',
    });
    const installCall = calls.find((c) => c.includes('sudo install -m 600'))!;
    expect(installCall).toContain('rm -f');
    expect(installCall).toMatch(/"\$HOME\/\.susentorno-share-cred-[a-f0-9]+"/);
    expect(installCall).not.toContain("'~/.susentorno-share-cred-");
    // Cleanup must not be gated behind install succeeding (`&&`) — a failed
    // install must not leave the password file sitting on the guest.
    expect(installCall).not.toMatch(/sudo install[^;]*&&[^;]*rm -f/);
  });
});
