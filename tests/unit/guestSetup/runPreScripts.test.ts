import { describe, it, expect } from 'vitest';
import type { RemoteExec, RemoteExecResult } from '../../../src/guestSetup/remoteExec';
import type { PreScript } from '../../../src/guestSetup/listPreScripts';
import { runPreScripts, RunPreScriptsError } from '../../../src/guestSetup/runPreScripts';

function script(filename: string, slug: string): PreScript {
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
      throw new Error('runPreScripts should never call copyFile');
    },
  };
  return { remoteExec, calls };
}

describe('runPreScripts', () => {
  it('runs every script in order from the share pre-scripts directory, with no arguments by default', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [
        script('01-apt-packages.sh', 'apt-packages'),
        script('02-install-pnpm.sh', 'install-pnpm'),
      ],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/pre-scripts' && './01-apt-packages.sh'",
      "cd '/mnt/vm-shared-linux/pre-scripts' && './02-install-pnpm.sh'",
    ]);
  });

  it('passes the internal-switch host IP only to the exact configure-network slug', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [
        script('01-apt-packages.sh', 'apt-packages'),
        script('05-configure-network.sh', 'configure-network'),
      ],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls[0]).toBe("cd '/mnt/vm-shared-linux/pre-scripts' && './01-apt-packages.sh'");
    expect(calls[1]).toBe(
      "cd '/mnt/vm-shared-linux/pre-scripts' && './05-configure-network.sh' '192.168.67.1'",
    );
  });

  it('does not special-case a custom script whose slug merely contains configure-network', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [script('03-preconfigure-network-tools.sh', 'preconfigure-network-tools')],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls).toEqual([
      "cd '/mnt/vm-shared-linux/pre-scripts' && './03-preconfigure-network-tools.sh'",
    ]);
  });

  it('quotes a script filename containing shell metacharacters', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await runPreScripts(remoteExec, {
      scripts: [script('06-a b;c.sh', 'a b;c')],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
    });
    expect(calls).toEqual(["cd '/mnt/vm-shared-linux/pre-scripts' && './06-a b;c.sh'"]);
  });

  it('stops at the first non-zero exit and reports which script failed', async () => {
    const { remoteExec, calls } = fakeRemoteExec((command) =>
      command.includes('02-install-pnpm.sh') ? 1 : 0,
    );
    await expect(
      runPreScripts(remoteExec, {
        scripts: [
          script('01-apt-packages.sh', 'apt-packages'),
          script('02-install-pnpm.sh', 'install-pnpm'),
          script('03-install-tools.sh', 'install-tools'),
        ],
        shareName: 'vm-shared-linux',
        internalSwitchHostIp: '192.168.67.1',
      }),
    ).rejects.toThrow(RunPreScriptsError);
    expect(calls).toHaveLength(2); // 03 never ran
  });

  it('fails fast, before running anything, if more than one script resolves to configure-network', async () => {
    const { remoteExec, calls } = fakeRemoteExec();
    await expect(
      runPreScripts(remoteExec, {
        scripts: [
          script('01-configure-network.sh', 'configure-network'),
          script('02-configure-network.sh', 'configure-network'),
        ],
        shareName: 'vm-shared-linux',
        internalSwitchHostIp: '192.168.67.1',
      }),
    ).rejects.toThrow(/more than one pre-script resolves to 'configure-network'/);
    expect(calls).toHaveLength(0);
  });

  it('reports each script to onStep immediately before running it, interleaved in order', async () => {
    // Shared event log, same reasoning as mountShare's Task 4 test: proves
    // onStep fires before remoteExec.run for each script, not just that both
    // eventually fire.
    const events: string[] = [];
    const remoteExec: RemoteExec = {
      async run(command: string): Promise<RemoteExecResult> {
        events.push(`run:${command}`);
        return { exitCode: 0 };
      },
      async copyFile(): Promise<RemoteExecResult> {
        throw new Error('runPreScripts should never call copyFile');
      },
    };
    await runPreScripts(remoteExec, {
      scripts: [
        script('01-apt-packages.sh', 'apt-packages'),
        script('02-install-pnpm.sh', 'install-pnpm'),
      ],
      shareName: 'vm-shared-linux',
      internalSwitchHostIp: '192.168.67.1',
      onStep: (message) => events.push(`step:${message}`),
    });
    expect(events).toEqual([
      'step:running 01-apt-packages.sh',
      "run:cd '/mnt/vm-shared-linux/pre-scripts' && './01-apt-packages.sh'",
      'step:running 02-install-pnpm.sh',
      "run:cd '/mnt/vm-shared-linux/pre-scripts' && './02-install-pnpm.sh'",
    ]);
  });
});
