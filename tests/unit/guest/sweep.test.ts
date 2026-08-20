import { describe, expect, it } from 'vitest';
import { isSweepableChildVhd } from '../../guest/hyperv/sweep';

describe('isSweepableChildVhd', () => {
  it("sweeps only this isolation's disposable VHDXs", () => {
    for (const name of [
      'susentorno-test-phases.vhdx',
      'susentorno-test-e2e.vhdx',
      'susentorno-test-fresh.vhdx',
      'susentorno-test-windowsFresh.vhdx',
      'susentorno-test-golden-installer.vhdx',
      'susentorno-test-golden-seed.vhdx',
    ])
      expect(isSweepableChildVhd(name), name).toBe(true);
    for (const name of [
      'susentorno-test-golden.vhdx',
      'susentorno-test-windows-golden.vhdx',
      'ubuntu-26.04-live-server-amd64.iso',
      'susentorno-test-golden.vhdx.stamp',
      'golden-build-serial.log',
      'harness_ed25519',
      'susentorno-other-e2e.vhdx',
      'my-vm.vhdx',
    ])
      expect(isSweepableChildVhd(name), name).toBe(false);
  });
});
