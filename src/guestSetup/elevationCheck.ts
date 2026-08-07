import type { PowerShellExec } from './powerShellExec';

export function buildElevationCheckCommand(): string {
  return (
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
    '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  );
}

export async function isElevated(exec: PowerShellExec): Promise<boolean> {
  const { exitCode, stdout } = await exec.run(buildElevationCheckCommand());
  return exitCode === 0 && stdout.trim() === 'True';
}
