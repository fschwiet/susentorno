import type { PowerShellExec } from '../powerShellExec';
import { describeTarget, type ShareCredentialLedgerEntry } from './shareCredential';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
} from '../hyperVQueries';

export type ResidualVmState =
  | {
      known: true;
      powerState: string;
      /** null when the adapter is disconnected. */ switchName: string | null;
    }
  | { known: false; reason: string };

/**
 * The footer reports what Hyper-V says now, never what the run believes it did:
 * a failure or Ctrl+C can land anywhere in a stop, a switch move, or a start.
 */
export async function queryResidualVmState(
  exec: PowerShellExec,
  vmName: string,
): Promise<ResidualVmState> {
  try {
    const vmResult = await exec.run(buildGetVmCommand(vmName));
    const vm = parseGetVmResult(vmResult.stdout, vmName);
    if (!vm) return { known: false, reason: `no VM named exactly '${vmName}' was found` };
    const adapterResult = await exec.run(buildGetVmNetworkAdapterCommand(vmName));
    const adapters = parseVmNetworkAdapterResult(adapterResult.stdout);
    return { known: true, powerState: vm.state, switchName: adapters[0]?.switchName || null };
  } catch (error) {
    return { known: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface ResidualStateFooterInput {
  outcome: 'failure' | 'cancelled';
  /** The failed or interrupted phase, already described (for example 'G3 guest structural checks'). */
  phase: string;
  stepFilename?: string;
  /** Absent when the run ended before a VM name existed. */
  vmName?: string;
  vm?: ResidualVmState;
  /** What this run did to the guest's VM share credentials, after cleanup. */
  credentials?: ShareCredentialLedgerEntry[];
}

const CREDENTIAL_STATUS_TEXT: Record<ShareCredentialLedgerEntry['status'], string> = {
  verified: 'verified, kept',
  removed: 'removed (written by this run but never verified)',
  written: 'written but never verified (cleanup did not run)',
  'removal-failed':
    'written but never verified, and could not be removed (delete it in the guest with cmdkey /delete)',
};

export function formatResidualStateFooter(input: ResidualStateFooterInput): string[] {
  const lines = ['setup-guest-windows: residual state'];
  lines.push(
    input.outcome === 'cancelled'
      ? `  Cancelled during phase: ${input.phase}`
      : `  Failed in phase: ${input.phase}`,
  );
  if (input.stepFilename) lines.push(`  Failed step: ${input.stepFilename}`);

  if (input.vmName === undefined) {
    lines.push('  No VM was chosen, so nothing was changed.');
  } else if (!input.vm) {
    lines.push(`  VM '${input.vmName}': its state was not queried`);
  } else if (!input.vm.known) {
    lines.push(`  VM '${input.vmName}': its state could not be queried (${input.vm.reason})`);
  } else {
    const where =
      input.vm.switchName === null
        ? 'not attached to any switch'
        : `attached to '${input.vm.switchName}'`;
    lines.push(`  VM '${input.vmName}': ${input.vm.powerState}, ${where}`);
  }

  for (const entry of input.credentials ?? []) {
    lines.push(
      `  VM share credential for ${describeTarget(entry)}: ${CREDENTIAL_STATUS_TEXT[entry.status]}`,
    );
  }

  if (input.vmName !== undefined) lines.push('  Nothing was rolled back.');
  lines.push(
    "  Rerun 'susentorno setup-guest-windows' to replay the whole flow from the Default Switch.",
  );
  return lines;
}
