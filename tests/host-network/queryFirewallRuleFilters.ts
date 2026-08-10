import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';

export interface RuleFilterSnapshot {
  displayName: string;
  protocol: string;
  localPort: string;
  interfaceAlias: string;
  localAddress: string;
  program: string;
  enabled: boolean;
  direction: string;
  action: string;
}

/**
 * Mirrors templates/proxy/verify-proxy.ps1's Test-RuleTuple: a rule's
 * DisplayName alone says nothing about its actual port/address/interface/
 * program scoping, so this reads every filter object a real assertion needs.
 */
export function buildQueryRuleFiltersCommand(displayNamePattern: string): string {
  return (
    `Get-NetFirewallRule -DisplayName ${quoteForPowerShell(displayNamePattern)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { ` +
    `$portFilter = $_ | Get-NetFirewallPortFilter; $addrFilter = $_ | Get-NetFirewallAddressFilter; ` +
    `$ifFilter = $_ | Get-NetFirewallInterfaceFilter; $appFilter = $_ | Get-NetFirewallApplicationFilter; ` +
    `[PSCustomObject]@{ DisplayName = $_.DisplayName; Protocol = $portFilter.Protocol; ` +
    `LocalPort = ($portFilter.LocalPort -join ','); InterfaceAlias = $ifFilter.InterfaceAlias; ` +
    `LocalAddress = $addrFilter.LocalAddress; Program = $appFilter.Program; ` +
    `Enabled = $_.Enabled.ToString(); Direction = $_.Direction.ToString(); Action = $_.Action.ToString() ` +
    `} } | ConvertTo-Json -Compress`
  );
}

interface RawFilterSnapshot {
  DisplayName?: unknown;
  Protocol?: unknown;
  LocalPort?: unknown;
  InterfaceAlias?: unknown;
  LocalAddress?: unknown;
  Program?: unknown;
  Enabled?: unknown;
  Direction?: unknown;
  Action?: unknown;
}

export function parseRuleFilterSnapshots(stdout: string): RuleFilterSnapshot[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawFilterSnapshot[];
  return list.map((r) => ({
    displayName: String(r.DisplayName ?? ''),
    protocol: String(r.Protocol ?? ''),
    localPort: String(r.LocalPort ?? ''),
    interfaceAlias: String(r.InterfaceAlias ?? ''),
    localAddress: String(r.LocalAddress ?? ''),
    program: String(r.Program ?? ''),
    enabled: String(r.Enabled ?? '') === 'True',
    direction: String(r.Direction ?? ''),
    action: String(r.Action ?? ''),
  }));
}

export async function queryRuleFilters(
  exec: PowerShellExec,
  displayNamePattern: string,
): Promise<RuleFilterSnapshot[]> {
  const result = await exec.run(buildQueryRuleFiltersCommand(displayNamePattern));
  return parseRuleFilterSnapshots(result.stdout);
}
