import { quoteForPowerShell } from '../guestSetup/quoteForPowerShell';
import { MUTATION_TRY_CATCH_SUFFIX } from './hostNetworkError';

export function buildCreateEnvoyRuleCommand(
  ruleName: string,
  adapterAlias: string,
  hostIp: string,
  nodePath: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol TCP ` +
    `-LocalPort 80,443 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-LocalAddress ${quoteForPowerShell(hostIp)} -Action Allow -ErrorAction Stop | Out-Null } ` +
    MUTATION_TRY_CATCH_SUFFIX
  );
}

export function buildCreateDnsRuleCommand(
  ruleName: string,
  adapterAlias: string,
  hostIp: string,
  nodePath: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol UDP ` +
    `-LocalPort 53 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-LocalAddress ${quoteForPowerShell(hostIp)} -Action Allow -ErrorAction Stop | Out-Null } ` +
    MUTATION_TRY_CATCH_SUFFIX
  );
}

/** DHCP has no fixed destination address to scope to (a client without an address broadcasts DISCOVER from 0.0.0.0), so -LocalAddress is never added here — the one deliberate exception among these four rule sets. */
export function buildCreateDhcpRuleCommand(
  ruleName: string,
  adapterAlias: string,
  nodePath: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol UDP ` +
    `-LocalPort 67 -Program ${quoteForPowerShell(nodePath)} -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-Action Allow -ErrorAction Stop | Out-Null } ` +
    MUTATION_TRY_CATCH_SUFFIX
  );
}

/** Called twice by createHostNetwork.ts — once for the Internal-switch adapter/host IP, once for the NAT adapter/NAT IP. */
export function buildCreateSmbRuleCommand(
  ruleName: string,
  adapterAlias: string,
  localAddress: string,
): string {
  return (
    `try { New-NetFirewallRule -DisplayName ${quoteForPowerShell(ruleName)} -Direction Inbound -Protocol TCP ` +
    `-LocalPort 445 -InterfaceAlias ${quoteForPowerShell(adapterAlias)} -LocalAddress ${quoteForPowerShell(localAddress)} ` +
    `-Action Allow -ErrorAction Stop | Out-Null } ` +
    MUTATION_TRY_CATCH_SUFFIX
  );
}

/**
 * Removes every rule matching any of the given DisplayNames, regardless of
 * adapter, tracking removed/failed counts separately (each removal uses
 * -ErrorAction Stop inside its own try/catch, so one failure doesn't stop
 * the rest from being attempted). Reused two ways: createHostNetwork.ts's
 * stale-cleanup-before-recreate (all four names at once — a nonzero failed
 * count there aborts the create, since a surviving stale rule would leave a
 * duplicate DisplayName after recreation) and deleteHostNetwork.ts's named
 * SMB sweep (just the SMB rule name).
 */
export function buildRemoveRulesByNameCommand(ruleNames: string[]): string {
  const namesArray = ruleNames.map((n) => quoteForPowerShell(n)).join(', ');
  return (
    `$removed = 0; $failed = 0; foreach ($name in @(${namesArray})) { ` +
    `$matched = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue); ` +
    `foreach ($rule in $matched) { ` +
    `try { $rule | Remove-NetFirewallRule -ErrorAction Stop; $removed++ } ` +
    `catch { $failed++ } ` +
    `} }; Write-Output "$removed,$failed"`
  );
}

/** Removes stale prompt-generated rules for the dedicated node.exe path, with the same per-rule removed/failed tracking as buildRemoveRulesByNameCommand. Not isolation-scoped: there is exactly one dedicated node.exe path host-wide. */
export function buildRemoveStaleQueryUserRulesCommand(nodePath: string): string {
  return (
    `$removed = 0; $failed = 0; ` +
    `$stale = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.Name -like "*Query User*" -and $_.Name.EndsWith(${quoteForPowerShell(nodePath)}, [StringComparison]::OrdinalIgnoreCase) }); ` +
    `foreach ($rule in $stale) { try { $rule | Remove-NetFirewallRule -ErrorAction Stop; $removed++ } catch { $failed++ } }; ` +
    `Write-Output "$removed,$failed"`
  );
}

/**
 * Removes every rule whose interface filter matches the given adapter alias,
 * regardless of DisplayName — deleteHostNetwork.ts's "clean up a corrupted
 * network" sweep, with the same per-rule removed/failed tracking. Mirrors
 * verify-proxy.ps1's existing Get-NetFirewallInterfaceFilter/-eq pattern for
 * reading a rule's interface scoping.
 */
export function buildRemoveRulesByInterfaceCommand(adapterAlias: string): string {
  return (
    `$removed = 0; $failed = 0; ` +
    `$matched = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ` +
    `(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue).InterfaceAlias -eq ${quoteForPowerShell(adapterAlias)} ` +
    `}); foreach ($rule in $matched) { try { $rule | Remove-NetFirewallRule -ErrorAction Stop; $removed++ } catch { $failed++ } }; ` +
    `Write-Output "$removed,$failed"`
  );
}

export interface SweepResult {
  removed: number;
  failed: number;
}

/** Reads the "removed,failed" pair every sweep command above writes via Write-Output. Defaults both to 0 for unexpected output rather than throwing — callers decide what a nonzero failed count means for them. */
export function parseSweepResult(stdout: string): SweepResult {
  const trimmed = stdout.trim();
  const [removedRaw, failedRaw] = trimmed.split(',');
  const removed = Number(removedRaw);
  const failed = Number(failedRaw);
  return {
    removed: Number.isFinite(removed) ? removed : 0,
    failed: Number.isFinite(failed) ? failed : 0,
  };
}
