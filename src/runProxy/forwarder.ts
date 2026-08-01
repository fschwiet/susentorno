import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export const DEFAULT_INTERNAL_SWITCH_ADAPTER = 'vEthernet (susentorno-internal)';
export interface InternalSwitchNetwork {
  address: string;
  netmask: string;
}
export function resolveInternalSwitchNetwork(
  adapterName: string = DEFAULT_INTERNAL_SWITCH_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): InternalSwitchNetwork | null {
  const addrs = interfaces[adapterName];
  if (!addrs) return null;
  for (const a of addrs)
    if (a.family === 'IPv4' && !a.internal) return { address: a.address, netmask: a.netmask };
  return null;
}

/**
 * IPv4 address of the Hyper-V Internal-switch host adapter to forward from, or
 * null if the adapter is not present. `interfaces` is injectable for testing.
 */
export function resolveForwardListenAddress(
  adapterName: string = DEFAULT_INTERNAL_SWITCH_ADAPTER,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  return resolveInternalSwitchNetwork(adapterName, interfaces)?.address ?? null;
}
