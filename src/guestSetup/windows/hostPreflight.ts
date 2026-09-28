import { win32 } from 'node:path';
import { quoteForPowerShell } from '../quoteForPowerShell';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
} from '../hyperVQueries';
import { runPreflightChecks, type PreflightOptions } from '../preflightChecks';

export interface WindowsHostPreflightOptions extends PreflightOptions {
  shareName: string;
  /** This environment's generated Windows VM-share directory. */
  vmSharedWindowsPath: string;
}

export type WindowsHostPreflightResult =
  | {
      ok: true;
      defaultSwitchName: string;
      vmState: string;
      /** The switch the VM's single adapter is attached to now. */
      vmSwitchName: string;
    }
  | { ok: false; message: string };

export function buildGetSmbShareCommand(shareName: string): string {
  return (
    `Get-SmbShare -Name ${quoteForPowerShell(shareName)} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Path = $_.Path } } | ConvertTo-Json -Compress`
  );
}

/**
 * `-Name` accepts wildcards, and SMB share names are case-insensitive, so only
 * an entry whose name equals the requested one (ignoring case) counts.
 */
export function parseSmbSharePaths(stdout: string, shareName: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as { Name?: unknown; Path?: unknown }[];
  return list
    .filter(
      (entry) =>
        typeof entry?.Name === 'string' &&
        entry.Name.toLowerCase() === shareName.toLowerCase() &&
        typeof entry.Path === 'string',
    )
    .map((entry) => entry.Path as string);
}

function normalizeWindowsPath(path: string): string {
  return win32
    .resolve(path)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

const GENERIC_REMEDIATION =
  `Check the VM name (Get-VM), that the Default Switch and the Internal switch exist ` +
  `('susentorno create-host-network'), and that 'susentorno run-hosting' is running, then rerun.`;

/**
 * Phase H2. The shared preflight covers the VM's existence and adapter count,
 * both switches, and the run-hosting listeners; the rules here are the ones only
 * the Windows flow needs: the VM must be Running or Off, its adapter must sit on
 * one of the two expected switches, and the named SMB share must be this
 * environment's Windows VM share. Every failure names what it found and how to
 * fix it, and none involves a secret.
 */
export async function runWindowsHostPreflight(
  opts: WindowsHostPreflightOptions,
): Promise<WindowsHostPreflightResult> {
  const shared = await runPreflightChecks(opts);
  if (!shared.ok) {
    const problem = shared.message.replace(/[.\s]+$/, '');
    return { ok: false, message: `${problem}. ${GENERIC_REMEDIATION}` };
  }
  const { defaultSwitchName } = shared;

  const vmResult = await opts.exec.run(buildGetVmCommand(opts.vmName));
  const vm = parseGetVmResult(vmResult.stdout, opts.vmName)!;
  if (vm.state !== 'Running' && vm.state !== 'Off') {
    return {
      ok: false,
      message:
        `preflight: VM '${opts.vmName}' is in state '${vm.state}'; setup needs it 'Running' or 'Off'. ` +
        `Bring it to one of those (Start-VM or Stop-VM in an elevated PowerShell, or wait for a transition to finish), then rerun.`,
    };
  }

  const adapterResult = await opts.exec.run(buildGetVmNetworkAdapterCommand(opts.vmName));
  const vmSwitchName = parseVmNetworkAdapterResult(adapterResult.stdout)[0]?.switchName;
  if (!vmSwitchName) {
    return {
      ok: false,
      message:
        `preflight: VM '${opts.vmName}' has a network adapter that is not connected to any switch. ` +
        `Connect it (Connect-VMNetworkAdapter -VMName '${opts.vmName}' -SwitchName '${defaultSwitchName}'), then rerun.`,
    };
  }
  if (vmSwitchName !== defaultSwitchName && vmSwitchName !== opts.internalSwitchName) {
    return {
      ok: false,
      message:
        `preflight: VM '${opts.vmName}' is attached to switch '${vmSwitchName}', but setup accepts only the ` +
        `Default Switch '${defaultSwitchName}' or the Internal switch '${opts.internalSwitchName}'. ` +
        `Connect it (Connect-VMNetworkAdapter -VMName '${opts.vmName}' -SwitchName '${defaultSwitchName}'), then rerun.`,
    };
  }

  const shareResult = await opts.exec.run(buildGetSmbShareCommand(opts.shareName));
  const sharePaths = parseSmbSharePaths(shareResult.stdout, opts.shareName);
  if (sharePaths.length === 0) {
    return {
      ok: false,
      message:
        `preflight: SMB share '${opts.shareName}' does not exist on this host. ` +
        `Create it read-only for the VM share account over '${opts.vmSharedWindowsPath}' ` +
        `(New-SmbShare -Name '${opts.shareName}' -Path '${opts.vmSharedWindowsPath}' -ReadAccess <account>), or pass the right --share-name, then rerun.`,
    };
  }
  const expectedPath = normalizeWindowsPath(opts.vmSharedWindowsPath);
  if (!sharePaths.some((path) => normalizeWindowsPath(path) === expectedPath)) {
    return {
      ok: false,
      message:
        `preflight: SMB share '${opts.shareName}' points at '${sharePaths[0]}', not this environment's Windows VM share ` +
        `'${opts.vmSharedWindowsPath}'. Recreate the share over that directory, or pass the right --share-name, then rerun.`,
    };
  }

  return { ok: true, defaultSwitchName, vmState: vm.state, vmSwitchName };
}
