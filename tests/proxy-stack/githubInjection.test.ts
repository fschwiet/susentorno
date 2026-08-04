import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runHosting/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { formatGithubBasicSecret, formatGithubApiTokenSecret } from '../../src/githubSecret';
import { GITHUB_PLACEHOLDER_PAT } from '../../src/githubPlaceholder';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { buildJwt } from '../../src/jwt';
import { envParent, envRoot } from '../testEnvRoot';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other proxy-stack suites' ports.
const HTTPS_PORT = 18447;
const HTTP_PORT = 18184;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

// The real credential the proxy injects (written straight into the secret files).
const REAL_TOKEN = 'github_pat_' + 'R'.repeat(82);
const REAL_USER = 'proxied-user';
const REAL_BASIC = 'Basic ' + Buffer.from(`${REAL_USER}:${REAL_TOKEN}`).toString('base64');
const REAL_API_AUTH = `token ${REAL_TOKEN}`;

const basicOf = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let codexCredentialsPath: string;
let caCertPem: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

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

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for '${needle}'\n--- output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(
  servername: string,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path: '/', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'github-inj-'));
  credentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeCredentials('token-github-int');
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

  // Stage an auth list with both github hosts so generate-ca puts them in the leaf SANs.
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(
    join(proxyDir, 'auth-list.txt'),
    ['#pragma github authenticated', 'github.com:443', 'api.github.com:443', ''].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // The proxy's watched secrets dir must hold both github secrets before Envoy starts,
  // since each chain's SDS subscription watches its own single-resource file.
  mkdirSync(join(proxyDir, 'secrets'), { recursive: true });
  writeFileSync(
    join(proxyDir, 'secrets', 'github-basic-secret.yaml'),
    formatGithubBasicSecret(REAL_USER, REAL_TOKEN),
  );
  writeFileSync(
    join(proxyDir, 'secrets', 'github-api-token-secret.yaml'),
    formatGithubApiTokenSecret(REAL_TOKEN),
  );

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
      `github.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `api.github.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 120000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore kill/non-zero
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('github.com Basic injection', () => {
  describe('placeholder replacement', () => {
    it('injects the real Basic credential when the placeholder token is presented (any username)', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough(
        'github.com',
        basicOf('whoever', GITHUB_PLACEHOLDER_PAT),
      );
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_BASIC]);
    });

    it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough(
        'github.com',
        basicOf('whoever', GITHUB_PLACEHOLDER_PAT),
        { 'x-susentorno-no-auth': '1' },
      );
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_BASIC]);
    });
  });

  describe('credential pass-through', () => {
    it('passes a Basic credential whose token half is not the placeholder through unmodified', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const sent = basicOf('whoever', 'some-other-token');
      const { statusCode } = await requestThrough('github.com', sent);
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([sent]);
    });

    it('strips a client-forged no-auth marker header instead of trusting it', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const sent = basicOf('whoever', 'some-other-token');
      const { statusCode } = await requestThrough('github.com', sent, {
        'x-susentorno-no-auth': '1',
      });
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe(sent);
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });
  });

  describe('missing authentication', () => {
    it('passes a request through with no Authorization header when the client sent none', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough('github.com');
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBeUndefined();
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });
  });

  describe('scheme handling', () => {
    it('passes a non-Basic Authorization on github.com through unmodified', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough('github.com', 'Bearer not-basic-at-all');
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
        'Bearer not-basic-at-all',
      ]);
    });

    it('passes a malformed-base64 Basic credential through unmodified without crashing', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough('github.com', 'Basic not-valid-base64!!!');
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
        'Basic not-valid-base64!!!',
      ]);
    });

    it('passes a lowercase "bearer" scheme through unmodified (only exact "Basic " is decoded)', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const sent = `bearer ${GITHUB_PLACEHOLDER_PAT}`;
      const { statusCode } = await requestThrough('github.com', sent);
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([sent]);
    });
  });
});

describe('api.github.com token/Bearer injection', () => {
  describe('placeholder replacement', () => {
    it('injects the real token when the placeholder token scheme is presented', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough(
        'api.github.com',
        `token ${GITHUB_PLACEHOLDER_PAT}`,
      );
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
    });

    it('injects the real token when the placeholder Bearer scheme is presented', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough(
        'api.github.com',
        `Bearer ${GITHUB_PLACEHOLDER_PAT}`,
      );
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
    });

    it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough(
        'api.github.com',
        `token ${GITHUB_PLACEHOLDER_PAT}`,
        { 'x-susentorno-no-auth': '1' },
      );
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
    });
  });

  describe('credential pass-through', () => {
    it('passes a non-placeholder credential through to the upstream unmodified', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token');
      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
        'Bearer wrong-token',
      ]);
    });

    it('strips a client-forged no-auth marker header on a non-matching credential instead of trusting it', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token', {
        'x-susentorno-no-auth': '1',
      });
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe('Bearer wrong-token');
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });
  });

  describe('missing authentication', () => {
    it('passes a request through with no Authorization header when the client sent none', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough('api.github.com');
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBeUndefined();
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });
  });
});
