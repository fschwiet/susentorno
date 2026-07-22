import { describe, it, expect } from 'vitest';
import { detectCollisions, type WeaveItem } from '../../src/collisions';

const f = (destPath: string, origin: string): WeaveItem => ({ destPath, kind: 'file', origin });
const d = (destPath: string, origin: string): WeaveItem => ({ destPath, kind: 'dir', origin });

describe('detectCollisions', () => {
  it('passes a clean layout', () => {
    expect(
      detectCollisions(
        [f('01-a.sh', 'builtin'), f('02-b.sh', 'custom'), f('helper.conf', 'builtin')],
        { caseInsensitive: false },
      ),
    ).toEqual([]);
  });

  it('flags two files at the same path and names both sides', () => {
    const c = detectCollisions([f('x.conf', 'builtin x'), f('x.conf', 'custom x')], {
      caseInsensitive: false,
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ destPath: 'x.conf', a: 'builtin x', b: 'custom x' });
    expect(c[0].reason).toMatch(/two files/);
  });

  it('flags a file vs a directory at the same path', () => {
    const c = detectCollisions([f('lib', 'builtin file'), d('lib', 'custom dir')], {
      caseInsensitive: false,
    });
    expect(c).toHaveLength(1);
    expect(c[0].reason).toMatch(/file vs directory/);
  });

  it('flags an ancestor conflict', () => {
    const c = detectCollisions([f('lib', 'builtin file'), f('lib/helper.sh', 'custom nested')], {
      caseInsensitive: false,
    });
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].reason).toMatch(/file vs directory/);
  });

  it('merges two directories at the same path without a collision', () => {
    expect(
      detectCollisions(
        [
          d('lib', 'builtin'),
          f('lib/a.sh', 'builtin'),
          d('lib', 'custom'),
          f('lib/b.sh', 'custom'),
        ],
        { caseInsensitive: false },
      ),
    ).toEqual([]);
  });

  it('still flags colliding contents inside two merged directories', () => {
    const c = detectCollisions(
      [
        d('lib', 'builtin'),
        f('lib/same.sh', 'builtin'),
        d('lib', 'custom'),
        f('lib/same.sh', 'custom'),
      ],
      { caseInsensitive: false },
    );
    expect(c).toHaveLength(1);
    expect(c[0].destPath).toBe('lib/same.sh');
  });

  it('treats a case-only file clash as a collision on Windows but not on Linux', () => {
    const items = [f('Foo.txt', 'builtin'), f('foo.txt', 'custom')];
    expect(detectCollisions(items, { caseInsensitive: false })).toEqual([]);
    expect(detectCollisions(items, { caseInsensitive: true })).toHaveLength(1);
  });

  it('treats a case-only directory clash as a collision on Windows', () => {
    const items = [d('DNS-Responder', 'builtin'), d('dns-responder', 'custom')];
    expect(detectCollisions(items, { caseInsensitive: false })).toEqual([]);
    const c = detectCollisions(items, { caseInsensitive: true });
    expect(c).toHaveLength(1);
    expect(c[0].reason).toMatch(/case-only/);
  });
});
