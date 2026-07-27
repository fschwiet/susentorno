import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials } from '../../src/runProxy/readCredentials';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-proxy-creds-'));
  path = join(dir, '.credentials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('credential reading — claude credential channel', () => {
  it('parses accessToken and expiresAt from claudeAiOauth', () => {
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-xyz', expiresAt: 1_700_000_000_000 },
      }),
    );
    expect(readCredentials(path)).toEqual({
      accessToken: 'sk-ant-oat01-xyz',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('returns null when the file does not exist', () => {
    expect(readCredentials(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on a partial / truncated mid-write read', () => {
    writeFileSync(path, '{"claudeAiOauth": {"accessToken": "sk-ant');
    expect(readCredentials(path)).toBeNull();
  });

  it('returns null when required fields are missing or the wrong type', () => {
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    expect(readCredentials(path)).toBeNull();
  });
});
