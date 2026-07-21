import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, resolveTarget } from '../../src/homeJqTransforms';

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

describe('resolveTarget', () => {
  const home = '/home/me';
  it('expands a leading ~', () => {
    expect(resolveTarget('~/.claude.json', {}, home)).toBe('/home/me/.claude.json');
    expect(resolveTarget('~', {}, home)).toBe('/home/me');
  });
  it('expands %NAME% from env', () => {
    expect(
      resolveTarget('%APPDATA%/Code/User/settings.json', { APPDATA: 'C:/AppData' }, home),
    ).toBe('C:/AppData/Code/User/settings.json');
  });
  it('throws on an unset variable', () => {
    expect(() => resolveTarget('%APPDATA%/x', {}, home)).toThrow('is not set');
  });
  it('rejects a ~name form', () => {
    expect(() => resolveTarget('~other/x', {}, home)).toThrow('only ~ / ~/');
  });
  it('leaves an absolute path unchanged', () => {
    expect(resolveTarget('/tmp/out.json', {}, home)).toBe('/tmp/out.json');
  });
});
