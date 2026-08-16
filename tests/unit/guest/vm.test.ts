import { describe, expect, it } from 'vitest';
import {
  buildAddVmHardDiskCommand,
  buildDisableSecureBootCommand,
  buildEnableSecureBootCommand,
  buildGetVmNamesCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetFirstBootDeviceCommand,
  buildSetVmComPortCommand,
  buildSetVmDynamicMemoryCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
  parseVmNames,
  SECURE_BOOT_UEFI_CA_TEMPLATE,
} from '../../guest/hyperv/vm';
describe('Hyper-V VM command builders', () => {
  it('creates a Gen2 VM without a disk and attaches an existing VHD', () => {
    expect(
      buildNewVmCommand('vm', { memoryStartupBytes: 2, switchName: 'Default Switch' }),
    ).toContain(
      "New-VM -Name 'vm' -Generation 2 -MemoryStartupBytes 2 -SwitchName 'Default Switch' -NoVHD",
    );
    expect(buildAddVmHardDiskCommand('vm', 'C:\\x.vhdx')).toBe(
      "Add-VMHardDiskDrive -VMName 'vm' -Path 'C:\\x.vhdx' | Out-Null",
    );
  });
  it('builds deterministic resource, firmware, pipe, boot, and teardown commands', () => {
    expect(buildSetVmProcessorCommand('vm', 2)).toContain('-Count 2');
    expect(buildSetVmDynamicMemoryCommand('vm', 1, 2)).toContain(
      '-DynamicMemoryEnabled $true -MinimumBytes 1 -MaximumBytes 2',
    );
    expect(buildDisableSecureBootCommand('vm')).toContain('-EnableSecureBoot Off');
    expect(buildEnableSecureBootCommand('vm')).toContain(
      `-SecureBootTemplate '${SECURE_BOOT_UEFI_CA_TEMPLATE}'`,
    );
    expect(buildSetFirstBootDeviceCommand('vm', 'C:\\x.vhdx')).toContain(
      "$_.Path -eq 'C:\\x.vhdx'",
    );
    expect(buildSetVmComPortCommand('vm', 'pipe')).toContain("'\\\\.\\pipe\\pipe'");
    expect(buildTurnOffVmCommand('vm')).toContain('-TurnOff -Force -ErrorAction SilentlyContinue');
    expect(buildRemoveVmCommand('vm')).toContain('Remove-VM');
  });
  it('discovers and parses VM names consistently', () => {
    expect(buildGetVmNamesCommand('susentorno-test-*')).toContain(
      "Get-VM -Name 'susentorno-test-*'",
    );
    expect(parseVmNames('[{"Name":"a"},{"Name":null},{}]')).toEqual(['a']);
    expect(parseVmNames('{"Name":"a"}')).toEqual(['a']);
    expect(parseVmNames('')).toEqual([]);
  });
});
