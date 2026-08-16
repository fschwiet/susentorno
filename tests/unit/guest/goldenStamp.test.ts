import { describe, expect, it } from 'vitest';
import { computeGoldenStamp, type GoldenStampInputs } from '../../guest/hyperv/goldenStamp';

const base: GoldenStampInputs = {
  userData: 'user',
  metaData: 'meta',
  grubCfg: 'grub',
  isoUrl: 'https://example.test/iso',
  harnessPublicKey: 'harness',
  guestHostPublicKey: 'host',
  buildAlgorithmVersion: 1,
};
describe('computeGoldenStamp', () => {
  it('is stable lowercase SHA-256 for identical inputs', () => {
    expect(computeGoldenStamp(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeGoldenStamp(base)).toBe(computeGoldenStamp({ ...base }));
  });
  it('moves for every build input and cannot shift data over a field boundary', () => {
    const stamp = computeGoldenStamp(base);
    for (const input of [
      { ...base, userData: 'other' },
      { ...base, metaData: 'other' },
      { ...base, grubCfg: 'other' },
      { ...base, isoUrl: 'other' },
      { ...base, harnessPublicKey: 'other' },
      { ...base, guestHostPublicKey: 'other' },
      { ...base, buildAlgorithmVersion: 2 },
    ])
      expect(computeGoldenStamp(input)).not.toBe(stamp);
    expect(computeGoldenStamp({ ...base, userData: 'ab', metaData: 'c' })).not.toBe(
      computeGoldenStamp({ ...base, userData: 'a', metaData: 'bc' }),
    );
  });
});
