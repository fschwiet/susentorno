import { deriveSwitchName } from '../guestSetup/switchName';
import { DEFAULT_INTERNAL_SWITCH_ADAPTER } from '../runHosting/forwarder';
import { HostNetworkError } from './hostNetworkError';

export { HostNetworkError };

const ISOLATION_NAME_RE = /^[A-Za-z0-9-]+$/;

export interface HostNetworkNames {
  switchName: string;
  adapterAlias: string;
  envoyRuleName: string;
  dnsRuleName: string;
  dhcpRuleName: string;
  smbRuleName: string;
}

/**
 * `--isolation-name` is derived directly into PowerShell -Name/-DisplayName
 * queries, both of which are wildcard-tolerant (Get-VMSwitch -Name,
 * Get-NetFirewallRule -DisplayName). Restricting it to a safe character set
 * up front — no `*`, `?`, `[`, `]`, spaces, quotes — is what makes reusing
 * those queries as-is safe, without needing separate exact-match filtering.
 */
export function resolveHostNetworkNames(isolationName?: string): HostNetworkNames {
  if (isolationName !== undefined && !ISOLATION_NAME_RE.test(isolationName)) {
    throw new HostNetworkError(
      `--isolation-name '${isolationName}' is invalid: only letters, digits, and hyphens are allowed.`,
    );
  }

  const baseSwitchName = deriveSwitchName(DEFAULT_INTERNAL_SWITCH_ADAPTER);
  if (!baseSwitchName) {
    throw new HostNetworkError(
      `DEFAULT_INTERNAL_SWITCH_ADAPTER '${DEFAULT_INTERNAL_SWITCH_ADAPTER}' is not a valid vEthernet adapter alias.`,
    );
  }

  const switchName = isolationName ? `susentorno-${isolationName}-internal` : baseSwitchName;
  const prefix = isolationName ? `susentorno-${isolationName}` : 'susentorno';

  return {
    switchName,
    adapterAlias: `vEthernet (${switchName})`,
    envoyRuleName: `${prefix} Envoy Proxy (VM inbound)`,
    dnsRuleName: `${prefix} DNS stub (VM inbound)`,
    dhcpRuleName: `${prefix} DHCP (VM inbound)`,
    smbRuleName: `${prefix} share (VM inbound)`,
  };
}

/**
 * The remedy both `run-hosting` and `setup-guest-unix` print when an isolation
 * name resolves to an adapter that isn't on this host. Shared so the two
 * commands fail identically for the same underlying cause: the overwhelmingly
 * likely one is that `create-host-network` was never run for that name.
 */
export function createHostNetworkHint(isolationName?: string): string {
  const flag = isolationName === undefined ? '' : ` --isolation-name ${isolationName}`;
  return `Run 'susentorno create-host-network${flag}' first.`;
}
