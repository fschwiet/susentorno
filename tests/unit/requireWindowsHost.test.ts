import { describe, expect, it } from 'vitest';
import { requireWindowsHost } from '../requireWindowsHost';

describe('requireWindowsHost', () => {
  it('passes on Windows', () => {
    expect(() => requireWindowsHost('win32')).not.toThrow();
  });

  it.each(['linux', 'darwin'] as const)(
    'fails on %s, saying the tier needs a Windows Hyper-V host',
    (platform) => {
      expect(() => requireWindowsHost(platform)).toThrow(/needs a Windows Hyper-V host/);
      expect(() => requireWindowsHost(platform)).toThrow(platform);
    },
  );
});
