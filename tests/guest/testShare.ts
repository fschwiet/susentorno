import { randomBytes } from 'node:crypto';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';

/** Kept within New-LocalUser's 20-character name limit. */
export const SHARE_ACCOUNT = 'susentorno-test';
/** SMB share names are machine-global, so this is deliberately namespaced. */
export const SHARE_NAME = 'susentorno-test-vm-shared-linux';

export function generateSharePassword(): string {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

export function buildRemoveLocalUserCommand(name: string): string {
  return `Remove-LocalUser -Name ${quoteForPowerShell(name)} -ErrorAction SilentlyContinue`;
}
export function buildNewLocalUserCommand(name: string, password: string): string {
  return (
    `$password = New-Object System.Security.SecureString; ${quoteForPowerShell(password)}.ToCharArray() | ` +
    'ForEach-Object { $password.AppendChar($_) }; $password.MakeReadOnly(); ' +
    `New-LocalUser -Name ${quoteForPowerShell(name)} -Password $password ` +
    `-PasswordNeverExpires -UserMayNotChangePassword | Out-Null`
  );
}
export function buildRemoveSmbShareCommand(name: string): string {
  return `Remove-SmbShare -Name ${quoteForPowerShell(name)} -Force -ErrorAction SilentlyContinue`;
}
export function buildNewSmbShareCommand(name: string, path: string, account: string): string {
  return `New-SmbShare -Name ${quoteForPowerShell(name)} -Path ${quoteForPowerShell(path)} -ReadAccess ${quoteForPowerShell(account)} | Out-Null`;
}
export function buildGrantNtfsReadExecuteCommand(path: string, account: string): string {
  return `icacls ${quoteForPowerShell(path)} /grant ${quoteForPowerShell(`${account}:(OI)(CI)(RX)`)} | Out-Null`;
}
export function buildRevokeNtfsAceCommand(path: string, account: string): string {
  return `icacls ${quoteForPowerShell(path)} /remove:g ${quoteForPowerShell(account)} | Out-Null`;
}

export interface TestShare {
  account: string;
  shareName: string;
  password: string;
}

export async function createTestShare(exec: PowerShellExec, sharePath: string): Promise<TestShare> {
  const password = generateSharePassword();
  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
  const created = await exec.run(buildNewLocalUserCommand(SHARE_ACCOUNT, password));
  if (created.exitCode !== 0)
    throw new Error(`testShare: could not create '${SHARE_ACCOUNT}': ${created.stdout}`);
  const granted = await exec.run(buildGrantNtfsReadExecuteCommand(sharePath, SHARE_ACCOUNT));
  if (granted.exitCode !== 0)
    throw new Error(`testShare: could not grant NTFS access on '${sharePath}': ${granted.stdout}`);
  const shared = await exec.run(buildNewSmbShareCommand(SHARE_NAME, sharePath, SHARE_ACCOUNT));
  if (shared.exitCode !== 0)
    throw new Error(`testShare: could not create share '${SHARE_NAME}': ${shared.stdout}`);
  return { account: SHARE_ACCOUNT, shareName: SHARE_NAME, password };
}

export async function removeTestShare(exec: PowerShellExec, sharePath: string): Promise<void> {
  await exec.run(buildRemoveSmbShareCommand(SHARE_NAME));
  await exec.run(buildRevokeNtfsAceCommand(sharePath, SHARE_ACCOUNT));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
}
