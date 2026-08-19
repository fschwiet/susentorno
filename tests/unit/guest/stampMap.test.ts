import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearStampMap,
  computeStampMap,
  diffStampMaps,
  readStampMap,
  stampAgeDays,
  STAMP_BUILT_AT_KEY,
  writeStampMap,
} from '../../guest/hyperv/stampMap';

const base = { answerFile: 'answer', provisioning: 'script', isoSha256: 'abc', version: 1 };

describe('computeStampMap', () => {
  it('hashes each input independently and stably', () => {
    const map = computeStampMap(base);
    expect(Object.keys(map).sort()).toEqual(['answerFile', 'isoSha256', 'provisioning', 'version']);
    for (const value of Object.values(map)) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStampMap({ ...base })).toEqual(map);
  });

  it('cannot shift data across a field boundary', () => {
    expect(computeStampMap({ a: 'ab', b: 'c' })).not.toEqual(computeStampMap({ a: 'a', b: 'bc' }));
  });
});

describe('diffStampMaps', () => {
  it('names every changed, added, and removed input', () => {
    const previous = computeStampMap(base);
    expect(diffStampMaps(previous, computeStampMap(base))).toEqual([]);
    expect(diffStampMaps(previous, computeStampMap({ ...base, answerFile: 'other' }))).toEqual([
      'answerFile',
    ]);
    expect(
      diffStampMaps(previous, computeStampMap({ ...base, isoSha256: 'z', version: 2 })).sort(),
    ).toEqual(['isoSha256', 'version']);
  });

  it('reports everything as changed when there is no previous stamp', () => {
    expect(diffStampMaps(null, computeStampMap(base)).sort()).toEqual([
      'answerFile',
      'isoSha256',
      'provisioning',
      'version',
    ]);
  });

  it('ignores the build timestamp, which is metadata rather than an input', () => {
    const previous = { ...computeStampMap(base), [STAMP_BUILT_AT_KEY]: '2026-01-01T00:00:00.000Z' };
    const next = { ...computeStampMap(base), [STAMP_BUILT_AT_KEY]: '2026-06-01T00:00:00.000Z' };
    expect(diffStampMaps(previous, next)).toEqual([]);
  });
});

describe('stampAgeDays', () => {
  it('measures age from the recorded build timestamp', () => {
    const map = { [STAMP_BUILT_AT_KEY]: '2026-01-01T00:00:00.000Z' };
    expect(stampAgeDays(map, new Date('2026-01-31T00:00:00.000Z'))).toBe(30);
    expect(stampAgeDays({}, new Date())).toBeNull();
  });
});

describe('stamp persistence', () => {
  it('round-trips and clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-map-'));
    try {
      const path = join(dir, 'x.stamp');
      expect(readStampMap(path)).toBeNull();
      const map = computeStampMap(base);
      writeStampMap(path, map);
      expect(readStampMap(path)).toEqual(map);
      clearStampMap(path);
      expect(readStampMap(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt stamp as absent rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-map-'));
    try {
      const path = join(dir, 'x.stamp');
      writeStampMap(path, computeStampMap(base));
      rmSync(path, { force: true });
      expect(readStampMap(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
