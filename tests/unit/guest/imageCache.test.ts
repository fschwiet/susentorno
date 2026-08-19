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
    expect(roleVmName('windowsFresh')).toBe('susentorno-test-windowsFresh');
  });

  it('resolves the ISO path from the environment, or null when unset', () => {
    expect(windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: 'C:\\images\\win.iso' })).toBe(
      'C:\\images\\win.iso',
    );
    expect(windowsIsoPath({})).toBeNull();
    expect(windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: '   ' })).toBeNull();
  });
});
