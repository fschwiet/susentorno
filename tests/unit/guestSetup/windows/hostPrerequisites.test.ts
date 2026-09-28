import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import type { NetworkInterfaceInfo } from 'node:os';
import { resolveHostPrerequisites } from '../../../../src/guestSetup/windows/hostPrerequisites';

function execWith(elevated: boolean): PowerShellExec & { calls: number } {
  const exec = {
    calls: 0,
    async run() {
      exec.calls++;
      return { exitCode: 0, stdout: elevated ? 'True' : 'False' };
    },
  };
  return exec;
}

const v4 = (address: string): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal: false }) as NetworkInterfaceInfo;

const interfaces = {
  'vEthernet (susentorno-internal)': [v4('192.168.67.1')],
  'vEthernet (Default Switch)': [v4('172.29.240.1')],
};

const CWD = 'C:\\work\\project';
const SHARE = 'C:\\work\\project\\.susentorno\\vm-shared-windows';

function deps(overrides: { elevated?: boolean; existing?: string[] } = {}) {
  const existing = overrides.existing ?? ['C:\\work\\project\\.susentorno', SHARE];
  const exec = execWith(overrides.elevated ?? true);
  return {
    exec,
    cwd: CWD,
    exists: (path: string) => existing.includes(path),
    interfaces,
  };
}

const options = { natAdapterAlias: 'vEthernet (Default Switch)' };

describe('resolveHostPrerequisites', () => {
  it('resolves the environment, the Windows VM share, both switches and both host addresses', async () => {
    const result = await resolveHostPrerequisites(deps(), options);
    expect(result).toEqual({
      ok: true,
      context: {
        vmSharedWindowsPath: SHARE,
        natAdapterAlias: 'vEthernet (Default Switch)',
        defaultSwitchName: 'Default Switch',
        internalAdapterAlias: 'vEthernet (susentorno-internal)',
        internalSwitchName: 'susentorno-internal',
        internalSwitchHostIp: '192.168.67.1',
        defaultSwitchHostIp: '172.29.240.1',
      },
    });
  });

  it('honors an isolation name', async () => {
    const result = await resolveHostPrerequisites(
      {
        ...deps(),
        interfaces: { ...interfaces, 'vEthernet (susentorno-test-internal)': [v4('192.168.99.1')] },
      },
      { ...options, isolationName: 'test' },
    );
    expect(result).toMatchObject({
      ok: true,
      context: {
        internalSwitchName: 'susentorno-test-internal',
        internalSwitchHostIp: '192.168.99.1',
      },
    });
  });

  it('fails a non-elevated host first, before looking at the environment or the network', async () => {
    const seen: string[] = [];
    const result = await resolveHostPrerequisites(
      {
        ...deps({ elevated: false }),
        exists: (path) => {
          seen.push(path);
          return true;
        },
      },
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/elevated \(Administrator\)/);
    expect(seen).toEqual([]);
  });

  it('fails a missing environment with the init remediation', async () => {
    const result = await resolveHostPrerequisites(deps({ existing: [] }), options);
    expect(result).toEqual({
      ok: false,
      message: `no .susentorno in ${CWD} — run 'susentorno init' first`,
    });
  });

  it('fails an environment without the Windows VM share, naming the path and update-shares', async () => {
    const result = await resolveHostPrerequisites(
      deps({ existing: ['C:\\work\\project\\.susentorno'] }),
      options,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(SHARE);
      expect(result.message).toContain('update-shares');
    }
  });

  it('reports an invalid isolation name as a message', async () => {
    const result = await resolveHostPrerequisites(deps(), {
      ...options,
      isolationName: 'bad name!',
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain('only letters, digits, and hyphens are allowed');
  });

  it('fails an isolation name whose Internal switch has no host address, with the create-host-network hint', async () => {
    const result = await resolveHostPrerequisites(deps(), {
      ...options,
      isolationName: 'does-not-exist',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(
        "could not find an IPv4 address on adapter 'vEthernet (susentorno-does-not-exist-internal)'",
      );
      expect(result.message).toContain(
        "Run 'susentorno create-host-network --isolation-name does-not-exist' first.",
      );
    }
  });

  it('fails a NAT adapter alias that is not a vEthernet alias', async () => {
    const result = await resolveHostPrerequisites(deps(), {
      ...options,
      natAdapterAlias: 'Ethernet',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--nat-adapter-alias 'Ethernet'");
      expect(result.message).toContain('vEthernet (<switch name>)');
    }
  });

  it('fails a NAT adapter with no host address, naming the adapter', async () => {
    const result = await resolveHostPrerequisites(deps(), {
      ...options,
      natAdapterAlias: 'vEthernet (Other Switch)',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("adapter 'vEthernet (Other Switch)'");
    }
  });
});
