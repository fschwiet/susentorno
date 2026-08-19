import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { buildGetVmCommand, parseGetVmResult } from '../../../src/guestSetup/hyperVQueries';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';
import { buildAutounattendXml, buildProvisioningScript } from '../windowsAutounattend';
import { writeAnswerFileIso } from './answerFileIso';
import { buildDefeatCdBootPromptCommand } from './windowsBootPrompt';
import {
  imageCacheDir,
  NAME_PREFIX,
  windowsAnswerIsoPath,
  windowsBuildScreenshotDir,
  windowsGoldenStampPath,
  windowsGoldenVhdPath,
  windowsIsoPath,
  WINDOWS_ISO_ENV_VAR,
  WINDOWS_REBUILD_ENV_VAR,
} from './imageCache';
import {
  clearStampMap,
  computeStampMap,
  diffStampMaps,
  readStampMap,
  stampAgeDays,
  STAMP_BUILT_AT_KEY,
  writeStampMap,
  type StampInputs,
} from './stampMap';
import { startScreenshotCapture } from './vmScreenshot';
import { buildNewVhdCommand } from './vhd';
import {
  buildAddVmDvdDriveCommand,
  buildDisableSecureBootCommand,
  buildAddVmHardDiskCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetFirstBootDvdCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

export class WindowsImageError extends Error {}

/** Increment when the build pipeline, rather than a seed input, changes. */
const BUILD_ALGORITHM_VERSION = 1;
/**
 * The Enterprise evaluation is time-limited. An input-only stamp would stay
 * valid forever while guests inside began shutting down periodically, so the
 * build date is recorded and an old image is refused with a clear reason
 * rather than failing confusingly months later.
 */
export const MAX_IMAGE_AGE_DAYS = 60;
const BUILD_TIMEOUT_MS = 3 * 60 * 60_000;

const buildVmName = `${NAME_PREFIX}-windows-golden-build`;
const targetSize = 127 * 1024 ** 3;

export interface WindowsStampArgs {
  answerXml: string;
  provisioningScript: string;
  isoSha256: string;
  password: string;
}

export function buildWindowsStampInputs(args: WindowsStampArgs): StampInputs {
  return {
    answerXml: args.answerXml,
    provisioningScript: args.provisioningScript,
    isoSha256: args.isoSha256,
    password: args.password,
    buildAlgorithmVersion: BUILD_ALGORITHM_VERSION,
  };
}

export function describeStaleImage(changed: string[], ageDays: number | null): string {
  const reasons: string[] = [];
  if (changed.length > 0) reasons.push(`these build inputs changed: ${changed.join(', ')}`);
  if (ageDays !== null && ageDays > MAX_IMAGE_AGE_DAYS) {
    reasons.push(
      `the image is ${ageDays} days old, past the ${MAX_IMAGE_AGE_DAYS}-day ceiling that keeps it ` +
        'inside the Windows evaluation window',
    );
  }
  return (
    `windowsGoldenImage: the cached image at ${windowsGoldenVhdPath} is stale — ` +
    `${reasons.join('; ')}. Rebuilding takes 60-120 minutes, so it is not done for you: ` +
    `re-run with ${WINDOWS_REBUILD_ENV_VAR}=1 to rebuild.`
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function run(exec: PowerShellExec, command: string, what: string): Promise<string> {
  const { exitCode, stdout } = await exec.run(command);
  if (exitCode !== 0) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${what} failed (exit ${exitCode}): ${stdout || command}`,
    );
  }
  return stdout;
}

async function removeBuildVm(exec: PowerShellExec): Promise<void> {
  await exec.run(buildTurnOffVmCommand(buildVmName));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { stdout } = await exec.run(buildGetVmCommand(buildVmName));
    const vm = parseGetVmResult(stdout, buildVmName);
    if (!vm || vm.state === 'Off') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await exec.run(buildRemoveVmCommand(buildVmName));
}

async function waitForOff(exec: PowerShellExec): Promise<void> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { stdout } = await exec.run(buildGetVmCommand(buildVmName));
    if (parseGetVmResult(stdout, buildVmName)?.state === 'Off') return;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new WindowsImageError(
    `windowsGoldenImage: the build VM never powered off within ${Math.round(
      BUILD_TIMEOUT_MS / 60_000,
    )} minutes.\n` +
      `  Screenshots: ${windowsBuildScreenshotDir}\n` +
      `  Target disk: ${windowsGoldenVhdPath} — mount it offline and read ` +
      'Windows\\Panther\\setupact.log and setuperr.log for detail the thumbnails cannot show.',
  );
}

export async function ensureWindowsGoldenImage(
  exec: PowerShellExec,
  credential: { username: string; password: string },
  opts: { force?: boolean } = {},
): Promise<string> {
  const isoPath = windowsIsoPath();
  if (isoPath === null) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${WINDOWS_ISO_ENV_VAR} is not set. Point it at an x64 en-us Windows 11 ` +
        'Enterprise evaluation ISO (see testing.md).',
    );
  }
  if (!existsSync(isoPath)) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${WINDOWS_ISO_ENV_VAR} points at '${isoPath}', which does not exist.`,
    );
  }

  const provisioningScript = buildProvisioningScript();
  const answerXml = buildAutounattendXml({ password: credential.password, provisioningScript });
  const isoSha256 = await fileSha256(isoPath);
  const inputs = buildWindowsStampInputs({
    answerXml,
    provisioningScript,
    isoSha256,
    password: credential.password,
  });
  const next = computeStampMap(inputs);
  const previous = readStampMap(windowsGoldenStampPath);
  const force = opts.force === true || process.env[WINDOWS_REBUILD_ENV_VAR] === '1';

  if (existsSync(windowsGoldenVhdPath) && !force) {
    const changed = diffStampMaps(previous, next);
    const ageDays = previous === null ? null : stampAgeDays(previous);
    const tooOld = ageDays !== null && ageDays > MAX_IMAGE_AGE_DAYS;
    if (changed.length === 0 && !tooOld) return windowsGoldenVhdPath;
    throw new WindowsImageError(describeStaleImage(changed, ageDays));
  }

  mkdirSync(imageCacheDir, { recursive: true });
  clearStampMap(windowsGoldenStampPath);
  await removeBuildVm(exec);
  rmSync(windowsGoldenVhdPath, { force: true });
  rmSync(windowsBuildScreenshotDir, { recursive: true, force: true });

  await writeAnswerFileIso(exec, windowsAnswerIsoPath, answerXml);
  await run(exec, buildNewVhdCommand(windowsGoldenVhdPath, targetSize), 'create golden disk');
  await run(
    exec,
    buildNewVmCommand(buildVmName, {
      // 4 GiB (Windows 11's bare documented minimum) was not enough: Setup's
      // WinPE apply-image/specialize phase crashed with "the computer
      // restarted unexpectedly" at a consistent point, confirmed live and
      // reproduced with no console ever connected — ruling out an Enhanced
      // Session interaction and pointing at memory pressure during that
      // pre-OOBE phase, before Hyper-V's dynamic-memory balloon driver is
      // even available to help.
      memoryStartupBytes: 6 * 1024 ** 3,
      switchName: 'Default Switch',
    }),
    'create build VM',
  );
  await run(
    exec,
    `Set-VM -Name ${quoteForPowerShell(buildVmName)} -AutomaticCheckpointsEnabled $false`,
    'disable automatic checkpoints',
  );

  let screenshots: ReturnType<typeof startScreenshotCapture> | undefined;
  try {
    for (const [command, what] of [
      [buildAddVmHardDiskCommand(buildVmName, windowsGoldenVhdPath), 'attach target disk'],
      [buildAddVmDvdDriveCommand(buildVmName, isoPath), 'attach installation ISO'],
      [buildAddVmDvdDriveCommand(buildVmName, windowsAnswerIsoPath), 'attach answer-file ISO'],
      [buildSetVmProcessorCommand(buildVmName, 2), 'set processors'],
      // Off for the build, exactly as the Ubuntu build does: it is not a
      // property the installed image persists, and it removes one variable
      // from the least-debuggable phase. The role VM enables it.
      [buildDisableSecureBootCommand(buildVmName), 'disable Secure Boot for the build'],
      [buildSetFirstBootDvdCommand(buildVmName, isoPath), 'boot the installation ISO'],
      [buildStartVmCommand(buildVmName), 'start build VM'],
    ] as const) {
      await run(exec, command, what);
    }
    // Windows Setup media's own boot loader prompts "Press any key to boot
    // from CD or DVD..." with a short timeout before falling through to the
    // next boot device; an unattended start never presses one. Confirmed on
    // a real host: without this, the build VM sits at the firmware's boot
    // summary ("the boot loader failed") until BUILD_TIMEOUT_MS.
    await run(
      exec,
      buildDefeatCdBootPromptCommand(buildVmName, 20),
      'clear the DVD "press any key" prompt',
    );
    screenshots = startScreenshotCapture(exec, buildVmName, windowsBuildScreenshotDir);
    await waitForOff(exec);
  } finally {
    await screenshots?.stop();
    await removeBuildVm(exec);
  }

  rmSync(windowsAnswerIsoPath, { force: true });
  writeStampMap(windowsGoldenStampPath, {
    ...next,
    [STAMP_BUILT_AT_KEY]: new Date().toISOString(),
  });
  return windowsGoldenVhdPath;
}
