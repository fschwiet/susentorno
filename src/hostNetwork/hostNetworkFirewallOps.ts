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

/** Appended after `$matched` (a PowerShell array of rule objects) is populated, to remove them in a single pipeline call and split the result into removed/failed counts. -ErrorVariable collects one non-terminating error per failed item without aborting the rest, so removed = matched.Count - errs.Count. */
const REMOVE_MATCHED_SUFFIX =
  `if ($matched.Count -gt 0) { ` +
  `$errs = $null; $matched | Remove-NetFirewallRule -ErrorAction SilentlyContinue -ErrorVariable errs | Out-Null; ` +
  `$failed = $errs.Count; $removed = $matched.Count - $failed ` +
  `}; Write-Output "$removed,$failed"`;

/**
 * Removes every rule matching any of the given DisplayNames, regardless of
 * adapter. Reused two ways: createHostNetwork.ts's stale-cleanup-before-recreate
 * (all four names at once — a nonzero failed count there aborts the create,
 * since a surviving stale rule would leave a duplicate DisplayName after
 * recreation) and deleteHostNetwork.ts's named SMB sweep (just the SMB rule
 * name). -DisplayName takes a string array directly, so all names are matched
 * in one Get-NetFirewallRule call rather than one call per name.
 */
export function buildRemoveRulesByNameCommand(ruleNames: string[]): string {
  const namesArray = ruleNames.map((n) => quoteForPowerShell(n)).join(', ');
  return (
    `$removed = 0; $failed = 0; ` +
    `$matched = @(Get-NetFirewallRule -DisplayName @(${namesArray}) -ErrorAction SilentlyContinue); ` +
    REMOVE_MATCHED_SUFFIX
  );
}

/** Removes stale prompt-generated rules for the dedicated node.exe path. Not isolation-scoped: there is exactly one dedicated node.exe path host-wide. */
export function buildRemoveStaleQueryUserRulesCommand(nodePath: string): string {
  return (
    `$removed = 0; $failed = 0; ` +
    `$matched = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.Name -like "*Query User*" -and $_.Name.EndsWith(${quoteForPowerShell(nodePath)}, [StringComparison]::OrdinalIgnoreCase) }); ` +
    REMOVE_MATCHED_SUFFIX
  );
}

/**
 * Removes every rule whose interface filter matches the given adapter alias,
 * regardless of DisplayName — deleteHostNetwork.ts's "clean up a corrupted
 * network" sweep.
 *
 * Resolves the adapter alias to its InterfaceGuid via Get-NetAdapter, then
 * matches rules by reading the "IF={guid}|" token straight out of each
 * rule's registry-stored definition (HKLM:\...\FirewallPolicy\FirewallRules)
 * instead of asking Get-NetFirewallInterfaceFilter to resolve every rule's
 * interface one at a time — that per-rule resolution (not cmdlet/session
 * overhead — batching the pipeline call barely helped) measured ~21s for
 * ~530 rules on a real dev host; this registry scan measured ~0.5s for the
 * same result, verified to find the identical rule set. The "IF=" token and
 * its pipe-delimited rule-string grammar are a published, versioned Windows
 * protocol (MS-GPFAS's Firewall Rule Grammar Rule, sourced from MS-FASP
 * §2.2.37's FW_RULE serialization) that has only ever added tokens across
 * Windows versions, never renamed or removed one — IF= has no version-suffixed
 * variant (unlike LPort2_10=, TTK2_22=, etc.), meaning it's been stable since
 * the grammar's earliest version. If the adapter alias can't be resolved,
 * $matched stays empty rather than falling back to the slow path above.
 */
export function buildRemoveRulesByInterfaceCommand(adapterAlias: string): string {
  return (
    `$removed = 0; $failed = 0; $matched = @(); ` +
    `$adapter = Get-NetAdapter -InterfaceAlias ${quoteForPowerShell(adapterAlias)} -ErrorAction SilentlyContinue; ` +
    `if ($adapter) { ` +
    `$fwRules = Get-Item -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules' -ErrorAction SilentlyContinue; ` +
    `$needle = "IF=$($adapter.InterfaceGuid)|"; ` +
    `$names = @(); ` +
    `if ($fwRules) { foreach ($n in $fwRules.GetValueNames()) { if ($fwRules.GetValue($n) -like "*$needle*") { $names += $n } } }; ` +
    `if ($names.Count -gt 0) { $matched = @(Get-NetFirewallRule -Name $names -ErrorAction SilentlyContinue) } ` +
    `}; ` +
    REMOVE_MATCHED_SUFFIX
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
