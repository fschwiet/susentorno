import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteSharedCodexAuth } from '../../src/runHosting/rewriteSharedCodexAuth';
import { sanitizeCodexCredentials } from '../../src/sanitizeCodexCredentials';

const fixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

let dir: string;
let targets: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewrite-codex-auth-'));
  targets = ['linux', 'windows'].map((name) => {
    mkdirSync(join(dir, name));
    const path = join(dir, name, 'auth.json');
    writeFileSync(path, 'previous contents\n');
    return path;
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rewriteSharedCodexAuth', () => {
  it('writes what init writes to every shared target, leaving no temp file behind', () => {
    rewriteSharedCodexAuth(fixture, targets);
    const expected = sanitizeCodexCredentials(readFileSync(fixture, 'utf8'));
    for (const target of targets) {
      expect(readFileSync(target, 'utf8')).toBe(expected);
      expect(JSON.parse(readFileSync(target, 'utf8')).tokens.account_id).toBe('acct-uuid-1234');
    }
    expect(readdirSync(join(dir, 'linux'))).toEqual(['auth.json']);
    expect(readdirSync(join(dir, 'windows'))).toEqual(['auth.json']);
  });

  it('throws and leaves the shared files untouched when the host file cannot be sanitized', () => {
    const apiKeyMode = join(dir, 'host-auth.json');
    writeFileSync(apiKeyMode, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-real' }));
    expect(() => rewriteSharedCodexAuth(apiKeyMode, targets)).toThrow(/chatgpt-mode/);
    for (const target of targets) expect(readFileSync(target, 'utf8')).toBe('previous contents\n');
  });
});
