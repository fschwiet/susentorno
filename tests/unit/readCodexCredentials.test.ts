import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexCredentials } from '../../src/runProxy/readCodexCredentials';
import { buildJwt } from '../../src/jwt';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-proxy-codex-creds-'));
  path = join(dir, 'auth.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAuth(tokens: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: null, tokens, auth_mode: 'chatgpt' }));
}

describe('credential reading — codex credential channel (JWT exp)', () => {
  it('returns the access token and its JWT exp (in ms) from tokens', () => {
    const access = buildJwt({ exp: 1_700_000_000 });
    writeAuth({ access_token: access, account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toEqual({
      accessToken: access,
      expiresAt: 1_700_000_000 * 1000,
    });
  });

  it('returns null when the file does not exist', () => {
    expect(readCodexCredentials(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on a partial / truncated mid-write read', () => {
    writeFileSync(path, '{"tokens": {"access_token": "eyJ');
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when tokens.access_token is missing', () => {
    writeAuth({ account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when the access token has no decodable exp', () => {
    writeAuth({ access_token: buildJwt({ sub: 'x' }) });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null for a non-chatgpt (api_key) auth file', () => {
    writeFileSync(
      path,
      JSON.stringify({
        OPENAI_API_KEY: 'sk-real-api-key',
        tokens: { access_token: buildJwt({ exp: 1_700_000_000 }) },
        auth_mode: 'api_key',
      }),
    );
    expect(readCodexCredentials(path)).toBeNull();
  });
});
