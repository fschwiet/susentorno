import { describe, expect, it } from 'vitest';
import {
  buildCopyTreeCommand,
  buildCreateFat32VolumeCommand,
  buildDismountIsoCommand,
  buildDismountVhdCommand,
  buildMountIsoCommand,
  buildNewDifferencingVhdCommand,
  buildNewVhdCommand,
  buildSetEspTypeCommand,
  EFI_SYSTEM_PARTITION_GPT_TYPE,
  parseIsoDriveLetter,
  parsePartitionHandle,
} from '../../guest/hyperv/vhd';

describe('VHD creation commands', () => {
  it('creates a dynamic VHD at an exact byte size', () => {
    expect(buildNewVhdCommand('C:\\x\\installer.vhdx', 4 * 1024 ** 3)).toBe(
      "New-VHD -Path 'C:\\x\\installer.vhdx' -SizeBytes 4294967296 -Dynamic | Out-Null",
    );
  });

  it('creates a differencing VHD against a parent', () => {
    expect(
      buildNewDifferencingVhdCommand('C:\\x\\susentorno-test-e2e.vhdx', 'C:\\x\\golden.vhdx'),
    ).toBe(
      "New-VHD -Path 'C:\\x\\susentorno-test-e2e.vhdx' -ParentPath 'C:\\x\\golden.vhdx' " +
        '-Differencing | Out-Null',
    );
  });

  it("doubles embedded single quotes rather than breaking out of PowerShell's string", () => {
    expect(buildNewVhdCommand("C:\\o'brien\\d.vhdx", 1024)).toContain("'C:\\o''brien\\d.vhdx'");
  });
});

describe('buildCreateFat32VolumeCommand', () => {
  const command = buildCreateFat32VolumeCommand('C:\\x\\installer.vhdx', 'CIDATA');

  it('initializes GPT, takes the maximum size, and formats FAT32 with the label', () => {
    expect(command).toContain("Mount-VHD -Path 'C:\\x\\installer.vhdx' -Passthru");
    expect(command).toContain('Initialize-Disk -PartitionStyle GPT -PassThru');
    expect(command).toContain('New-Partition -UseMaximumSize -AssignDriveLetter');
    expect(command).toContain('-FileSystem FAT32');
    expect(command).toContain("-NewFileSystemLabel 'CIDATA'");
    expect(command).toContain('-Confirm:$false');
  });

  it('creates a basic-data partition, NOT an ESP — the type is applied after copying', () => {
    expect(command).not.toContain(EFI_SYSTEM_PARTITION_GPT_TYPE);
  });

  it('returns the drive letter and the disk/partition numbers as compressed JSON', () => {
    expect(command).toContain('ConvertTo-Json -Compress');
    expect(command).toContain('DriveLetter');
    expect(command).toContain('DiskNumber');
    expect(command).toContain('PartitionNumber');
  });
});

describe('parsePartitionHandle', () => {
  it('parses the JSON the create command emits', () => {
    expect(parsePartitionHandle('{"DriveLetter":"E","DiskNumber":3,"PartitionNumber":1}')).toEqual({
      driveLetter: 'E',
      diskNumber: 3,
      partitionNumber: 1,
    });
  });

  it('throws with the raw output when no drive letter came back', () => {
    expect(() =>
      parsePartitionHandle('{"DriveLetter":null,"DiskNumber":3,"PartitionNumber":1}'),
    ).toThrow(/no drive letter/);
  });

  it('throws with the raw output when nothing came back at all', () => {
    expect(() => parsePartitionHandle('   ')).toThrow(/no drive letter/);
  });
});

describe('buildSetEspTypeCommand', () => {
  it('retypes the partition as an EFI System Partition by disk and partition number', () => {
    expect(buildSetEspTypeCommand(3, 1)).toBe(
      "Set-Partition -DiskNumber 3 -PartitionNumber 1 -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'",
    );
  });

  it('uses the EFI System Partition GUID, not New-Partitions default basic-data type', () => {
    expect(EFI_SYSTEM_PARTITION_GPT_TYPE).toBe('{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}');
  });
});

describe('ISO mounting', () => {
  it('mounts an ISO and reports its drive letter as JSON', () => {
    const command = buildMountIsoCommand('C:\\x\\ubuntu.iso');
    expect(command).toContain("Mount-DiskImage -ImagePath 'C:\\x\\ubuntu.iso' -PassThru");
    expect(command).toContain('Get-Volume');
    expect(command).toContain('ConvertTo-Json -Compress');
  });

  it('parses the mounted drive letter', () => {
    expect(parseIsoDriveLetter('{"DriveLetter":"F"}')).toBe('F');
  });

  it('throws when the ISO mounted with no drive letter', () => {
    expect(() => parseIsoDriveLetter('{"DriveLetter":null}')).toThrow(/no drive letter/);
  });

  it('dismounts by image path, which is the only handle Dismount-DiskImage takes', () => {
    expect(buildDismountIsoCommand('C:\\x\\ubuntu.iso')).toBe(
      "Dismount-DiskImage -ImagePath 'C:\\x\\ubuntu.iso' | Out-Null",
    );
  });
});

describe('buildCopyTreeCommand', () => {
  it('copies the whole tree recursively, contents-first', () => {
    expect(buildCopyTreeCommand('F', 'E')).toBe(
      "Copy-Item -Path 'F:\\*' -Destination 'E:\\' -Recurse -Force",
    );
  });
});

describe('buildDismountVhdCommand', () => {
  it('dismounts by path', () => {
    expect(buildDismountVhdCommand('C:\\x\\installer.vhdx')).toBe(
      "Dismount-VHD -Path 'C:\\x\\installer.vhdx'",
    );
  });
});
