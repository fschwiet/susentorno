import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { getVmIpAddresses } from '../../../src/guestSetup/hyperVQueries';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { waitForReachable } from '../../../src/guestSetup/reachabilityWait';
import { realTcpConnect } from '../../../src/guestSetup/tcpConnect';
import { networkAddress } from '../../../src/runHosting/ip';
import { goldenVhdPath, rolePipeName, roleVhdPath, roleVmName, type GuestRole } from './imageCache';
import { startSerialLog, type SerialLogHandle } from './serialLog';
import { buildNewDifferencingVhdCommand } from './vhd';
import {
  buildAddVmHardDiskCommand,
  buildEnableSecureBootCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetVmComPortCommand,
  buildSetVmDynamicMemoryCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

export interface ExpectedNetwork {
  address: string;
  netmask: string;
}
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
export function filterCandidateAddresses(addresses: string[], expected: ExpectedNetwork): string[] {
  const wanted = networkAddress(expected.address, expected.netmask);
  return addresses.filter(
    (address) =>
      IPV4_RE.test(address) &&
      !address.split('.').some((octet) => Number(octet) > 255) &&
      networkAddress(address, expected.netmask) === wanted,
  );
}
export interface TestGuest {
  role: GuestRole;
  vmName: string;
  address: string;
  serial: SerialLogHandle;
}
export async function createTestGuest(
  exec: PowerShellExec,
  role: GuestRole,
  switchName: string,
  expected: ExpectedNetwork,
  artifactsDir: string,
): Promise<TestGuest> {
  const vmName = roleVmName(role),
    vhdPath = roleVhdPath(role);
  await exec.run(buildTurnOffVmCommand(vmName));
  await exec.run(buildRemoveVmCommand(vmName));
  rmSync(vhdPath, { force: true });
  for (const [command, what] of [
    [buildNewDifferencingVhdCommand(vhdPath, goldenVhdPath), 'create the differencing disk'],
    [
      buildNewVmCommand(vmName, { memoryStartupBytes: 2048 * 1024 ** 2, switchName }),
      'create the VM',
    ],
    [buildAddVmHardDiskCommand(vmName, vhdPath), 'attach the differencing disk'],
    [buildSetVmProcessorCommand(vmName, 2), 'set the processor count'],
    [
      buildSetVmDynamicMemoryCommand(vmName, 2048 * 1024 ** 2, 4096 * 1024 ** 2),
      'enable dynamic memory',
    ],
    [buildEnableSecureBootCommand(vmName), 'enable Secure Boot'],
    [buildSetVmComPortCommand(vmName, rolePipeName(role)), 'attach COM1'],
  ] as const) {
    const { exitCode, stdout } = await exec.run(command);
    if (exitCode !== 0)
      throw new Error(
        `testGuest(${role}): could not ${what} (exit ${exitCode}): ${stdout || command}`,
      );
  }
  const serialLogPath = join(artifactsDir, role, 'serial.log');
  const serial = startSerialLog(rolePipeName(role), serialLogPath);
  const started = await exec.run(buildStartVmCommand(vmName));
  if (started.exitCode !== 0) {
    await serial.stop();
    throw new Error(`testGuest(${role}): Start-VM failed: ${started.stdout}`);
  }
  const reachability = await waitForReachable({
    getCandidates: async () =>
      filterCandidateAddresses(await getVmIpAddresses(exec, vmName), expected),
    connect: realTcpConnect,
    timeoutMs: 600_000,
    onProgress: (elapsedMs) =>
      console.log(`guest(${role}): waiting for :22... (${Math.round(elapsedMs / 1000)}s)`),
  });
  if (!reachability.reachable) {
    await serial.stop();
    throw new Error(`testGuest(${role}): '${vmName}' never became reachable; see ${serialLogPath}`);
  }
  return { role, vmName, address: reachability.address, serial };
}
export async function destroyTestGuest(exec: PowerShellExec, guest: TestGuest): Promise<void> {
  await guest.serial.stop().catch(() => {});
  await exec.run(buildTurnOffVmCommand(guest.vmName));
  await exec.run(buildRemoveVmCommand(guest.vmName));
  rmSync(roleVhdPath(guest.role), { force: true });
}
