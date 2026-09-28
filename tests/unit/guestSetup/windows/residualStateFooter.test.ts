import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../../src/guestSetup/powerShellExec';
import {
  formatResidualStateFooter,
  queryResidualVmState,
} from '../../../../src/guestSetup/windows/residualStateFooter';

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

const running = {
  "Get-VM -Name 'win-dev'": '{"Name":"win-dev","State":"Running"}',
  "Get-VMNetworkAdapter -VMName 'win-dev'": '{"SwitchName":"Default Switch","IPAddresses":[]}',
};

describe('queryResidualVmState', () => {
  it('asks Hyper-V for the power state and switch rather than inferring them', async () => {
    const exec = fakeExec(running);
    expect(await queryResidualVmState(exec, 'win-dev')).toEqual({
      known: true,
      powerState: 'Running',
      switchName: 'Default Switch',
    });
    expect(exec.commands.some((c) => c.startsWith('Get-VM '))).toBe(true);
    expect(exec.commands.some((c) => c.startsWith('Get-VMNetworkAdapter '))).toBe(true);
  });

  it('reports a disconnected adapter as no switch', async () => {
    const exec = fakeExec({
      ...running,
      "Get-VMNetworkAdapter -VMName 'win-dev'": '{"SwitchName":null,"IPAddresses":[]}',
    });
    expect(await queryResidualVmState(exec, 'win-dev')).toEqual({
      known: true,
      powerState: 'Running',
      switchName: null,
    });
  });

  it('reports an unknown VM without throwing', async () => {
    const result = await queryResidualVmState(fakeExec({}), 'win-dev');
    expect(result.known).toBe(false);
  });

  it('reports a failing query without throwing', async () => {
    const exec: PowerShellExec = {
      async run() {
        throw new Error('powershell.exe crashed');
      },
    };
    const result = await queryResidualVmState(exec, 'win-dev');
    expect(result).toEqual({ known: false, reason: 'powershell.exe crashed' });
  });
});

describe('formatResidualStateFooter', () => {
  const vm = { known: true as const, powerState: 'Running', switchName: 'Default Switch' };

  it('names the failed phase, the queried VM state and switch, and the rerun instruction', () => {
    const lines = formatResidualStateFooter({
      outcome: 'failure',
      phase: 'G3 guest structural checks',
      vmName: 'win-dev',
      vm,
    });
    expect(lines).toEqual([
      'setup-guest-windows: residual state',
      '  Failed in phase: G3 guest structural checks',
      "  VM 'win-dev': Running, attached to 'Default Switch'",
      '  Nothing was rolled back.',
      "  Rerun 'susentorno setup-guest-windows' to replay the whole flow from the Default Switch.",
    ]);
  });

  it('says cancelled for a cancellation', () => {
    const lines = formatResidualStateFooter({
      outcome: 'cancelled',
      phase: 'G2 PowerShell Direct readiness',
      vmName: 'win-dev',
      vm,
    });
    expect(lines[1]).toBe('  Cancelled during phase: G2 PowerShell Direct readiness');
  });

  it('includes the failed step filename when there is one', () => {
    const lines = formatResidualStateFooter({
      outcome: 'failure',
      phase: 'G13 post-isolation steps',
      stepFilename: '99-fail.ps1',
      vmName: 'win-dev',
      vm: { known: true, powerState: 'Off', switchName: 'susentorno-internal' },
    });
    expect(lines).toContain('  Failed step: 99-fail.ps1');
    expect(lines).toContain("  VM 'win-dev': Off, attached to 'susentorno-internal'");
  });

  it('describes a disconnected adapter', () => {
    const lines = formatResidualStateFooter({
      outcome: 'failure',
      phase: 'G1',
      vmName: 'win-dev',
      vm: { known: true, powerState: 'Off', switchName: null },
    });
    expect(lines).toContain("  VM 'win-dev': Off, not attached to any switch");
  });

  it('says the VM was never chosen when the run ended before a VM name existed', () => {
    const lines = formatResidualStateFooter({
      outcome: 'cancelled',
      phase: 'H1 host prerequisites',
    });
    expect(lines).toContain('  No VM was chosen, so nothing was changed.');
    expect(lines.join('\n')).not.toContain('Nothing was rolled back');
  });

  it('says so when the VM state could not be queried', () => {
    const lines = formatResidualStateFooter({
      outcome: 'failure',
      phase: 'G1',
      vmName: 'win-dev',
      vm: { known: false, reason: 'no such VM' },
    });
    expect(lines).toContain("  VM 'win-dev': its state could not be queried (no such VM)");
  });
});
