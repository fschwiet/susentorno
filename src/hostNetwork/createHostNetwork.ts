import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { PowerShellExec } from '../guestSetup/powerShellExec';
import { buildGetVmSwitchCommand } from '../guestSetup/hyperVQueries';
import { resolveForwardListenAddress } from '../runHosting/forwarder';
import { getDedicatedNodePath } from '../runHosting/relaunchViaDedicatedNode';
import { HostNetworkError, runMutation } from './hostNetworkError';
import { resolveHostNetworkNames } from './hostNetworkNames';
import {
  detectTakenRanges,
  validateSubnet,
  findFreeSubnet,
  type TakenRange,
} from './subnetSelection';
import {
  buildNewVmSwitchCommand,
  buildNewNetIpAddressCommand,
  parseVmSwitchExistsExact,
} from './hostNetworkSwitchOps';
import {
  buildCreateEnvoyRuleCommand,
  buildCreateDnsRuleCommand,
  buildCreateDhcpRuleCommand,
  buildCreateSmbRuleCommand,
  buildRemoveRulesByNameCommand,
  buildRemoveStaleQueryUserRulesCommand,
  parseSweepResult,
} from './hostNetworkFirewallOps';

export interface CreateHostNetworkOptions {
  exec: PowerShellExec;
  isolationName?: string;
  /** 0-255. If omitted, promptSubnet is called to resolve it interactively. */
  subnet?: number;
  natAdapterAlias: string;
  homedir: string;
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Resolves an already-validated subnet octet, e.g. via an interactive retry-on-invalid prompt. Not called when `subnet` or an existing switch make prompting unnecessary. */
  promptSubnet: (taken: TakenRange[], defaultN: number) => Promise<number>;
}

export interface CreateHostNetworkResult {
  hostIp: string;
  /** True when an existing switch's firewall rules were refreshed rather than a new switch/IP being created. */
  refreshedOnly: boolean;
}

export async function createHostNetwork(
  opts: CreateHostNetworkOptions,
): Promise<CreateHostNetworkResult> {
  const names = resolveHostNetworkNames(opts.isolationName);
  const interfaces = opts.networkInterfaces ?? osNetworkInterfaces();

  // Resolved in-process, before the first PowerShell call — a missing NAT
  // adapter address must fail cleanly with nothing yet touched, mirroring
  // host-allow-vm-inbound.ps1's "resolve everything up front" approach.
  const natIp = resolveForwardListenAddress(opts.natAdapterAlias, interfaces);
  if (!natIp) {
    throw new HostNetworkError(`No IPv4 address found on NAT adapter '${opts.natAdapterAlias}'.`);
  }

  const switchResult = await opts.exec.run(buildGetVmSwitchCommand(names.switchName));
  const switchExists = parseVmSwitchExistsExact(switchResult.stdout, names.switchName);

  const nodePath = getDedicatedNodePath(opts.homedir);

  let hostIp: string;
  let refreshedOnly: boolean;

  if (switchExists) {
    const existingIp = resolveForwardListenAddress(names.adapterAlias, interfaces);
    if (!existingIp) {
      throw new HostNetworkError(
        `Switch '${names.switchName}' exists but has no IPv4 address assigned. ` +
          `Run 'susentorno delete-host-network' and retry.`,
      );
    }
    hostIp = existingIp;
    refreshedOnly = true;
  } else {
    const takenRanges = detectTakenRanges(interfaces);
    let n: number;
    if (opts.subnet !== undefined) {
      validateSubnet(opts.subnet, takenRanges);
      n = opts.subnet;
    } else {
      const freeDefault = findFreeSubnet(takenRanges);
      if (freeDefault === null) {
        throw new HostNetworkError('No free 192.168.n.0/24 subnet was found on this host.');
      }
      n = await opts.promptSubnet(takenRanges, freeDefault);
    }
    hostIp = `192.168.${n}.1`;

    await runMutation(opts.exec, buildNewVmSwitchCommand(names.switchName));
    await runMutation(opts.exec, buildNewNetIpAddressCommand(names.adapterAlias, hostIp));
    refreshedOnly = false;
  }

  // Clear any same-named rule before recreating it. A removal failure here
  // is fatal to this call (unlike delete-host-network's best-effort sweeps):
  // a surviving stale rule would make the New-NetFirewallRule call below
  // create a duplicate DisplayName, not a clean replacement.
  const staleNamedSweep = parseSweepResult(
    (
      await opts.exec.run(
        buildRemoveRulesByNameCommand([
          names.envoyRuleName,
          names.dnsRuleName,
          names.dhcpRuleName,
          names.smbRuleName,
        ]),
      )
    ).stdout,
  );
  if (staleNamedSweep.failed > 0) {
    throw new HostNetworkError(
      `${staleNamedSweep.failed} stale firewall rule(s) could not be removed before recreating them — ` +
        `run 'susentorno delete-host-network' to clean up, then retry.`,
    );
  }

  const staleQueryUserSweep = parseSweepResult(
    (await opts.exec.run(buildRemoveStaleQueryUserRulesCommand(nodePath))).stdout,
  );
  if (staleQueryUserSweep.failed > 0) {
    throw new HostNetworkError(
      `${staleQueryUserSweep.failed} stale Query User rule(s) could not be removed — ` +
        `run 'susentorno delete-host-network' to clean up, then retry.`,
    );
  }

  await runMutation(
    opts.exec,
    buildCreateEnvoyRuleCommand(names.envoyRuleName, names.adapterAlias, hostIp, nodePath),
  );
  await runMutation(
    opts.exec,
    buildCreateDnsRuleCommand(names.dnsRuleName, names.adapterAlias, hostIp, nodePath),
  );
  await runMutation(
    opts.exec,
    buildCreateDhcpRuleCommand(names.dhcpRuleName, names.adapterAlias, nodePath),
  );
  await runMutation(
    opts.exec,
    buildCreateSmbRuleCommand(names.smbRuleName, names.adapterAlias, hostIp),
  );
  await runMutation(
    opts.exec,
    buildCreateSmbRuleCommand(names.smbRuleName, opts.natAdapterAlias, natIp),
  );

  return { hostIp, refreshedOnly };
}
