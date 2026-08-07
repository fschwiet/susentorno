import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import type { GuestScript } from '../../../src/guestSetup/listScripts';
import { runPostScripts, RunPostScriptsError } from '../../../src/guestSetup/runPostScripts';

function script(filename: string, slug: string): GuestScript {
  return { path: `/local/${filename}`, filename, slug };
}

function fakeRemoteExec(exitCodeFor: (command: string) => number = () => 0): {
  remoteExec: RemoteExec;
  calls: string[];
} {
  const calls: string[] = [];
  const remoteExec: RemoteExec = {
    async run(command: string): Promise<RemoteExecResult> {
      calls.push(command);
      return { exitCode: exitCodeFor(command) };
    },
    async copyFile(): Promise<RemoteExecResult> {
      throw new Error('runPostScripts should never call copyFile');
    },
  };
  return { remoteExec, calls };
}

describe('runPostScripts', () => {
  it('runs every script in order from the share post-scripts directory, with no arguments', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPostScripts(remoteExec, {
      scripts: [
        script('01-auth-config.sh', 'auth-config'),
        script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms'),
      ],
      shareName: 'vm-shared-linux',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/post-scripts' && './01-auth-config.sh'",
      "cd '/mnt/vm-shared-linux/post-scripts' && './02-apply-home-jq-transforms.sh'",
    ]);
  });

  it('quotes a script filename containing shell metacharacters', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPostScripts(remoteExec, {
      scripts: [script('03-a b;c.sh', 'a b;c')],
      shareName: 'vm-shared-linux',
    });
    expect(calls).toEqual(["cd '/mnt/vm-shared-linux/post-scripts' && './03-a b;c.sh'"]);
  });

  it('stops at the first non-zero exit and reports which script failed', async () => {
    const { remoteExec, calls } = fakeRemoteExec((command) =>
      command.includes('02-apply-home-jq-transforms.sh') ? 1 : 0,
    );
    await expect(
      runPostScripts(remoteExec, {
        scripts: [
          script('01-auth-config.sh', 'auth-config'),
          script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms'),
        ],
        shareName: 'vm-shared-linux',
      }),
    ).rejects.toThrow(RunPostScriptsError);
    expect(calls).toHaveLength(2);
  });

  it('reports each script to onStep immediately before running it, interleaved in order', async () => {
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('runPostScripts should never call copyFile');
      },
    };
    await runPostScripts(remoteExec, {
      scripts: [
        script('01-auth-config.sh', 'auth-config'),
        script('02-apply-home-jq-transforms.sh', 'apply-home-jq-transforms'),
      ],
      shareName: 'vm-shared-linux',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events).toEqual([
      'step:running 01-auth-config.sh',
      "run:cd '/mnt/vm-shared-linux/post-scripts' && './01-auth-config.sh'",
      'step:running 02-apply-home-jq-transforms.sh',
      "run:cd '/mnt/vm-shared-linux/post-scripts' && './02-apply-home-jq-transforms.sh'",
    ]);
  });
});
