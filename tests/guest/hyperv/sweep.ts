import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import {
  buildRemoveLocalUserCommand,
  buildRemoveSmbShareCommand,
  SHARE_ACCOUNT,
  SHARE_NAME,
} from '../testShare';
import { GOLDEN_PARENT_VHD_NAMES, imageCacheDir, NAME_PREFIX } from './imageCache';
import {
  buildGetVmNamesCommand,
  buildRemoveVmCommand,
  buildTurnOffVmCommand,
  parseVmNames,
} from './vm';

export function isSweepableChildVhd(filename: string): boolean {
  return (
    filename.endsWith('.vhdx') &&
    filename.startsWith(`${NAME_PREFIX}-`) &&
    !GOLDEN_PARENT_VHD_NAMES.includes(filename)
  );
}

/** Name-driven, origin-blind cleanup for startup and teardown. */
export async function sweepIsolationResidue(exec: PowerShellExec): Promise<void> {
  const { stdout } = await exec.run(buildGetVmNamesCommand(`${NAME_PREFIX}-*`));
  for (const name of parseVmNames(stdout)) {
    await exec.run(buildTurnOffVmCommand(name));
    await exec.run(buildRemoveVmCommand(name));
  }
  if (existsSync(imageCacheDir))
    for (const entry of readdirSync(imageCacheDir))
      if (isSweepableChildVhd(entry)) rmSync(join(imageCacheDir, entry), { force: true });
  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
}
