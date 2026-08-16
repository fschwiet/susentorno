import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { ensureHarnessKeys } from '../guest/harnessKeys';
import { ensureGoldenImage } from '../guest/hyperv/goldenImage';
import { goldenVhdPath } from '../guest/hyperv/imageCache';
describe('golden image build', () => {
  it('builds an Ubuntu golden VHDX', async () => {
    expect(await ensureGoldenImage(createRealPowerShellExec(), await ensureHarnessKeys())).toBe(
      goldenVhdPath,
    );
    expect(existsSync(goldenVhdPath)).toBe(true);
  }, 3_600_000);
  it('uses the cached golden image on a second call', async () => {
    const started = Date.now();
    await ensureGoldenImage(createRealPowerShellExec(), await ensureHarnessKeys());
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
