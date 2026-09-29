import { describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import {
  GOLDEN_PARENT_VHD_NAMES,
  WINDOWS_ISO_ENV_VAR,
  windowsGoldenVhdPath,
  windowsIsoPath,
  roleVmName,
} from '../../guest/hyperv/imageCache';

describe('windows image cache', () => {
  it('names the windows golden parent distinctly from the ubuntu one', () => {
    expect(basename(windowsGoldenVhdPath)).toBe('susentorno-test-windows-golden.vhdx');
    expect(GOLDEN_PARENT_VHD_NAMES).toContain('susentorno-test-golden.vhdx');
    expect(GOLDEN_PARENT_VHD_NAMES).toContain('susentorno-test-windows-golden.vhdx');
  });

  it('derives the windows role VM name from the isolation prefix', () => {
    expect(roleVmName('windowsE2e')).toBe('susentorno-test-windowsE2e');
  });

  it("reads the ISO path the guest tier's Windows ISO prerequisite validates", () => {
    expect(windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: 'C:\\images\\win.iso' })).toBe(
      'C:\\images\\win.iso',
    );
  });

  it('fails naming the variable when it is unset or blank, since the ISO is required', () => {
    expect(() => windowsIsoPath({})).toThrow(WINDOWS_ISO_ENV_VAR);
    expect(() => windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: '   ' })).toThrow(WINDOWS_ISO_ENV_VAR);
  });
});
