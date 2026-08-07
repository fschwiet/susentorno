import { quoteForPowerShell } from './quoteForPowerShell';

export function buildStopVmCommand(vmName: string): string {
  return `Stop-VM -Name ${quoteForPowerShell(vmName)}`;
}

export function buildConnectVmNetworkAdapterCommand(vmName: string, switchName: string): string {
  return (
    `Connect-VMNetworkAdapter -VMName ${quoteForPowerShell(vmName)} ` +
    `-SwitchName ${quoteForPowerShell(switchName)}`
  );
}

export function buildStartVmCommand(vmName: string): string {
  return `Start-VM -Name ${quoteForPowerShell(vmName)}`;
}

export type VmReconciliationPlan =
  { ok: true; stop: boolean; connect: boolean; start: boolean } | { ok: false; message: string };

/**
 * Step 1's reconciliation table: only `Running`/`Off` are handled — any other
 * state (Saved, Paused, a transitional state) fails loudly rather than
 * guessing how to recover it. Stop-VM is only ever planned when the VM is
 * currently Running, never against an already-Off VM.
 */
export function planVmReconciliation(
  state: string,
  currentSwitchName: string,
  targetSwitchName: string,
): VmReconciliationPlan {
  const correctSwitch = currentSwitchName === targetSwitchName;
  if (state === 'Running' && correctSwitch)
    return { ok: true, stop: false, connect: false, start: false };
  if (state === 'Running' && !correctSwitch)
    return { ok: true, stop: true, connect: true, start: true };
  if (state === 'Off' && !correctSwitch)
    return { ok: true, stop: false, connect: true, start: true };
  if (state === 'Off' && correctSwitch)
    return { ok: true, stop: false, connect: false, start: true };
  return {
    ok: false,
    message: `VM state is '${state}' — it must be 'Off' or 'Running' before this command can proceed.`,
  };
}
