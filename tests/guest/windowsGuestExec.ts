import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import type { WindowsCredential } from './hyperv/windowsCredential';

export class WindowsGuestExecError extends Error {}

export interface WindowsGuestExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * The Windows sibling of guestExec.ts, sharing nothing with it deliberately: a
 * common abstraction over `bash -ic` and `Invoke-Command -VMName` would be a
 * worse module than two honest ones.
 *
 * PowerShell Direct runs over the Hyper-V VMBus with no network involvement,
 * which is the point — the Ubuntu roles reach their guests across the very
 * network under test, survivable only because the serial console keeps
 * logging. Windows writes nothing to serial, so an in-band transport would
 * make a DHCP failure a black box.
 */
export interface WindowsGuestExec {
  vmName: string;
  run(script: string): Promise<WindowsGuestExecResult>;
  capture(script: string): Promise<WindowsGuestExecResult>;
}

/**
 * The guest script crosses as base64 rather than as a quoted literal. It is a
 * PowerShell string inside a PowerShell -Command string inside an argv entry;
 * quoteForPowerShell handles one level of that, not three, and a guest script
 * containing quotes, backticks, `$`, and newlines defeats the nesting outright.
 */
export function buildInvokeDirectCommand(
  vmName: string,
  credential: WindowsCredential,
  script: string,
): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return [
    // Confirmed live and 100% reproducible: when this host process's own
    // $env:PSModulePath has PowerShell 7's module paths mixed in (true
    // whenever pwsh.exe sits anywhere in the process's ancestry), Windows
    // PowerShell 5.1 resolves Microsoft.PowerShell.Security to an
    // incompatible PS7 build and ConvertTo-SecureString fails to load its
    // module on every single invocation — which waitForPowerShellDirect saw
    // as 80 identical failures over 20 minutes, despite the guest itself
    // answering fine outside the harness. Prepending the real WinPS5.1
    // system32 module path fixes it regardless of what was inherited.
    '$env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules;" + $env:PSModulePath',
    "$ErrorActionPreference = 'Stop'",
    `$secure = ConvertTo-SecureString ${quoteForPowerShell(credential.password)} -AsPlainText -Force`,
    `$credential = New-Object System.Management.Automation.PSCredential(${quoteForPowerShell(credential.username)}, $secure)`,
    `$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quoteForPowerShell(encoded)}))`,
    '$block = [ScriptBlock]::Create($decoded)',
    `Invoke-Command -VMName ${quoteForPowerShell(vmName)} -Credential $credential -ScriptBlock $block`,
  ].join('; ');
}

export function createWindowsGuestExec(
  exec: PowerShellExec,
  vmName: string,
  credential: WindowsCredential,
): WindowsGuestExec {
  const invoke = (script: string): Promise<WindowsGuestExecResult> =>
    exec.run(buildInvokeDirectCommand(vmName, credential, script));
  return { vmName, run: invoke, capture: invoke };
}

/**
 * Replaces the reachability probe the Ubuntu roles need. The guest's address
 * is something this role asks about, not a precondition for asking anything.
 */
export async function waitForPowerShellDirect(
  guest: WindowsGuestExec,
  opts: { timeoutMs?: number; onProgress?: (elapsedMs: number) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { exitCode, stdout } = await guest.capture('"ready"');
    if (exitCode === 0 && stdout.includes('ready')) return;
    opts.onProgress?.(Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new WindowsGuestExecError(
    `windowsGuestExec: '${guest.vmName}' never answered PowerShell Direct within ` +
      `${Math.round(timeoutMs / 60_000)} minutes. This is the OOBE-failed signature — check the ` +
      'screenshots for the screen it is stuck on.',
  );
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
