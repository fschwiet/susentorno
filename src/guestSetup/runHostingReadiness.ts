import { quoteForPowerShell } from './quoteForPowerShell';
import type { PowerShellExec } from './powerShellExec';

export function buildGetNetUdpEndpointCommand(localAddress: string, localPort: number): string {
  return `Get-NetUDPEndpoint -LocalAddress ${quoteForPowerShell(localAddress)} -LocalPort ${localPort}`;
}

/** Get-NetUDPEndpoint returns nothing (empty stdout, no error) when no endpoint matches. */
export function parseEndpointBound(stdout: string): boolean {
  return stdout.trim() !== '';
}

export interface RunHostingReadiness {
  dhcpBound: boolean;
  dnsBound: boolean;
}

export async function checkRunHostingReady(
  exec: PowerShellExec,
  internalSwitchHostIp: string,
): Promise<RunHostingReadiness> {
  const dhcpResult = await exec.run(buildGetNetUdpEndpointCommand(internalSwitchHostIp, 67));
  const dnsResult = await exec.run(buildGetNetUdpEndpointCommand(internalSwitchHostIp, 53));
  return {
    dhcpBound: parseEndpointBound(dhcpResult.stdout),
    dnsBound: parseEndpointBound(dnsResult.stdout),
  };
}
