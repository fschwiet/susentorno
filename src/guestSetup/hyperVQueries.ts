import { quoteForPowerShell } from './quoteForPowerShell';
import type { PowerShellExec } from './powerShellExec';

export interface VmQueryResult {
  name: string;
  state: string;
}

export function buildGetVmCommand(vmName: string): string {
  return (
    `Get-VM -Name ${quoteForPowerShell(vmName)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ Name = $_.Name; State = $_.State.ToString() } } | ` +
    `ConvertTo-Json -Compress`
  );
}

interface RawVmEntry {
  Name?: unknown;
  State?: unknown;
}

/**
 * `-Name` accepts wildcard patterns, so Get-VM can legitimately return more
 * than one VM for a literal-looking input. Only an entry whose `Name` equals
 * the input exactly counts — exactly one such entry must exist, or this
 * returns null (covers both "not found" and "ambiguous").
 */
export function parseGetVmResult(stdout: string, expectedName: string): VmQueryResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawVmEntry[];
  const matches = list.filter((v) => v && v.Name === expectedName);
  if (matches.length !== 1) return null;
  return { name: matches[0].Name as string, state: matches[0].State as string };
}

export function buildGetVmNetworkAdapterCommand(vmName: string): string {
  return (
    `Get-VMNetworkAdapter -VMName ${quoteForPowerShell(vmName)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ SwitchName = $_.SwitchName; IPAddresses = $_.IPAddresses } } | ` +
    `ConvertTo-Json -Compress`
  );
}

export interface VmAdapterQueryResult {
  switchName: string;
  ipAddresses: string[];
}

interface RawAdapterEntry {
  SwitchName: string;
  IPAddresses?: string | string[] | null;
}

export function parseVmNetworkAdapterResult(stdout: string): VmAdapterQueryResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as RawAdapterEntry[];
  return list.map((entry) => ({
    switchName: entry.SwitchName,
    ipAddresses: Array.isArray(entry.IPAddresses)
      ? entry.IPAddresses
      : entry.IPAddresses
        ? [entry.IPAddresses]
        : [],
  }));
}

export function buildGetVmSwitchCommand(switchName: string): string {
  return (
    `Get-VMSwitch -Name ${quoteForPowerShell(switchName)} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1 Name | ConvertTo-Json -Compress`
  );
}

export function parseVmSwitchExists(stdout: string): boolean {
  return stdout.trim() !== '';
}

/** Every reported IP across every adapter — in practice there's exactly one adapter (enforced elsewhere), so this is that adapter's addresses. */
export async function getVmIpAddresses(exec: PowerShellExec, vmName: string): Promise<string[]> {
  const result = await exec.run(buildGetVmNetworkAdapterCommand(vmName));
  return parseVmNetworkAdapterResult(result.stdout).flatMap((a) => a.ipAddresses);
}
