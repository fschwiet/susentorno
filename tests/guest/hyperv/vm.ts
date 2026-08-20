import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';
export const SECURE_BOOT_UEFI_CA_TEMPLATE = 'MicrosoftUEFICertificateAuthority';
export interface NewVmOptions {
  memoryStartupBytes: number;
  switchName: string;
}
export function buildNewVmCommand(name: string, options: NewVmOptions): string {
  return `New-VM -Name ${quoteForPowerShell(name)} -Generation 2 -MemoryStartupBytes ${options.memoryStartupBytes} -SwitchName ${quoteForPowerShell(options.switchName)} -NoVHD | Out-Null`;
}
export function buildAddVmHardDiskCommand(name: string, path: string): string {
  return `Add-VMHardDiskDrive -VMName ${quoteForPowerShell(name)} -Path ${quoteForPowerShell(path)} | Out-Null`;
}
export function buildSetVmProcessorCommand(name: string, count: number): string {
  return `Set-VMProcessor -VMName ${quoteForPowerShell(name)} -Count ${count}`;
}
export function buildSetVmDynamicMemoryCommand(
  name: string,
  minBytes: number,
  maxBytes: number,
): string {
  return `Set-VMMemory -VMName ${quoteForPowerShell(name)} -DynamicMemoryEnabled $true -MinimumBytes ${minBytes} -MaximumBytes ${maxBytes}`;
}
export function buildDisableSecureBootCommand(name: string): string {
  return `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot Off`;
}
export function buildEnableSecureBootCommand(name: string): string {
  return `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot On -SecureBootTemplate ${quoteForPowerShell(SECURE_BOOT_UEFI_CA_TEMPLATE)}`;
}
export function buildSetFirstBootDeviceCommand(name: string, path: string): string {
  const vm = quoteForPowerShell(name);
  return `$drive = Get-VMHardDiskDrive -VMName ${vm} | Where-Object { $_.Path -eq ${quoteForPowerShell(path)} }; Set-VMFirmware -VMName ${vm} -FirstBootDevice $drive`;
}
export function buildSetVmComPortCommand(name: string, pipeName: string): string {
  return `Set-VMComPort -VMName ${quoteForPowerShell(name)} -Number 1 -Path ${quoteForPowerShell(`\\\\.\\pipe\\${pipeName}`)}`;
}
export function buildTurnOffVmCommand(name: string): string {
  return `Stop-VM -Name ${quoteForPowerShell(name)} -TurnOff -Force -ErrorAction SilentlyContinue`;
}
export function buildRemoveVmCommand(name: string): string {
  return `Remove-VM -Name ${quoteForPowerShell(name)} -Force -ErrorAction SilentlyContinue`;
}
export function buildGetVmNamesCommand(pattern: string): string {
  return `Get-VM -Name ${quoteForPowerShell(pattern)} -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ Name = $_.Name } } | ConvertTo-Json -Compress`;
}
export function parseVmNames(stdout: string): string[] {
  if (!stdout.trim()) return [];
  const values = Array.isArray(JSON.parse(stdout)) ? JSON.parse(stdout) : [JSON.parse(stdout)];
  return values
    .map((value: { Name?: unknown }) => value.Name)
    .filter((name: unknown): name is string => typeof name === 'string' && name !== '');
}

/**
 * Windows guests boot with the Microsoft Windows template; the UEFI CA
 * template above is for Ubuntu's shim. No vTPM accompanies it — Secure Boot
 * and vTPM are independent, and omitting the TPM is what keeps automatic
 * device encryption from sealing the golden volume to the build VM (see the
 * spec's section 1.4).
 */
export const SECURE_BOOT_WINDOWS_TEMPLATE = 'MicrosoftWindows';

export function buildEnableSecureBootWindowsCommand(name: string): string {
  return `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot On -SecureBootTemplate ${quoteForPowerShell(SECURE_BOOT_WINDOWS_TEMPLATE)}`;
}

export function buildAddVmDvdDriveCommand(name: string, path: string): string {
  return `Add-VMDvdDrive -VMName ${quoteForPowerShell(name)} -Path ${quoteForPowerShell(path)} | Out-Null`;
}

/**
 * buildSetFirstBootDeviceCommand resolves a Get-VMHardDiskDrive by path and
 * cannot select an optical drive, so the DVD boot path needs its own builder.
 */
export function buildSetFirstBootDvdCommand(name: string, path: string): string {
  const vm = quoteForPowerShell(name);
  return `$dvd = Get-VMDvdDrive -VMName ${vm} | Where-Object { $_.Path -eq ${quoteForPowerShell(path)} }; Set-VMFirmware -VMName ${vm} -FirstBootDevice $dvd`;
}
