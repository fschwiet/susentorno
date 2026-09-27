import { existsSync } from 'node:fs';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import { windowsIsoPath } from './hyperv/imageCache';
import { requireWindowsHost } from '../requireWindowsHost';

/** Values of Get-WindowsImage's `Architecture` (the DISM ImageArchitecture enum). */
const ARCHITECTURES: Record<string, string> = {
  '0': 'x86',
  '5': 'arm',
  '6': 'ia64',
  '9': 'x64',
  '12': 'arm64',
};

const REQUIRED_ARCHITECTURE = 'x64';
const REQUIRED_LANGUAGE = 'en-us';
const NO_INSTALL_WIM = 'NO-INSTALL-WIM';
const NO_DRIVE_LETTER = 'NO-DRIVE-LETTER';
const WANTED_ISO = `an ${REQUIRED_ARCHITECTURE} ${REQUIRED_LANGUAGE} Windows 11 Enterprise evaluation ISO`;

/**
 * Turn the image listing the ISO check prints (one `IMAGE|<architecture>|
 * <languages>|<name>` line per image in `sources\install.wim`, or
 * `NO-INSTALL-WIM`, or `NO-DRIVE-LETTER`) into a fix-it message, or null when some image is x64 and
 * `en-us`, which the Windows golden image build's autounattend.xml assumes.
 * Other lines are ignored: the exec merges stderr into stdout.
 */
export function describeWindowsIsoImages(isoPath: string, output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const images = lines
    .filter((line) => line.startsWith('IMAGE|'))
    .map((line) => {
      const [, architecture = '', languages = '', ...name] = line.split('|');
      return {
        name: name.join('|'),
        architecture: ARCHITECTURES[architecture] ?? `unknown architecture ${architecture}`,
        languages: languages.split(',').filter((language) => language !== ''),
      };
    });

  if (images.length === 0) {
    if (lines.includes(NO_DRIVE_LETTER)) {
      return (
        `The Windows ISO at '${isoPath}' mounted but got no drive letter, so the check could ` +
        'not read its images. Volume automount may be disabled on this host; enable it with ' +
        '`mountvol /e` (elevated) and re-run.'
      );
    }
    return (
      `The Windows ISO at '${isoPath}' has no sources\\install.wim` +
      (lines.includes(NO_INSTALL_WIM) ? '' : ' image the check could read') +
      `. The guest tier needs ${WANTED_ISO}.`
    );
  }

  const suitable = images.some(
    (image) =>
      image.architecture === REQUIRED_ARCHITECTURE &&
      image.languages.some((language) => language.toLowerCase() === REQUIRED_LANGUAGE),
  );
  if (suitable) return null;

  const found = images
    .map((image) => `  ${image.name} (${image.architecture}, ${image.languages.join(', ')})`)
    .join('\n');
  return (
    `The Windows ISO at '${isoPath}' has no ${REQUIRED_ARCHITECTURE} ${REQUIRED_LANGUAGE} image in ` +
    `install.wim. It holds:\n${found}\n` +
    `Point SUSENTORNO_WINDOWS_ISO at ${WANTED_ISO}.`
  );
}

/**
 * Guard: the guest tier's windowsFresh role builds a golden image from this
 * ISO, a build that takes 60-120 minutes and only then fails on a wrong one.
 * Check the variable, the file, and the image metadata up front instead. The
 * ISO is mounted read-only and dismounted again; an ISO that was already
 * mounted is read in place and left mounted.
 */
export async function checkWindowsIso(): Promise<void> {
  requireWindowsHost();
  const isoPath = windowsIsoPath();
  if (!existsSync(isoPath)) {
    throw new Error(
      `SUSENTORNO_WINDOWS_ISO points at '${isoPath}', which does not exist. Point it at a local ` +
        `path to ${WANTED_ISO}.`,
    );
  }

  const quoted = quoteForPowerShell(isoPath);
  const exec = createRealPowerShellExec();
  const { exitCode, stdout } = await exec.run(
    "$ErrorActionPreference = 'Stop'; " +
      // Leave an ISO someone already mounted as it was: read it in place and
      // dismount only what this check mounted.
      `$image = Get-DiskImage -ImagePath ${quoted}; ` +
      '$mountedHere = -not $image.Attached; ' +
      'if ($mountedHere) { ' +
      `$image = Mount-DiskImage -ImagePath ${quoted} -Access ReadOnly -StorageType ISO -PassThru }; ` +
      'try { ' +
      '$letter = ($image | Get-Volume).DriveLetter; ' +
      `if (-not $letter) { '${NO_DRIVE_LETTER}' } else { ` +
      '$wim = "$($letter):\\sources\\install.wim"; ' +
      `if (-not (Test-Path -LiteralPath $wim)) { '${NO_INSTALL_WIM}' } else { ` +
      'Get-WindowsImage -ImagePath $wim | ForEach-Object { ' +
      '$info = Get-WindowsImage -ImagePath $wim -Index $_.ImageIndex; ' +
      '"IMAGE|$($info.Architecture)|$($info.Languages -join \',\')|$($info.ImageName)" } } } ' +
      `} finally { if ($mountedHere) { Dismount-DiskImage -ImagePath ${quoted} | Out-Null } }`,
  );
  if (exitCode !== 0) {
    throw new Error(
      `Could not read the Windows ISO at '${isoPath}' (PowerShell exited ${exitCode}):\n${stdout}\n` +
        'Mounting the ISO needs an elevated (Administrator) shell; re-run from one if this is ' +
        'an access-denied error.',
    );
  }
  const message = describeWindowsIsoImages(isoPath, stdout);
  if (message) throw new Error(message);
}
