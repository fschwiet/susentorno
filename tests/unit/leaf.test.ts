import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeaf } from '../../src/leaf';
import { generateRootCa, certSans, isSignedBy } from '../../src/ca';
import { envPaths, type EnvPaths } from '../../src/envPaths';

let dir: string;
let paths: EnvPaths;
let caCertPem: string;
let caKeyPem: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'leaf-test-'));
  paths = envPaths(dir);
  mkdirSync(paths.caDir, { recursive: true });
  const root = generateRootCa();
  caCertPem = root.caCertPem;
  caKeyPem = root.caKeyPem;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureLeaf', () => {
  it('skips when there are no terminate hosts', () => {
    expect(ensureLeaf(paths, caCertPem, caKeyPem, [])).toContain('skipped leaf');
  });

  it('issues a leaf signed by the root with the requested SANs', () => {
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['api.anthropic.com']);
    expect(status).toContain('issued leaf for 1 host(s)');
    const leafPem = readFileSync(paths.caLeafCert, 'utf8');
    expect(isSignedBy(leafPem, caCertPem)).toBe(true);
    expect(certSans(leafPem)).toEqual(['api.anthropic.com']);
  });

  it('reuses a valid leaf when the SAN set is unchanged (order-insensitive)', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'b.example.com']);
    const before = readFileSync(paths.caLeafCert, 'utf8');
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['b.example.com', 'a.example.com']);
    expect(status).toContain('reused leaf for 2 host(s)');
    expect(readFileSync(paths.caLeafCert, 'utf8')).toBe(before);
  });

  it('reissues when the SAN set changes', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com']);
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'new.example.com']);
    expect(status).toContain('issued leaf for 2 host(s)');
    expect(certSans(readFileSync(paths.caLeafCert, 'utf8')).sort()).toEqual([
      'a.example.com',
      'new.example.com',
    ]);
  });
});
