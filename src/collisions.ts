export interface WeaveItem {
  destPath: string;
  kind: 'file' | 'dir';
  origin: string;
}

export interface Collision {
  destPath: string;
  a: string;
  b: string;
  reason: string;
}

interface Node {
  kind: 'file' | 'dir';
  displayPath: string;
  origin: string;
}

export function detectCollisions(
  items: WeaveItem[],
  opts: { caseInsensitive: boolean },
): Collision[] {
  const key = (path: string) => (opts.caseInsensitive ? path.toLowerCase() : path);
  const nodes = new Map<string, Node>();
  const collisions: Collision[] = [];

  for (const item of items) {
    const segments = item.destPath.split('/').filter((segment) => segment.length > 0);
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join('/');
      const existing = nodes.get(key(ancestor));
      if (!existing) {
        nodes.set(key(ancestor), { kind: 'dir', displayPath: ancestor, origin: item.origin });
      } else if (existing.kind === 'file') {
        collisions.push({
          destPath: ancestor,
          a: existing.origin,
          b: item.origin,
          reason: 'file vs directory (ancestor conflict)',
        });
      } else if (existing.displayPath !== ancestor) {
        collisions.push({
          destPath: ancestor,
          a: existing.origin,
          b: item.origin,
          reason: 'case-only directory clash',
        });
      }
    }

    const full = segments.join('/');
    const existing = nodes.get(key(full));
    if (!existing) {
      nodes.set(key(full), { kind: item.kind, displayPath: full, origin: item.origin });
    } else if (existing.kind === 'dir' && item.kind === 'dir') {
      if (existing.displayPath !== full) {
        collisions.push({
          destPath: full,
          a: existing.origin,
          b: item.origin,
          reason: 'case-only directory clash',
        });
      }
    } else if (existing.kind === 'file' && item.kind === 'file') {
      collisions.push({
        destPath: full,
        a: existing.origin,
        b: item.origin,
        reason: 'two files at the same path',
      });
    } else {
      collisions.push({
        destPath: full,
        a: existing.origin,
        b: item.origin,
        reason: 'file vs directory',
      });
    }
  }

  return collisions;
}
