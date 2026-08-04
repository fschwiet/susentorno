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

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowListFixture = fileURLToPath(new URL('./fixtures/allow-list.txt', import.meta.url));
const authListFixture = fileURLToPath(new URL('./fixtures/auth-list.txt', import.meta.url));
const blockListFixture = fileURLToPath(new URL('./fixtures/block-list.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

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

function writeCodexAuthFile(path: string, accessToken: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: accessToken,
        refresh_token: 'itest-codex-refresh',
        account_id: 'acct-itest',
      },
      auth_mode: 'chatgpt',
    }),
  );
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
});
