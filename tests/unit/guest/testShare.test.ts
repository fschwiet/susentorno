import { describe, expect, it } from 'vitest';
import {
  ALL_SHARE_NAMES,
  buildGrantNtfsReadExecuteCommand,
  buildNewLocalUserCommand,
  buildNewSmbShareCommand,
  buildRemoveLocalUserCommand,
  buildRemoveSmbShareCommand,
  buildRevokeNtfsAceCommand,
  generateSharePassword,
  shareNameFor,
  SHARE_ACCOUNT,
} from '../../guest/testShare';

describe('test share', () => {
  it('uses a local-account-safe, machine-global-share-safe name per share folder', () => {
    expect(SHARE_ACCOUNT).toBe('susentorno-test');
    expect(SHARE_ACCOUNT.length).toBeLessThanOrEqual(20);
    expect(shareNameFor('vm-shared-linux')).toBe('susentorno-test-vm-shared-linux');
    expect(shareNameFor('vm-shared-windows')).toBe('susentorno-test-vm-shared-windows');
    expect(ALL_SHARE_NAMES).toEqual([
      'susentorno-test-vm-shared-linux',
      'susentorno-test-vm-shared-windows',
    ]);
  });
  it('generates distinct policy-safe passwords', () => {
    const password = generateSharePassword();
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(generateSharePassword()).not.toBe(password);
  });
  it('quotes local-account creation and makes removal idempotent', () => {
    expect(buildRemoveLocalUserCommand(SHARE_ACCOUNT)).toBe(
      "Remove-LocalUser -Name 'susentorno-test' -ErrorAction SilentlyContinue",
    );
    expect(buildNewLocalUserCommand(SHARE_ACCOUNT, "pa'ss1!")).toContain("'pa''ss1!'");
    expect(buildNewLocalUserCommand(SHARE_ACCOUNT, 'password')).toContain(
      'System.Security.SecureString',
    );
  });
  it('creates a single-account read-only share and removes it idempotently', () => {
    expect(buildRemoveSmbShareCommand(shareNameFor('vm-shared-linux'))).toContain(
      '-Force -ErrorAction SilentlyContinue',
    );
    const command = buildNewSmbShareCommand(
      shareNameFor('vm-shared-linux'),
      'C:\\repo\\share',
      SHARE_ACCOUNT,
    );
    expect(command).toContain("-Name 'susentorno-test-vm-shared-linux'");
    expect(command).toContain("-Path 'C:\\repo\\share'");
    expect(command).toContain("-ReadAccess 'susentorno-test'");
  });
  it('grants and revokes the inheritable NTFS read-and-execute ACE', () => {
    expect(buildGrantNtfsReadExecuteCommand('C:\\repo\\share', SHARE_ACCOUNT)).toContain(
      '(OI)(CI)(RX)',
    );
    expect(buildRevokeNtfsAceCommand('C:\\repo\\share', SHARE_ACCOUNT)).toContain('/remove:g');
  });
});
