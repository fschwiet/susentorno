import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * Windows Setup media's own boot loader shows "Press any key to boot from CD
 * or DVD..." with a short timeout before falling through to the next boot
 * device. An unattended Start-VM never presses one, so the firmware boot
 * summary reports the DVD's "boot loader failed" and Setup never starts —
 * confirmed on a real host: without this, the build VM sits at that prompt
 * until BUILD_TIMEOUT_MS; sending keystrokes via the VM's synthetic keyboard
 * (Msvm_Keyboard) during the boot window reliably clears it. autounattend.xml
 * cannot help here — it hasn't been read yet; Setup hasn't started.
 *
 * Hyper-V's firmware BootOrder stays pinned to the DVD for every reboot, not
 * just the first — confirmed live, Setup's own specialize-phase reboots hit
 * this identical prompt — so `durationSeconds` is generous enough to cover a
 * whole build. The loop breaks as soon as the VM stops running so a caller
 * awaiting this after a successful build is not stuck waiting out the rest
 * of that duration.
 */
export function buildDefeatCdBootPromptCommand(vmName: string, durationSeconds: number): string {
  const vm = quoteForPowerShell(vmName);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$cs = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter ("ElementName='" + ${vm}.Replace("'","''") + "'")`,
    '$kbd = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_Keyboard',
    `$deadline = (Get-Date).AddSeconds(${durationSeconds})`,
    'while ((Get-Date) -lt $deadline) { ' +
      `if ((Get-VM -Name ${vm} -ErrorAction SilentlyContinue).State -ne 'Running') { break }; ` +
      "Invoke-CimMethod -InputObject $kbd -MethodName TypeText -Arguments @{ AsciiText = ' ' } -ErrorAction SilentlyContinue | Out-Null; " +
      'Start-Sleep -Milliseconds 300 }',
  ].join('; ');
}
