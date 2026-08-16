import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * A Generation 2 VM's UEFI firmware boots through an EFI System Partition, and
 * New-Partition creates a basic-data partition by default. Some firmware will
 * scan the fallback \EFI\BOOT\BOOTX64.EFI path on a basic-data FAT32 partition,
 * but the golden build must not rest on that.
 *
 * The type is nonetheless applied LAST, by buildSetEspTypeCommand, not at
 * New-Partition time: Windows hides an ESP from volume enumeration, so
 * -AssignDriveLetter does not reliably give it a letter — and without a letter
 * there is nothing to Copy-Item the ISO tree into. Create as basic data, format,
 * populate, then retype. The finished on-disk layout is identical, which is all
 * the firmware sees.
 *
 * The installer-boot spike also established that Copy-Item preserves the ISO's
 * read-only bit on boot/grub/grub.cfg. The golden-image orchestration clears it
 * only while writing the autoinstall configuration, then restores it.
 */
export const EFI_SYSTEM_PARTITION_GPT_TYPE = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}';

export function buildNewVhdCommand(path: string, sizeBytes: number): string {
  return `New-VHD -Path ${quoteForPowerShell(path)} -SizeBytes ${sizeBytes} -Dynamic | Out-Null`;
}

/**
 * Hyper-V stamps parent identity into each child, so the golden VHDX must never
 * be booted or modified after the build — touching it invalidates every overlay.
 */
export function buildNewDifferencingVhdCommand(path: string, parentPath: string): string {
  return (
    `New-VHD -Path ${quoteForPowerShell(path)} -ParentPath ${quoteForPowerShell(parentPath)} ` +
    `-Differencing | Out-Null`
  );
}

/**
 * Mount, GPT-initialize, take the whole disk as one basic-data partition, format
 * FAT32, and report back the handle the caller needs for both halves of what
 * follows: the drive letter to copy into, and the disk/partition numbers
 * Set-Partition takes (it has no -DriveLetter parameter).
 */
export function buildCreateFat32VolumeCommand(vhdPath: string, label: string): string {
  return (
    `$d = Mount-VHD -Path ${quoteForPowerShell(vhdPath)} -Passthru | ` +
    `Initialize-Disk -PartitionStyle GPT -PassThru; ` +
    `$p = $d | New-Partition -UseMaximumSize -AssignDriveLetter; ` +
    `Format-Volume -Partition $p -FileSystem FAT32 ` +
    `-NewFileSystemLabel ${quoteForPowerShell(label)} -Confirm:$false | Out-Null; ` +
    `[PSCustomObject]@{ DriveLetter = $p.DriveLetter; DiskNumber = $p.DiskNumber; ` +
    `PartitionNumber = $p.PartitionNumber } | ConvertTo-Json -Compress`
  );
}

export interface PartitionHandle {
  driveLetter: string;
  diskNumber: number;
  partitionNumber: number;
}

interface RawPartitionHandle {
  DriveLetter?: unknown;
  DiskNumber?: unknown;
  PartitionNumber?: unknown;
}

export function parsePartitionHandle(stdout: string): PartitionHandle {
  const trimmed = stdout.trim();
  const raw = (trimmed ? (JSON.parse(trimmed) as RawPartitionHandle) : {}) as RawPartitionHandle;
  if (typeof raw.DriveLetter !== 'string' || raw.DriveLetter === '') {
    throw new Error(
      `vhd: the new FAT32 volume came back with no drive letter: ${stdout || '<empty>'}`,
    );
  }
  return {
    driveLetter: raw.DriveLetter,
    diskNumber: Number(raw.DiskNumber),
    partitionNumber: Number(raw.PartitionNumber),
  };
}

export function buildSetEspTypeCommand(diskNumber: number, partitionNumber: number): string {
  return (
    `Set-Partition -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} ` +
    `-GptType ${quoteForPowerShell(EFI_SYSTEM_PARTITION_GPT_TYPE)}`
  );
}

export function buildDismountVhdCommand(vhdPath: string): string {
  return `Dismount-VHD -Path ${quoteForPowerShell(vhdPath)}`;
}

export function buildMountIsoCommand(isoPath: string): string {
  return (
    `$i = Mount-DiskImage -ImagePath ${quoteForPowerShell(isoPath)} -PassThru; ` +
    `[PSCustomObject]@{ DriveLetter = ($i | Get-Volume).DriveLetter } | ConvertTo-Json -Compress`
  );
}

export function parseIsoDriveLetter(stdout: string): string {
  const trimmed = stdout.trim();
  const raw = (trimmed ? (JSON.parse(trimmed) as { DriveLetter?: unknown }) : {}) as {
    DriveLetter?: unknown;
  };
  if (typeof raw.DriveLetter !== 'string' || raw.DriveLetter === '') {
    throw new Error(`vhd: the ISO mounted with no drive letter: ${stdout || '<empty>'}`);
  }
  return raw.DriveLetter;
}

/** Dismount-DiskImage takes the image path, never a drive letter or a handle. */
export function buildDismountIsoCommand(isoPath: string): string {
  return `Dismount-DiskImage -ImagePath ${quoteForPowerShell(isoPath)} | Out-Null`;
}

/** `X:\*`, not `X:\` — copying the drive root itself would nest a directory. */
export function buildCopyTreeCommand(fromDrive: string, toDrive: string): string {
  return (
    `Copy-Item -Path ${quoteForPowerShell(`${fromDrive}:\\*`)} ` +
    `-Destination ${quoteForPowerShell(`${toDrive}:\\`)} -Recurse -Force`
  );
}
