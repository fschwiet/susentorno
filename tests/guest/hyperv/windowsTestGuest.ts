import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { roleVhdPath, roleVmName, windowsGoldenVhdPath, type GuestRole } from './imageCache';
import { buildNewDifferencingVhdCommand } from './vhd';
import { startScreenshotCapture, type ScreenshotHandle } from './vmScreenshot';
import {
  buildAddVmHardDiskCommand,
  buildEnableSecureBootWindowsCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetVmDynamicMemoryCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

export interface WindowsTestGuest {
  role: GuestRole;
  vmName: string;
  screenshots: ScreenshotHandle;
}

/**
 * Secure Boot on with the MicrosoftWindows template, no vTPM. The two are
 * independent settings; omitting the TPM is what keeps automatic device
 * encryption from ever sealing a volume to one VM's protector and stranding
 * every differencing child behind a recovery prompt.
 */
export async function createWindowsTestGuest(
  exec: PowerShellExec,
  role: GuestRole,
  switchName: string,
  artifactsDir: string,
): Promise<WindowsTestGuest> {
  const vmName = roleVmName(role);
  const vhdPath = roleVhdPath(role);
  await exec.run(buildTurnOffVmCommand(vmName));
  await exec.run(buildRemoveVmCommand(vmName));
  rmSync(vhdPath, { force: true });
  for (const [command, what] of [
    [buildNewDifferencingVhdCommand(vhdPath, windowsGoldenVhdPath), 'create the differencing disk'],
    [
      buildNewVmCommand(vmName, { memoryStartupBytes: 4096 * 1024 ** 2, switchName }),
      'create the VM',
    ],
    [buildAddVmHardDiskCommand(vmName, vhdPath), 'attach the differencing disk'],
    [buildSetVmProcessorCommand(vmName, 2), 'set the processor count'],
    [
      buildSetVmDynamicMemoryCommand(vmName, 2048 * 1024 ** 2, 6144 * 1024 ** 2),
      'enable dynamic memory',
    ],
    [buildEnableSecureBootWindowsCommand(vmName), 'enable Secure Boot'],
  ] as const) {
    const { exitCode, stdout } = await exec.run(command);
    if (exitCode !== 0) {
      throw new Error(
        `windowsTestGuest(${role}): could not ${what} (exit ${exitCode}): ${stdout || command}`,
      );
    }
  }
  const screenshots = startScreenshotCapture(
    exec,
    vmName,
    join(artifactsDir, role, 'screenshots'),
    {
      intervalMs: 60_000,
    },
  );
  const started = await exec.run(buildStartVmCommand(vmName));
  if (started.exitCode !== 0) {
    await screenshots.stop();
    throw new Error(`windowsTestGuest(${role}): Start-VM failed: ${started.stdout}`);
  }
  return { role, vmName, screenshots };
}

export async function destroyWindowsTestGuest(
  exec: PowerShellExec,
  guest: WindowsTestGuest,
): Promise<void> {
  await guest.screenshots.stop().catch(() => {});
  await exec.run(buildTurnOffVmCommand(guest.vmName));
  await exec.run(buildRemoveVmCommand(guest.vmName));
  rmSync(roleVhdPath(guest.role), { force: true });
}
