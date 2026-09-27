import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { killProcessTree } from '../../src/runHosting/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { envParent, envRoot } from '../testEnvRoot';
import { buildJwt } from '../../src/jwt';
import { envPaths } from '../../src/envPaths';
import { sanitizeCodexCredentials } from '../../src/sanitizeCodexCredentials';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
} from '../../src/codexPlaceholder';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowListFixture = fileURLToPath(new URL('./fixtures/allow-list.txt', import.meta.url));
const authListFixture = fileURLToPath(new URL('./fixtures/auth-list.txt', import.meta.url));
const blockListFixture = fileURLToPath(new URL('./fixtures/block-list.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

const sharedAuthJsonPaths = envPaths(envParent).vmSharedTargets.map((t) => t.authJson);

const HTTPS_PORT = 18543;
const HTTP_PORT = 18180;

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let codexCredentialsPath: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
};

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

function writeCodexAuthFile(path: string, accessToken: string, accountId = 'acct-itest'): void {
  writeFileSync(
    path,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: accessToken,
        refresh_token: 'itest-codex-refresh',
        account_id: accountId,
      },
      auth_mode: 'chatgpt',
    }),
  );
}

/** Poll until every shared auth.json carries `accountId`, or fail with their contents. */
async function waitForSharedAccountId(accountId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ids = sharedAuthJsonPaths.map((p) => {
      try {
        return (JSON.parse(readFileSync(p, 'utf8')) as { tokens: { account_id: string } }).tokens
          .account_id;
      } catch {
        return undefined; // mid-write or unreadable: keep polling
      }
    });
    if (ids.every((id) => id === accountId)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for shared auth.json account id '${accountId}' (saw ${JSON.stringify(ids)})\n` +
          `--- run-hosting output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Both shared copies must be exactly what `init` would write for the host's auth.json. */
function expectSharedAuthJsonMatchesHost(accountId: string): void {
  const expected = sanitizeCodexCredentials(readFileSync(codexCredentialsPath, 'utf8'));
  for (const p of sharedAuthJsonPaths) {
    const shared = readFileSync(p, 'utf8');
    const tokens = (JSON.parse(shared) as { tokens: Record<string, string> }).tokens;
    expect(tokens.account_id).toBe(accountId);
    expect(tokens.access_token).toBe(CODEX_PLACEHOLDER_ACCESS_TOKEN);
    expect(shared).toBe(expected);
  }
}

async function waitForLine(needle: string, timeoutMs: number, fromIndex = 0): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = fromIndex; i < stdoutLines.length; i++) {
      if (stdoutLines[i].includes(needle)) return i;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-hosting output containing '${needle}'\n` +
          `--- run-hosting output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'run-hosting-int-'));
  credentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeCredentials('token-initial');
  writeCodexAuthFile(
    codexCredentialsPath,
    buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
  );

  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );
  copyFileSync(allowListFixture, join(proxyDir, 'allow-list.txt'));
  copyFileSync(authListFixture, join(proxyDir, 'auth-list.txt'));
  copyFileSync(blockListFixture, join(proxyDir, 'block-list.txt'));
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // Put the shares back in the state an environment created before init kept the real
  // account id was left in: the placeholder id. run-hosting's startup must migrate it.
  for (const p of sharedAuthJsonPaths) {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { tokens: { account_id: string } };
    parsed.tokens.account_id = CODEX_PLACEHOLDER_ACCOUNT_ID;
    writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n');
  }

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token (blue)', 60000);
}, 120000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore non-zero/kill result
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('proxy stack lifecycle & replacement', () => {
  it('swaps blue->green->blue across rotations and serves the new token each time', async () => {
    const mark1 = stdoutLines.length;
    writeCredentials('token-rotated');
    await waitForLine('swap complete — now serving green', 90000, mark1);
    expect(readFileSync(join(proxyDir, 'secrets', 'sds-secret.yaml'), 'utf8')).toContain(
      'Bearer token-rotated',
    );

    const mark2 = stdoutLines.length;
    writeCredentials('token-again');
    await waitForLine('swap complete — now serving blue', 90000, mark2);
    expect(readFileSync(join(proxyDir, 'secrets', 'sds-secret.yaml'), 'utf8')).toContain(
      'Bearer token-again',
    );
  }, 200000);

  it("rewrites both shared auth.json copies with the host's account id at startup", () => {
    expectSharedAuthJsonMatchesHost('acct-itest');
  });

  it("rewrites both shared auth.json copies when the host's account id changes", async () => {
    writeCodexAuthFile(
      codexCredentialsPath,
      buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
      'acct-itest-switched',
    );
    await waitForSharedAccountId('acct-itest-switched', 90000);
    expectSharedAuthJsonMatchesHost('acct-itest-switched');
  }, 120000);
});
