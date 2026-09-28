import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { resolveForwardListenAddress } from '../runHosting/forwarder';
import { createHostNetworkHint, resolveHostNetworkNames } from '../hostNetwork/hostNetworkNames';

export interface ResolvedGuestNetwork {
  internalAdapterAlias: string;
  internalSwitchName: string;
  internalSwitchHostIp: string;
  defaultSwitchHostIp: string;
}

export interface GuestNetworkResolutionFailure {
  adapterAlias: string;
  hint: string;
}

export function resolveGuestNetwork(
  isolationName: string | undefined,
  natAdapterAlias: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): ResolvedGuestNetwork | GuestNetworkResolutionFailure {
  const names = resolveHostNetworkNames(isolationName);
  const internalSwitchHostIp = resolveForwardListenAddress(names.adapterAlias, interfaces);
  if (!internalSwitchHostIp) {
    return { adapterAlias: names.adapterAlias, hint: createHostNetworkHint(isolationName) };
  }
  const defaultSwitchHostIp = resolveForwardListenAddress(natAdapterAlias, interfaces);
  if (!defaultSwitchHostIp) {
    return {
      adapterAlias: natAdapterAlias,
      hint: 'Pass --nat-adapter-alias, or attach the guest to the Default Switch first.',
    };
  }
  return {
    internalAdapterAlias: names.adapterAlias,
    internalSwitchName: names.switchName,
    internalSwitchHostIp,
    defaultSwitchHostIp,
  };
}

export function isGuestNetworkResolutionFailure(
  result: ResolvedGuestNetwork | GuestNetworkResolutionFailure,
): result is GuestNetworkResolutionFailure {
  return 'hint' in result;
}
