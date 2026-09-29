import type { PowerShellExec } from './powerShellExec';
import {
  buildGetVmCommand,
  parseGetVmResult,
  buildGetVmNetworkAdapterCommand,
  parseVmNetworkAdapterResult,
} from './hyperVQueries';
import {
  buildStopVmCommand,
  buildConnectVmNetworkAdapterCommand,
  buildStartVmCommand,
  planVmReconciliation,
} from './hyperVOperations';
import { sleep as defaultSleep } from '../runHosting/abortableSleep';

export interface VmReconcileDeps {
  exec: PowerShellExec;
  vmName: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  offConfirmTimeoutMs?: number;
  offPollIntervalMs?: number;
  /**
   * Called about every `heartbeatIntervalMs` while a graceful stop is still
   * waiting (the Stop-VM call and the confirmation that follows), with the time
   * elapsed since the stop began. Absent, nothing is reported.
   */
  onHeartbeat?: (elapsedMs: number) => void;
  heartbeatIntervalMs?: number;
}

export interface VmReconcileOutcome {
  started: boolean;
}

export class VmReconcileError extends Error {}

/** Connect-VMNetworkAdapter/Start-VM failures must surface directly, not be silently swallowed. */
async function runOperation(exec: PowerShellExec, command: string): Promise<void> {
  const { exitCode, stdout } = await exec.run(command);
  if (exitCode !== 0) {
    throw new VmReconcileError(
      `vmReconcile: command failed (exit ${exitCode}): ${command}${stdout ? ` — ${stdout}` : ''}`,
    );
  }
}

async function queryVmStateAndSwitch(
  deps: VmReconcileDeps,
): Promise<{ state: string; switchName: string }> {
  const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
  const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
  if (!vm) {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' not found (or matched more than one VM)`,
    );
  }
  const adapterResult = await deps.exec.run(buildGetVmNetworkAdapterCommand(deps.vmName));
  const adapters = parseVmNetworkAdapterResult(adapterResult.stdout);
  if (adapters.length !== 1) {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' has ${adapters.length} network adapters, expected exactly 1`,
    );
  }
  return { state: vm.state, switchName: adapters[0].switchName };
}

/**
 * Bounds the graceful shutdown at the process level (Stop-VM's own execa call
 * is given stopTimeoutMs and killed if exceeded), then separately confirms
 * the VM actually reached Off by polling Get-VM — either way the Stop-VM call
 * returns (early, or killed at its deadline), confirmation is what decides
 * success, not Stop-VM's own exit code.
 */
async function gracefulStopAndConfirmOff(deps: VmReconcileDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const heartbeat = startHeartbeat(deps, now);
  try {
    await stopAndConfirmOff(deps, heartbeat.tick);
  } finally {
    heartbeat.stop();
  }
}

/**
 * Heartbeats for a stop that can take minutes. The blocking Stop-VM call can
 * only be reported on by a timer; the confirmation loop reports through the same
 * `tick` on its own clock, which never emits twice inside one interval.
 */
function startHeartbeat(
  deps: VmReconcileDeps,
  now: () => number,
): { tick: () => void; stop: () => void } {
  if (!deps.onHeartbeat) return { tick: () => {}, stop: () => {} };
  const onHeartbeat = deps.onHeartbeat;
  const interval = deps.heartbeatIntervalMs ?? 15_000;
  const started = now();
  let lastEmitted = started;
  const tick = (): void => {
    const current = now();
    if (current - lastEmitted < interval) return;
    lastEmitted = current;
    onHeartbeat(current - started);
  };
  const timer = setInterval(tick, interval);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

async function stopAndConfirmOff(deps: VmReconcileDeps, tick: () => void): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 60_000;
  const offConfirmTimeoutMs = deps.offConfirmTimeoutMs ?? 30_000;
  const offPollIntervalMs = deps.offPollIntervalMs ?? 2_000;

  await deps.exec.run(buildStopVmCommand(deps.vmName), { timeoutMs: stopTimeoutMs });

  const deadline = now() + offConfirmTimeoutMs;
  for (;;) {
    const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
    const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
    if (vm?.state === 'Off') return;
    if (now() >= deadline) {
      throw new VmReconcileError(
        `vmReconcile: VM '${deps.vmName}' did not reach 'Off' after a graceful Stop-VM — ` +
          `current state is '${vm?.state ?? 'unknown'}'. Investigate or force-stop it manually, then rerun.`,
      );
    }
    await sleep(offPollIntervalMs);
    tick();
  }
}

export async function reconcileVmToSwitch(
  deps: VmReconcileDeps,
  targetSwitchName: string,
): Promise<VmReconcileOutcome> {
  const { state, switchName } = await queryVmStateAndSwitch(deps);
  const plan = planVmReconciliation(state, switchName, targetSwitchName);
  if (!plan.ok) throw new VmReconcileError(`vmReconcile: ${plan.message}`);
  if (plan.stop) await gracefulStopAndConfirmOff(deps);
  if (plan.connect) {
    await runOperation(
      deps.exec,
      buildConnectVmNetworkAdapterCommand(deps.vmName, targetSwitchName),
    );
  }
  if (plan.start) {
    await runOperation(deps.exec, buildStartVmCommand(deps.vmName));
  }
  return { started: plan.start };
}

/** Step 5's unconditional isolate sequence: always ends Connect+Start, but only Stops first if actually Running. */
export async function isolateVmToSwitch(
  deps: VmReconcileDeps,
  targetSwitchName: string,
): Promise<void> {
  const vmResult = await deps.exec.run(buildGetVmCommand(deps.vmName));
  const vm = parseGetVmResult(vmResult.stdout, deps.vmName);
  if (!vm) {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' not found (or matched more than one VM)`,
    );
  }
  if (vm.state === 'Running') {
    await gracefulStopAndConfirmOff(deps);
  } else if (vm.state !== 'Off') {
    throw new VmReconcileError(
      `vmReconcile: VM '${deps.vmName}' is in state '${vm.state}' — it must be 'Off' or 'Running' before isolating it.`,
    );
  }
  await runOperation(deps.exec, buildConnectVmNetworkAdapterCommand(deps.vmName, targetSwitchName));
  await runOperation(deps.exec, buildStartVmCommand(deps.vmName));
}
