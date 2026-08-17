import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { buildGetVmCommand, parseGetVmResult } from '../../../src/guestSetup/hyperVQueries';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';
import { buildGrubCfg, buildMetaData, buildUserData } from '../autoinstall';
import type { HarnessKeys } from '../harnessKeys';
import {
  BUILD_ALGORITHM_VERSION,
  clearGoldenStamp,
  computeGoldenStamp,
  readGoldenStamp,
  writeGoldenStamp,
} from './goldenStamp';
import { ensureIso } from './isoCache';
import {
  goldenBuildSerialLogPath,
  goldenVhdPath,
  imageCacheDir,
  isoPath,
  isoUrl,
  NAME_PREFIX,
} from './imageCache';
import { startSerialLog } from './serialLog';
import {
  buildCopyTreeCommand,
  buildCreateFat32VolumeCommand,
  buildDismountIsoCommand,
  buildDismountVhdCommand,
  buildMountIsoCommand,
  buildNewVhdCommand,
  buildSetEspTypeCommand,
  parseIsoDriveLetter,
  parsePartitionHandle,
} from './vhd';
import {
  buildAddVmHardDiskCommand,
  buildDisableSecureBootCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetFirstBootDeviceCommand,
  buildSetVmComPortCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

const goldenBuildVmName = `${NAME_PREFIX}-golden-build`,
  goldenBuildPipeName = goldenBuildVmName,
  installer = join(imageCacheDir, `${NAME_PREFIX}-golden-installer.vhdx`),
  seed = join(imageCacheDir, `${NAME_PREFIX}-golden-seed.vhdx`);
const targetSize = 40 * 1024 ** 3,
  installerSize = 4 * 1024 ** 3,
  seedSize = 64 * 1024 ** 2;
async function run(exec: PowerShellExec, command: string, what: string): Promise<string> {
  const result = await exec.run(command);
  if (result.exitCode)
    throw new Error(
      `goldenImage: ${what} failed (exit ${result.exitCode}): ${result.stdout || command}`,
    );
  return result.stdout;
}
function writeFile(drive: string, path: string, value: string, restoreReadonly = false): string {
  const target = `${drive}:\\${path.replaceAll('/', '\\')}`,
    base64 = Buffer.from(value).toString('base64'),
    quoted = quoteForPowerShell(target);
  return `${restoreReadonly ? `attrib -r ${quoted}; ` : ''}New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${quoted}) | Out-Null; [System.IO.File]::WriteAllBytes(${quoted}, [System.Convert]::FromBase64String(${quoteForPowerShell(base64)})); ${restoreReadonly ? `attrib +r ${quoted}` : ''}`;
}
async function makeInstaller(exec: PowerShellExec, grub: string): Promise<void> {
  rmSync(installer, { force: true });
  await run(exec, buildNewVhdCommand(installer, installerSize), 'create installer disk');
  const handle = parsePartitionHandle(
    await run(exec, buildCreateFat32VolumeCommand(installer, 'INSTALLER'), 'format installer disk'),
  );
  const drive = parseIsoDriveLetter(await run(exec, buildMountIsoCommand(isoPath), 'mount ISO'));
  try {
    await run(exec, buildCopyTreeCommand(drive, handle.driveLetter), 'copy ISO');
  } finally {
    await exec.run(buildDismountIsoCommand(isoPath));
  }
  await run(
    exec,
    writeFile(handle.driveLetter, 'boot/grub/grub.cfg', grub, true),
    'write grub.cfg',
  );
  await run(exec, buildSetEspTypeCommand(handle.diskNumber, handle.partitionNumber), 'set ESP');
  await run(exec, buildDismountVhdCommand(installer), 'dismount installer disk');
}
async function makeSeed(exec: PowerShellExec, user: string, meta: string): Promise<void> {
  rmSync(seed, { force: true });
  await run(exec, buildNewVhdCommand(seed, seedSize), 'create seed disk');
  const handle = parsePartitionHandle(
    await run(exec, buildCreateFat32VolumeCommand(seed, 'CIDATA'), 'format seed disk'),
  );
  await run(exec, writeFile(handle.driveLetter, 'user-data', user), 'write user-data');
  await run(exec, writeFile(handle.driveLetter, 'meta-data', meta), 'write meta-data');
  await run(exec, buildDismountVhdCommand(seed), 'dismount seed disk');
}
async function removeBuildVm(exec: PowerShellExec): Promise<void> {
  await exec.run(buildTurnOffVmCommand(goldenBuildVmName));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await exec.run(buildGetVmCommand(goldenBuildVmName));
    const vm = parseGetVmResult(result.stdout, goldenBuildVmName);
    if (!vm || vm.state === 'Off') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await exec.run(buildRemoveVmCommand(goldenBuildVmName));
}
async function waitForOff(exec: PowerShellExec): Promise<void> {
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const result = await exec.run(buildGetVmCommand(goldenBuildVmName));
    if (parseGetVmResult(result.stdout, goldenBuildVmName)?.state === 'Off') return;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`goldenImage: build VM did not power off; see ${goldenBuildSerialLogPath}`);
}
export async function ensureGoldenImage(
  exec: PowerShellExec,
  keys: HarnessKeys,
  opts: { force?: boolean } = {},
): Promise<string> {
  const grubCfg = buildGrubCfg(),
    metaData = buildMetaData(),
    userData = buildUserData({
      harnessPublicKey: keys.harnessPublicKey,
      guestHostPrivateKey: keys.guestHostPrivateKey,
      guestHostPublicKey: keys.guestHostPublicKey,
    });
  const stamp = computeGoldenStamp({
    userData,
    metaData,
    grubCfg,
    isoUrl,
    harnessPublicKey: keys.harnessPublicKey,
    guestHostPublicKey: keys.guestHostPublicKey,
    buildAlgorithmVersion: BUILD_ALGORITHM_VERSION,
  });
  if (!opts.force && existsSync(goldenVhdPath) && readGoldenStamp() === stamp) return goldenVhdPath;
  clearGoldenStamp();
  await ensureIso();
  await removeBuildVm(exec);
  rmSync(goldenVhdPath, { force: true });
  rmSync(goldenBuildSerialLogPath, { force: true });
  await makeInstaller(exec, grubCfg);
  await makeSeed(exec, userData, metaData);
  await run(exec, buildNewVhdCommand(goldenVhdPath, targetSize), 'create golden disk');
  await run(
    exec,
    buildNewVmCommand(goldenBuildVmName, {
      memoryStartupBytes: 4 * 1024 ** 3,
      switchName: 'Default Switch',
    }),
    'create build VM',
  );
  // A build VM has no recovery point: automatic checkpoints place the writes
  // in transient AVHDX overlays, then Remove-VM discards the finished image
  // (and the installer logs) along with those overlays.
  await run(
    exec,
    `Set-VM -Name ${quoteForPowerShell(goldenBuildVmName)} -AutomaticCheckpointsEnabled $false`,
    'disable automatic checkpoints',
  );
  let serial: ReturnType<typeof startSerialLog> | undefined;
  try {
    for (const [command, what] of [
      [buildAddVmHardDiskCommand(goldenBuildVmName, goldenVhdPath), 'attach target'],
      [buildAddVmHardDiskCommand(goldenBuildVmName, installer), 'attach installer'],
      [buildAddVmHardDiskCommand(goldenBuildVmName, seed), 'attach seed'],
      [buildSetVmProcessorCommand(goldenBuildVmName, 2), 'set processors'],
      [buildDisableSecureBootCommand(goldenBuildVmName), 'disable Secure Boot'],
      [buildSetFirstBootDeviceCommand(goldenBuildVmName, installer), 'set boot device'],
      [buildSetVmComPortCommand(goldenBuildVmName, goldenBuildPipeName), 'attach serial port'],
      [buildStartVmCommand(goldenBuildVmName), 'start build VM'],
    ] as const)
      await run(exec, command, what);
    // The hand-assembled live image hands ttyS0 from early boot to systemd a
    // few seconds after Start-VM. Connecting during that hand-off consistently
    // loses the pipe before Subiquity starts; attach to the stable console.
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    serial = startSerialLog(goldenBuildPipeName, goldenBuildSerialLogPath);
    await waitForOff(exec);
  } finally {
    await serial?.stop();
    await removeBuildVm(exec);
  }
  rmSync(installer, { force: true });
  rmSync(seed, { force: true });
  writeGoldenStamp(stamp);
  return goldenVhdPath;
}
