import {
  waitForPowerShellDirect as waitForProductionPowerShellDirect,
  WindowsGuestError,
  type WindowsGuestExecutor,
} from '../../src/guestSetup/windows/guestExecutor';

export class WindowsGuestExecError extends Error {}

export interface WindowsGuestExecResult {
  exitCode: number;
  stdout: string;
}

/** Long enough for a heavy assertion script; short enough to fail a hung guest. */
export const HARNESS_INVOCATION_TIMEOUT_MS = 5 * 60_000;

/**
 * The Windows sibling of guestExec.ts, sharing nothing with it deliberately: a
 * common abstraction over `bash -ic` and PowerShell Direct would be a
 * worse module than two honest ones.
 *
 * PowerShell Direct runs over the Hyper-V VMBus with no network involvement,
 * which is the point — the Ubuntu roles reach their guests across the very
 * network under test, survivable only because the serial console keeps
 * logging. Windows writes nothing to serial, so an in-band transport would
 * make a DHCP failure a black box.
 *
 * This is only a thin adapter over the production WindowsGuestExecutor, so the
 * harness exercises the real transport and the guest password never appears in
 * a process argument. The credential, the PSModulePath repair, and script
 * transport all live behind that executor.
 */
export interface WindowsGuestExec {
  vmName: string;
  run(script: string): Promise<WindowsGuestExecResult>;
  capture(script: string): Promise<WindowsGuestExecResult>;
}

/**
 * `stdout` carries the guest's stdout followed by its stderr, the merged view
 * the previous execa-based exec gave, so an assertion message shows both.
 */
export function createWindowsGuestExec(
  executor: WindowsGuestExecutor,
  timeoutMs: number = HARNESS_INVOCATION_TIMEOUT_MS,
): WindowsGuestExec {
  const invoke = async (script: string): Promise<WindowsGuestExecResult> => {
    const result = await executor.invoke(script, { timeoutMs });
    return { exitCode: result.exitCode, stdout: `${result.stdout}${result.stderr}` };
  };
  return { vmName: executor.vmName, run: invoke, capture: invoke };
}

/**
 * Test policy layered on the production readiness wait: a 20-minute OOBE
 * allowance and the screenshot hint an OOBE-stuck guest needs. A guest booted
 * from a differencing disk can take that long to reach its first logon.
 */
export async function waitForPowerShellDirect(
  executor: WindowsGuestExecutor,
  opts: { timeoutMs?: number; onProgress?: (elapsedMs: number) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  try {
    const readiness = await waitForProductionPowerShellDirect(executor, {
      deadlineMs: timeoutMs,
      onHeartbeat: opts.onProgress,
    });
    if (readiness === 'auth-rejected') {
      throw new WindowsGuestExecError(
        `windowsGuestExec: '${executor.vmName}' rejected the harness credential over PowerShell Direct. ` +
          'The golden image and the persisted windows credential are out of sync; rebuild the ' +
          'Windows golden image (SUSENTORNO_WINDOWS_IMAGE_REBUILD=1).',
      );
    }
  } catch (error) {
    if (error instanceof WindowsGuestError && error.kind === 'timeout') {
      throw new WindowsGuestExecError(
        `windowsGuestExec: '${executor.vmName}' never answered PowerShell Direct within ` +
          `${Math.round(timeoutMs / 60_000)} minutes. This is the OOBE-failed signature — check the ` +
          `screenshots for the screen it is stuck on. ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * PowerShell Direct does not inherit the host's elevation; it runs with the
 * supplied guest credential. The built-in RID-500 Administrator normally
 * yields a full administrative token, but 04-configure-network.ps1 declares
 * `#Requires -RunAsAdministrator`, so "normally" is checked rather than assumed.
 */
export async function assertGuestElevated(guest: WindowsGuestExec): Promise<void> {
  const { exitCode, stdout } = await guest.capture(
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  );
  if (exitCode !== 0 || !/true/i.test(stdout)) {
    throw new WindowsGuestExecError(
      `windowsGuestExec: the PowerShell Direct session on '${guest.vmName}' is not elevated ` +
        `(exit ${exitCode}): ${stdout.trim()}. 04-configure-network.ps1 requires an administrative token.`,
    );
  }
}
