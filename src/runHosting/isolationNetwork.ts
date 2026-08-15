import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { resolveHostNetworkNames } from '../hostNetwork/hostNetworkNames';
import { DEFAULT_INTERNAL_SWITCH_ADAPTER, resolveInternalSwitchNetwork } from './forwarder';

export type IsolationNetworkResolution =
  | { found: true; adapterAlias: string; address: string; netmask: string }
  | { found: false; adapterAlias: string };

/**
 * Turns an optional `--isolation-name` into the one Internal-switch network
 * `run-hosting` should bind: the adapter alias comes from
 * `resolveHostNetworkNames` (which also validates the name, throwing
 * HostNetworkError), and the address and netmask come from a SINGLE
 * `networkInterfaces()` snapshot of that adapter.
 *
 * That single snapshot is the point. Resolving the address and the netmask
 * independently — as run-hosting used to — let the second lookup miss or
 * disagree with the first, at which cost DHCP handed every guest a guessed /24.
 *
 * Lives here rather than in forwarder.ts because hostNetworkNames.ts already
 * imports DEFAULT_INTERNAL_SWITCH_ADAPTER from forwarder.ts; putting this
 * function there would close an import cycle.
 */
export function resolveIsolationNetwork(
  isolationName: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): IsolationNetworkResolution {
  const adapterAlias =
    isolationName === undefined
      ? DEFAULT_INTERNAL_SWITCH_ADAPTER
      : resolveHostNetworkNames(isolationName).adapterAlias;
  const network = resolveInternalSwitchNetwork(adapterAlias, interfaces);
  if (!network) return { found: false, adapterAlias };
  return { found: true, adapterAlias, address: network.address, netmask: network.netmask };
}
