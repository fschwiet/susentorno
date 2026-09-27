import { createRealPowerShellExec } from '../src/guestSetup/powerShellExec';
import { requireWindowsHost } from './requireWindowsHost';

/**
 * Turn the observed status of the Hyper-V Virtual Machine Management service
 * (`vmms`) into a fix-it message, or null when it is running. An empty status
 * means the service does not exist, i.e. Hyper-V is not installed.
 */
export function describeHypervServiceStatus(status: string): string | null {
  if (status === 'Running') return null;
  if (status === '') {
    return (
      'Hyper-V is not available: the Hyper-V Virtual Machine Management service (vmms) does not ' +
      'exist on this host. Enable Hyper-V (elevated PowerShell, then reboot):\n' +
      '  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All'
    );
  }
  return (
    `Hyper-V is not available: the Hyper-V Virtual Machine Management service (vmms) is ${status}. ` +
    'Start it (elevated PowerShell) and re-run:\n' +
    '  Start-Service vmms'
  );
}

/**
 * Guard: the host-network and guest tiers create real Hyper-V switches and
 * VMs, which fail deep inside a test with an opaque cmdlet error when Hyper-V
 * is missing or its management service is down. Check up front instead.
 */
export async function checkHypervAvailable(): Promise<void> {
  requireWindowsHost();
  const exec = createRealPowerShellExec();
  const { exitCode, stdout } = await exec.run(
    '$service = Get-Service -Name vmms -ErrorAction SilentlyContinue; ' +
      'if ($service) { $service.Status.ToString() }',
  );
  if (exitCode !== 0) {
    throw new Error(
      `Could not query the Hyper-V Virtual Machine Management service (vmms) (PowerShell exited ${exitCode}):\n` +
        `${stdout}\nThis check could not run, so Hyper-V availability cannot be confirmed.`,
    );
  }
  const message = describeHypervServiceStatus(stdout.trim());
  if (message) throw new Error(message);
}
