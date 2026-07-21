import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../src/homeJqTransforms';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hjt-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string) {
  writeFileSync(join(dir, name), content);
}

describe('loadManifest', () => {
  it('parses a valid manifest', () => {
    write('a.jq', '.');
    write('manifest.yaml', '- transform: a.jq\n  linux: ~/a.json\n  windows: "%APPDATA%/a.json"\n');
    expect(loadManifest(dir)).toEqual([
      { transform: 'a.jq', linux: '~/a.json', windows: '%APPDATA%/a.json' },
    ]);
  });

  it('rejects a non-list manifest', () => {
    write('manifest.yaml', 'transform: a.jq\n');
    expect(() => loadManifest(dir)).toThrow('top-level list');
  });

  it('rejects invalid YAML', () => {
    write('manifest.yaml', ': : :\n');
    expect(() => loadManifest(dir)).toThrow('not valid YAML');
  });

  it('rejects an entry with no platform target', () => {
    write('a.jq', '.');
    write('manifest.yaml', '- transform: a.jq\n');
    expect(() => loadManifest(dir)).toThrow("at least one of 'linux'/'windows'");
  });

  it('rejects a missing transform file', () => {
    write('manifest.yaml', '- transform: nope.jq\n  linux: ~/a.json\n');
    expect(() => loadManifest(dir)).toThrow('not found');
  });
});
