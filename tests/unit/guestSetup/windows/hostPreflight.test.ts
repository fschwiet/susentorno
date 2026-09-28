import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import {
  buildGetSmbShareCommand,
  parseSmbSharePaths,
  runWindowsHostPreflight,
} from '../../../../src/guestSetup/windows/hostPreflight';

function fakeExec(responses: Record<string, string>): PowerShellExec & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async run(command: string) {
      commands.push(command);
      for (const [substring, stdout] of Object.entries(responses)) {
        if (command.includes(substring)) return { exitCode: 0, stdout };
      }
      return { exitCode: 0, stdout: '' };
    },
  };
}

const SHARE_DIR = 'C:\\work\\project\\.susentorno\\vm-shared-windows';

const ready = {
  "Get-VM -Name 'win-dev'": '{"Name":"win-dev","State":"Running"}',
  "Get-VMNetworkAdapter -VMName 'win-dev'": '{"SwitchName":"Default Switch","IPAddresses":[]}',
  "Get-VMSwitch -Name 'susentorno-internal'": '{"Name":"susentorno-internal"}',
  "Get-VMSwitch -Name 'Default Switch'": '{"Name":"Default Switch"}',
  '-LocalPort 67': 'bound',
  '-LocalPort 53': 'bound',
  "Get-SmbShare -Name 'vm-shared-windows'": JSON.stringify({
    Name: 'vm-shared-windows',
    Path: SHARE_DIR,
  }),
};

const baseOpts = {
  vmName: 'win-dev',
  shareName: 'vm-shared-windows',
  vmSharedWindowsPath: SHARE_DIR,
  internalAdapterAlias: 'vEthernet (susentorno-internal)',
  internalSwitchName: 'susentorno-internal',
  natAdapterAlias: 'vEthernet (Default Switch)',
  internalSwitchHostIp: '192.168.67.1',
};

async function failure(responses: Record<string, string>, overrides = {}): Promise<string> {
  const result = await runWindowsHostPreflight({
    ...baseOpts,
    ...overrides,
    exec: fakeExec({ ...ready, ...responses }),
  });
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.message;
}

describe('runWindowsHostPreflight', () => {
  it('accepts a Running VM on the Default Switch and reports what it found', async () => {
    const result = await runWindowsHostPreflight({ ...baseOpts, exec: fakeExec(ready) });
    expect(result).toEqual({
      ok: true,
      defaultSwitchName: 'Default Switch',
      vmState: 'Running',
      vmSwitchName: 'Default Switch',
    });
  });

  it.each([
    ['Off', 'Default Switch'],
    ['Off', 'susentorno-internal'],
    ['Running', 'susentorno-internal'],
  ])('accepts a %s VM on %s', async (state, switchName) => {
    const result = await runWindowsHostPreflight({
      ...baseOpts,
      exec: fakeExec({
        ...ready,
        "Get-VM -Name 'win-dev'": `{"Name":"win-dev","State":"${state}"}`,
        "Get-VMNetworkAdapter -VMName 'win-dev'": `{"SwitchName":"${switchName}","IPAddresses":[]}`,
      }),
    });
    expect(result).toMatchObject({ ok: true, vmState: state, vmSwitchName: switchName });
  });

  it.each(['Saved', 'Paused', 'Starting', 'Stopping', 'Saving'])(
    'rejects a %s VM, naming the VM, the state, and how to fix it',
    async (state) => {
      const message = await failure({
        "Get-VM -Name 'win-dev'": `{"Name":"win-dev","State":"${state}"}`,
      });
      expect(message).toContain("'win-dev'");
      expect(message).toContain(`'${state}'`);
      expect(message).toMatch(/'Running' or 'Off'/);
      expect(message).toMatch(/rerun/);
    },
  );

  it('rejects an unrelated switch, naming the VM, the switch, and both expected switches', async () => {
    const message = await failure({
      "Get-VMNetworkAdapter -VMName 'win-dev'": '{"SwitchName":"External","IPAddresses":[]}',
    });
    expect(message).toContain("'win-dev'");
    expect(message).toContain("'External'");
    expect(message).toContain("'Default Switch'");
    expect(message).toContain("'susentorno-internal'");
    expect(message).toMatch(/Connect-VMNetworkAdapter/);
  });

  it('rejects a disconnected adapter', async () => {
    const message = await failure({
      "Get-VMNetworkAdapter -VMName 'win-dev'": '{"SwitchName":null,"IPAddresses":[]}',
    });
    expect(message).toContain("'win-dev'");
    expect(message).toMatch(/not connected to any switch/);
  });

  it('rejects extra adapters through the shared preflight', async () => {
    const message = await failure({
      "Get-VMNetworkAdapter -VMName 'win-dev'":
        '[{"SwitchName":"Default Switch","IPAddresses":[]},{"SwitchName":"susentorno-internal","IPAddresses":[]}]',
    });
    expect(message).toContain('2 network adapters');
    expect(message).toContain("'win-dev'");
  });

  it('rejects a nonexistent VM with a remediation, before any share or listener rule', async () => {
    const exec = fakeExec({ ...ready, "Get-VM -Name 'win-dev'": '' });
    const result = await runWindowsHostPreflight({ ...baseOpts, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("no VM named exactly 'win-dev'");
      expect(result.message).toMatch(/Get-VM/);
    }
    expect(exec.commands.some((c) => c.includes('Get-SmbShare'))).toBe(false);
  });

  it('names the missing run-hosting listeners and tells the user to start it', async () => {
    const message = await failure({ '-LocalPort 67': '', '-LocalPort 53': '' });
    expect(message).toContain('run-hosting');
    expect(message).toContain('192.168.67.1');
    expect(message).toContain('DHCP (67)');
    expect(message).toContain('DNS (53)');
    expect(message).not.toContain('..');
  });

  it('rejects a share that does not exist, naming it and how to create it', async () => {
    const message = await failure({ "Get-SmbShare -Name 'vm-shared-windows'": '' });
    expect(message).toContain("'vm-shared-windows'");
    expect(message).toMatch(/does not exist/);
    expect(message).toContain(SHARE_DIR);
    expect(message).toMatch(/New-SmbShare/);
  });

  it('rejects a share that resolves to a different directory, naming both paths', async () => {
    const message = await failure({
      "Get-SmbShare -Name 'vm-shared-windows'": JSON.stringify({
        Name: 'vm-shared-windows',
        Path: 'C:\\other\\.susentorno\\vm-shared-windows',
      }),
    });
    expect(message).toContain('C:\\other\\.susentorno\\vm-shared-windows');
    expect(message).toContain(SHARE_DIR);
    expect(message).toContain("'vm-shared-windows'");
  });

  it('compares share paths without regard to case, slash direction, or a trailing slash', async () => {
    const result = await runWindowsHostPreflight({
      ...baseOpts,
      exec: fakeExec({
        ...ready,
        "Get-SmbShare -Name 'vm-shared-windows'": JSON.stringify({
          Name: 'VM-Shared-Windows',
          Path: 'c:/WORK/project/.susentorno/vm-shared-windows/',
        }),
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects the Linux VM share directory the same way as any other wrong path', async () => {
    const message = await failure({
      "Get-SmbShare -Name 'vm-shared-windows'": JSON.stringify({
        Name: 'vm-shared-windows',
        Path: 'C:\\work\\project\\.susentorno\\vm-shared-linux',
      }),
    });
    expect(message).toContain('vm-shared-linux');
  });
});

describe('the SMB share query', () => {
  it('quotes the share name for PowerShell', () => {
    expect(buildGetSmbShareCommand("it's")).toContain("-Name 'it''s'");
  });

  it('keeps only entries whose name matches exactly, because -Name accepts wildcards', () => {
    expect(
      parseSmbSharePaths(
        JSON.stringify([
          { Name: 'vm-shared-windows-2', Path: 'C:\\a' },
          { Name: 'VM-SHARED-WINDOWS', Path: 'C:\\b' },
        ]),
        'vm-shared-windows',
      ),
    ).toEqual(['C:\\b']);
    expect(parseSmbSharePaths('', 'x')).toEqual([]);
  });
});
