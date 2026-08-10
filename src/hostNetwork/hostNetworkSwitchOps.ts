import { quoteForPowerShell } from '../guestSetup/quoteForPowerShell';

const TRY_CATCH_SUFFIX = 'catch { Write-Output "ERROR: $($_.Exception.Message)"; exit 1 }';

export function buildNewVmSwitchCommand(switchName: string): string {
  return (
    `try { New-VMSwitch -Name ${quoteForPowerShell(switchName)} -SwitchType Internal -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

export function buildNewNetIpAddressCommand(adapterAlias: string, ipAddress: string): string {
  return (
    `try { New-NetIPAddress -InterfaceAlias ${quoteForPowerShell(adapterAlias)} ` +
    `-IPAddress ${quoteForPowerShell(ipAddress)} -PrefixLength 24 -ErrorAction Stop | Out-Null } ` +
    TRY_CATCH_SUFFIX
  );
}

/**
 * -Force suppresses Remove-VMSwitch's interactive confirmation prompt, which
 * would otherwise hang under -NonInteractive. Safe here because
 * deleteHostNetwork.ts always checks for attached VMs first (see
 * hostNetworkSwitchOps.ts's buildGetVmNetworkAdaptersOnSwitchCommand below)
 * and refuses to proceed if any are found.
 */
export function buildRemoveVmSwitchCommand(switchName: string): string {
  return (
    `try { Remove-VMSwitch -Name ${quoteForPowerShell(switchName)} -Force -ErrorAction Stop } ` +
    TRY_CATCH_SUFFIX
  );
}

export function buildGetVmNetworkAdaptersOnSwitchCommand(switchName: string): string {
  return (
    `Get-VMNetworkAdapter -All -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.SwitchName -eq ${quoteForPowerShell(switchName)} } | ` +
    `ForEach-Object { [PSCustomObject]@{ VMName = $_.VMName } } | ConvertTo-Json -Compress`
  );
}

export interface AttachedVm {
  vmName: string;
}

interface RawAttachedVm {
  VMName?: unknown;
}

export function parseAttachedVms(stdout: string): AttachedVm[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawAttachedVm[];
  return list
    .filter((v): v is { VMName: string } => typeof v.VMName === 'string')
    .map((v) => ({ vmName: v.VMName }));
}

/**
 * Stricter than hyperVQueries.ts's parseVmSwitchExists ("some output came
 * back"): confirms the returned Name matches expectedName exactly, since
 * Get-VMSwitch -Name is wildcard-tolerant. Same defense-in-depth precedent as
 * parseGetVmResult's exact-match check for Get-VM -Name.
 */
export function parseVmSwitchExistsExact(stdout: string, expectedName: string): boolean {
  const trimmed = stdout.trim();
  if (!trimmed) return false;
  const parsed: unknown = JSON.parse(trimmed);
  const obj = parsed as { Name?: unknown };
  return obj.Name === expectedName;
}
