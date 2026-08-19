import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { windowsCredentialPath } from './imageCache';

export interface WindowsCredential {
  username: string;
  password: string;
}

/**
 * The built-in RID-500 account, deliberately. PowerShell Direct runs with the
 * supplied guest credential rather than inheriting the host's elevation, and
 * the built-in Administrator is exempt from the UAC admin-approval-mode
 * filtering that would otherwise hand back a limited token —
 * `nn-configure-network.ps1` declares `#Requires -RunAsAdministrator`.
 * windowsGuestExec asserts elevation at runtime rather than trusting this.
 */
export const WINDOWS_GUEST_USERNAME = 'Administrator';

/** Windows local-account policy wants three of four character classes. */
export function generateWindowsPassword(): string {
  return `${randomBytes(15).toString('base64url')}Aa1!`;
}

/**
 * Generated once and persisted, the same treatment harnessKeys.ts gives the
 * harness private key. It is a stamp input, so deleting this file forces a
 * rebuild rather than leaving an image nobody can log into.
 */
export function ensureWindowsCredential(path: string = windowsCredentialPath): WindowsCredential {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowsCredential>;
    if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
      return { username: parsed.username, password: parsed.password };
    }
  }
  const credential: WindowsCredential = {
    username: WINDOWS_GUEST_USERNAME,
    password: generateWindowsPassword(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  return credential;
}
