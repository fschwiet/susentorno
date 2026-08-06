import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import { remountShare, RemountShareError } from '../../../src/guestSetup/remountShare';

function fakeRemoteExec(runResults: Record<string, number> = {}): {
  remoteExec: RemoteExec;
  calls: string[];
} {
  const calls: string[] = [];
  const remoteExec: RemoteExec = {
    async run(command: string): Promise<RemoteExecResult> {
      calls.push(command);
      for (const [substring, exitCode] of Object.entries(runResults)) {
        if (command.includes(substring)) return { exitCode };
      }
      return { exitCode: 0 };
    },
    async copyFile(): Promise<RemoteExecResult> {
      throw new Error('remountShare should never copy files');
    },
  };
  return { remoteExec, calls };
}

describe('remountShare', () => {
  it('updates fstab, reloads systemd, clears stale mount state, and confirms reachability', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await remountShare(remoteExec, { shareName: 'vm-shared-linux', hostIp: '192.168.67.1' });

    expect(calls[0]).toContain('/etc/fstab');
    expect(calls[0]).toContain('192.168.67.1');
    expect(calls[1]).toBe('sudo systemctl daemon-reload');
    expect(calls[2]).toContain('sudo umount');
    expect(calls[2]).toContain('/mnt/vm-shared-linux');
    expect(calls[2]).toContain('sudo systemctl reset-failed');
    expect(calls[3]).toBe("stat '/mnt/vm-shared-linux' > /dev/null");
  });

  it('stops at the first failing step and reports which one', async () => {
    const { remoteExec, calls } = fakeRemoteExec({ 'daemon-reload': 1 });
    await expect(
      remountShare(remoteExec, { shareName: 'vm-shared-linux', hostIp: '192.168.67.1' }),
    ).rejects.toThrow(RemountShareError);
    expect(calls).toHaveLength(2); // fstab update ran, daemon-reload failed, nothing after ran
  });

  it('fails when the share is not reachable after the fstab update', async () => {
    const { remoteExec } = fakeRemoteExec({ stat: 1 });
    await expect(
      remountShare(remoteExec, { shareName: 'vm-shared-linux', hostIp: '192.168.67.1' }),
    ).rejects.toThrow(/confirm share is reachable/);
  });

  it("ends the clear-stale-mount-state command with `; true` so a real shell always reports success", async () => {
    // umount (nothing mounted) and systemctl reset-failed (nothing failed)
    // both legitimately exit non-zero when there's nothing to do; the
    // trailing `true` is what makes the compound command's own exit code 0
    // regardless. A fake RemoteExec can't simulate that partial failure
    // itself (it only sees one exit code per whole command), so this checks
    // the command string carries the guarantee instead.
    const { remoteExec, calls } = fakeRemoteExec();
    await remountShare(remoteExec, { shareName: 'vm-shared-linux', hostIp: '192.168.67.1' });
    const clearStep = calls.find((c) => c.includes('umount'))!;
    expect(clearStep.trimEnd()).toMatch(/;\s*true$/);
  });

  it('reports each step to onStep immediately before the operation it describes runs, in order', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('remountShare should never copy files');
      },
    };
    await remountShare(remoteExec, {
      shareName: 'vm-shared-linux',
      hostIp: '192.168.67.1',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events.map((e) => e.split(':')[0])).toEqual([
      'step',
      'run',
      'step',
      'run',
      'step',
      'run',
      'step',
      'run',
    ]);
    expect(events[0]).toBe('step:update fstab');
    expect(events[2]).toBe('step:reload systemd units');
    expect(events[4]).toBe('step:clear stale mount state');
    expect(events[6]).toBe('step:confirm share is reachable');
  });

  it('works with no onStep given', async () => {
    const { remoteExec } = fakeRemoteExec();
    await expect(
      remountShare(remoteExec, { shareName: 'vm-shared-linux', hostIp: '192.168.67.1' }),
    ).resolves.toBeUndefined();
  });
});
