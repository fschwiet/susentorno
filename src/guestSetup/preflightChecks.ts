import type { PowerShellExec } from './powerShellExec';
import { deriveSwitchName } from './switchName';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
  buildGetVmSwitchCommand,
  parseVmSwitchExists,
} from './hyperVQueries';
import { checkRunHostingReady } from './runHostingReadiness';

export interface PreflightOptions {
  exec: PowerShellExec;
  vmName: string;
  /**
   * Both internal names come from the caller's single resolveHostNetworkNames
   * call, so they cannot disagree — which is why preflight no longer recovers
   * the switch name from the alias with deriveSwitchName on this side.
   */
  internalAdapterAlias: string;
  internalSwitchName: string;
  natAdapterAlias: string;
  internalSwitchHostIp: string;
}

export type PreflightResult =
  { ok: true; defaultSwitchName: string } | { ok: false; message: string };

export async function runPreflightChecks(opts: PreflightOptions): Promise<PreflightResult> {
  const defaultSwitchName = deriveSwitchName(opts.natAdapterAlias);
  if (!defaultSwitchName) {
    return {
      ok: false,
      message: `preflight: '${opts.natAdapterAlias}' does not look like a Hyper-V vEthernet adapter alias`,
    };
  }

  const vmResult = await opts.exec.run(buildGetVmCommand(opts.vmName));
  const vm = parseGetVmResult(vmResult.stdout, opts.vmName);
  if (!vm) {
    return { ok: false, message: `preflight: no VM named exactly '${opts.vmName}' was found` };
  }

  const adapterResult = await opts.exec.run(buildGetVmNetworkAdapterCommand(opts.vmName));
  const adapters = parseVmNetworkAdapterResult(adapterResult.stdout);
  if (adapters.length !== 1) {
    return {
      ok: false,
      message: `preflight: VM '${opts.vmName}' has ${adapters.length} network adapters, expected exactly 1`,
    };
  }

  for (const { switchName, message } of [
    {
      switchName: opts.internalSwitchName,
      message: `preflight: Internal switch '${opts.internalSwitchName}' (adapter '${opts.internalAdapterAlias}') does not resolve to a real Hyper-V switch`,
    },
    {
      switchName: defaultSwitchName,
      message: `preflight: derived switch name '${defaultSwitchName}' (from '${opts.natAdapterAlias}') does not resolve to a real Hyper-V switch`,
    },
  ]) {
    const switchResult = await opts.exec.run(buildGetVmSwitchCommand(switchName));
    if (!parseVmSwitchExists(switchResult.stdout)) {
      return { ok: false, message };
    }
  }

  const readiness = await checkRunHostingReady(opts.exec, opts.internalSwitchHostIp);
  if (!readiness.dhcpBound || !readiness.dnsBound) {
    const missing = [!readiness.dhcpBound && 'DHCP (67)', !readiness.dnsBound && 'DNS (53)']
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      message:
        `preflight: run-hosting does not appear to be listening on ${opts.internalSwitchHostIp} — ` +
        `${missing} not bound. Start 'susentorno run-hosting' and retry.`,
    };
  }

  return { ok: true, defaultSwitchName };
}
