import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { isColorRunning } from '../../src/runProxy/isColorRunning';

// Guarantee the containers do not exist, regardless of other proxy-stack tests.
beforeAll(async () => {
  for (const name of ['configamatron-envoy-blue', 'configamatron-envoy-green']) {
    await execa('docker', ['rm', '-f', name], { reject: false });
  }
});

describe('serving-state detection', () => {
  it('returns false when the container does not exist', async () => {
    expect(await isColorRunning('blue', tmpdir())).toBe(false);
    expect(await isColorRunning('green', tmpdir())).toBe(false);
  });
});
