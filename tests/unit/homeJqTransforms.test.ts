import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest,
  resolveTarget,
  applyTransforms,
  previewTransforms,
  type JqRunner,
} from '../../src/homeJqTransforms';

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

// A stub runner: applies a fixed transformation regardless of program, so tests
// need no real jq. Keyed off the transform file's basename.
function stubRunner(
  map: Record<string, (input: string) => { code: number; stdout: string; stderr: string }>,
): JqRunner {
  return (transformPath, input) => {
    const name = transformPath.split(/[\\/]/).pop()!;
    return map[name]?.(input) ?? { code: 3, stdout: '', stderr: `no stub for ${name}` };
  };
}

describe('applyTransforms', () => {
  it('seeds {} for a missing target and writes the jq output atomically', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(
      join(dir, 'manifest.yaml'),
      `- transform: a.jq\n  linux: ${join(dir, 'out.json')}\n`,
    );
    const runJq = stubRunner({
      'a.jq': (input) => ({ code: 0, stdout: `{"seeded":${input === '{}'}}`, stderr: '' }),
    });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].ok).toBe(true);
    expect(results[0].created).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual({ seeded: true });
  });

  it('treats an unparsable existing target as {}', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(out, '{not json');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({ 'a.jq': (input) => ({ code: 0, stdout: input, stderr: '' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].created).toBe(false);
    expect(readFileSync(out, 'utf8')).toBe('{}');
  });

  it('leaves a valid-but-wrong-shape target intact when jq fails', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(out, '[1,2,3]');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({
      'a.jq': () => ({ code: 5, stdout: '', stderr: 'Cannot index array with string' }),
    });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('Cannot index array');
    expect(readFileSync(out, 'utf8')).toBe('[1,2,3]'); // untouched
  });

  it('skips an entry with no target for the platform', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(
      join(dir, 'manifest.yaml'),
      `- transform: a.jq\n  windows: ${join(dir, 'w.json')}\n`,
    );
    const runJq = stubRunner({ 'a.jq': (input) => ({ code: 0, stdout: input, stderr: '' }) });
    const results = applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(results).toEqual([]);
    expect(existsSync(join(dir, 'w.json'))).toBe(false);
  });

  it('applies two entries targeting the same file in manifest order', () => {
    writeFileSync(join(dir, 'one.jq'), '.');
    writeFileSync(join(dir, 'two.jq'), '.');
    const out = join(dir, 'out.json');
    writeFileSync(
      join(dir, 'manifest.yaml'),
      `- transform: one.jq\n  linux: ${out}\n- transform: two.jq\n  linux: ${out}\n`,
    );
    const runJq = stubRunner({
      'one.jq': () => ({ code: 0, stdout: '{"step":1}', stderr: '' }),
      'two.jq': (input) => ({
        code: 0,
        stdout: `{"prev":${JSON.parse(input).step},"step":2}`,
        stderr: '',
      }),
    });
    applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ prev: 1, step: 2 });
  });

  it('creates parent directories for the target', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    const out = join(dir, 'nested', 'deep', 'out.json');
    writeFileSync(join(dir, 'manifest.yaml'), `- transform: a.jq\n  linux: ${out}\n`);
    const runJq = stubRunner({ 'a.jq': () => ({ code: 0, stdout: '{"ok":true}', stderr: '' }) });
    applyTransforms({ dir, platform: 'linux', env: {}, home: '/home/me', runJq });
    expect(existsSync(out)).toBe(true);
  });
});

describe('previewTransforms', () => {
  it('returns output and targets for a passing transform', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(
      join(dir, 'manifest.yaml'),
      '- transform: a.jq\n  linux: ~/a.json\n  windows: "%APPDATA%/a.json"\n',
    );
    const runJq = stubRunner({ 'a.jq': () => ({ code: 0, stdout: '{"x":1}\n', stderr: '' }) });
    const [p] = previewTransforms({ dir, runJq });
    expect(p).toEqual({
      transform: 'a.jq',
      linuxTarget: '~/a.json',
      windowsTarget: '%APPDATA%/a.json',
      output: '{"x":1}',
    });
  });

  it('captures a jq error', () => {
    writeFileSync(join(dir, 'a.jq'), '.');
    writeFileSync(join(dir, 'manifest.yaml'), '- transform: a.jq\n  linux: ~/a.json\n');
    const runJq = stubRunner({ 'a.jq': () => ({ code: 2, stdout: '', stderr: 'syntax error' }) });
    const [p] = previewTransforms({ dir, runJq });
    expect(p.error).toContain('syntax error');
    expect(p.output).toBeUndefined();
  });
});
