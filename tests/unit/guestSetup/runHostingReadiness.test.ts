import { describe, it, expect } from 'vitest';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildGetNetUdpEndpointCommand,
  parseEndpointBound,
  checkRunHostingReady,
} from '../../../src/guestSetup/runHostingReadiness';

describe('buildGetNetUdpEndpointCommand', () => {
  it('quotes the address and includes the port', () => {
    expect(buildGetNetUdpEndpointCommand('192.168.67.1', 67)).toBe(
      "Get-NetUDPEndpoint -LocalAddress '192.168.67.1' -LocalPort 67",
    );
  });
});

describe('parseEndpointBound', () => {
  it('is false for empty stdout', () => {
    expect(parseEndpointBound('')).toBe(false);
    expect(parseEndpointBound('   \n')).toBe(false);
  });

  it('is true for any non-empty stdout', () => {
    expect(parseEndpointBound('LocalAddress : 192.168.67.1')).toBe(true);
  });
});

describe('checkRunHostingReady', () => {
  it('reports both bound when both ports return output', async () => {
    const exec: PowerShellExec = {
      async run() {
        return { exitCode: 0, stdout: 'bound' };
      },
    };
    expect(await checkRunHostingReady(exec, '192.168.67.1')).toEqual({
      dhcpBound: true,
      dnsBound: true,
    });
  });

  it('reports each port independently', async () => {
    const exec: PowerShellExec = {
      async run(command: string) {
        return { exitCode: 0, stdout: command.includes('-LocalPort 67') ? 'bound' : '' };
      },
    };
    expect(await checkRunHostingReady(exec, '192.168.67.1')).toEqual({
      dhcpBound: true,
      dnsBound: false,
    });
  });
});
