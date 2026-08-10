import type { PowerShellExec } from '../guestSetup/powerShellExec';
import { buildGetVmSwitchCommand } from '../guestSetup/hyperVQueries';
import { getDedicatedNodePath } from '../runHosting/relaunchViaDedicatedNode';
import { HostNetworkError, runMutation } from './hostNetworkError';
import { resolveHostNetworkNames } from './hostNetworkNames';
import {
  buildGetVmNetworkAdaptersOnSwitchCommand,
  parseAttachedVms,
  buildRemoveVmSwitchCommand,
  parseVmSwitchExistsExact,
} from './hostNetworkSwitchOps';
import {
  buildRemoveRulesByInterfaceCommand,
  buildRemoveStaleQueryUserRulesCommand,
  buildRemoveRulesByNameCommand,
  parseSweepResult,
  type SweepResult,
} from './hostNetworkFirewallOps';

export interface DeleteHostNetworkOptions {
  exec: PowerShellExec;
  isolationName?: string;
  homedir: string;
}

export interface DeleteHostNetworkResult {
  interfaceSweep: SweepResult;
  queryUserSweep: SweepResult;
  namedSweep: SweepResult;
  switchRemoved: boolean;
}

export async function deleteHostNetwork(
  opts: DeleteHostNetworkOptions,
): Promise<DeleteHostNetworkResult> {
  const names = resolveHostNetworkNames(opts.isolationName);

  const attachedResult = await opts.exec.run(
    buildGetVmNetworkAdaptersOnSwitchCommand(names.switchName),
  );
  const attached = parseAttachedVms(attachedResult.stdout);
  if (attached.length > 0) {
    const vmNames = attached.map((a) => a.vmName).join(', ');
    throw new HostNetworkError(
      `Switch '${names.switchName}' has VM(s) attached: ${vmNames}. Detach or stop them before deleting.`,
    );
  }

  const nodePath = getDedicatedNodePath(opts.homedir);

  // Each sweep, and the switch removal below, is attempted regardless of the
  // others' outcome — a failure in one doesn't stop the rest from being
  // tried. Failures are collected and reported together at the end.
  const interfaceSweep = parseSweepResult(
    (await opts.exec.run(buildRemoveRulesByInterfaceCommand(names.adapterAlias))).stdout,
  );
  const queryUserSweep = parseSweepResult(
    (await opts.exec.run(buildRemoveStaleQueryUserRulesCommand(nodePath))).stdout,
  );
  const namedSweep = parseSweepResult(
    (await opts.exec.run(buildRemoveRulesByNameCommand([names.smbRuleName]))).stdout,
  );

  const switchResult = await opts.exec.run(buildGetVmSwitchCommand(names.switchName));
  const switchExists = parseVmSwitchExistsExact(switchResult.stdout, names.switchName);
  let switchRemoved = false;
  let switchRemovalError: string | undefined;
  if (switchExists) {
    try {
      await runMutation(opts.exec, buildRemoveVmSwitchCommand(names.switchName));
      switchRemoved = true;
    } catch (error) {
      switchRemovalError = (error as Error).message;
    }
  }

  const totalFailed = interfaceSweep.failed + queryUserSweep.failed + namedSweep.failed;
  if (totalFailed > 0 || switchRemovalError) {
    const parts: string[] = [];
    if (totalFailed > 0) parts.push(`${totalFailed} firewall rule(s) could not be removed`);
    if (switchRemovalError) parts.push(`switch removal failed: ${switchRemovalError}`);
    throw new HostNetworkError(parts.join('; '));
  }

  return { interfaceSweep, queryUserSweep, namedSweep, switchRemoved };
}
