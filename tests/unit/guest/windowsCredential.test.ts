import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWindowsCredential,
  generateWindowsPassword,
  WINDOWS_GUEST_USERNAME,
} from '../../guest/hyperv/windowsCredential';

describe('windows guest credential', () => {
  it('uses the built-in Administrator, which is exempt from UAC token filtering', () => {
    expect(WINDOWS_GUEST_USERNAME).toBe('Administrator');
  });

  it('generates distinct passwords meeting Windows complexity policy', () => {
    const password = generateWindowsPassword();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(generateWindowsPassword()).not.toBe(password);
  });

  it('generates once and reuses thereafter, so a cached image stays reachable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-cred-'));
    try {
      const path = join(dir, 'credential.json');
      const first = ensureWindowsCredential(path);
      expect(first.username).toBe('Administrator');
      expect(ensureWindowsCredential(path)).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
