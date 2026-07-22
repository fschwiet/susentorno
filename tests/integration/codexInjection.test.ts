import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { buildJwt } from '../../src/jwt';
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from '../../src/codexPlaceholder';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other integration suites' ports.
const HTTPS_PORT = 18449;
const HTTP_PORT = 18186;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

const REAL_CODEX_TOKEN = buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
const REAL_CODEX_BEARER = `Bearer ${REAL_CODEX_TOKEN}`;

let mockUpstream: MockUpstream;
let tempDir: string;
let codexCredentialsPath: string;
let claudeCredentialsPath: string;
let caCertPem: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

function writeCodexAuth(token: string): void {
  writeFileSync(
    codexCredentialsPath,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: token,
        refresh_token: 'itest-refresh',
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
      throw new Error(`timed out waiting for '${needle}'\n${stdoutLines.join('\n')}`);
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

/** Raw TLS upgrade request; resolves with the first response line (e.g. "HTTP/1.1 101 ..."). */
function upgradeThrough(servername: string, authorization: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem },
      () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            `Authorization: ${authorization}\r\n\r\n`,
        );
      },
    );
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n')) {
        resolve(buf.split('\r\n')[0]);
        socket.end();
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => reject(new Error('upgrade timed out')));
  });
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'codex-inj-'));
  claudeCredentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeFileSync(
    claudeCredentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'claude-int', expiresAt: Date.now() + 86400000 },
    }),
  );
  writeCodexAuth(REAL_CODEX_TOKEN);

  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: repoRoot },
  );

  writeFileSync(
    join(proxyDir, 'allowlist.txt'),
    [
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
      '#pragma codex authenticated',
      'chatgpt.com:443',
      '',
    ].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      claudeCredentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `chatgpt.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }
  await waitForLine('serving the current token', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 120000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) await killProcessTree(proxyProc.pid, 'SIGINT');
  try {
    await proxyProc;
  } catch {
    /* ignore */
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('chatgpt.com codex Bearer injection', () => {
  it('injects the real token when the placeholder Bearer is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'chatgpt.com',
      `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_CODEX_BEARER]);
  });

  it('passes a leaked real Bearer that is not the placeholder through unmodified', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
      'Bearer some-other-real-token',
    ]);
  });

  it('passes a request through with no Authorization header when the client sent none', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com');
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('strips a client-forged no-auth marker header instead of trusting it', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token', {
      'x-configamatron-no-auth': '1',
    });
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe('Bearer some-other-real-token');
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'chatgpt.com',
      `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
      { 'x-configamatron-no-auth': '1' },
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_CODEX_BEARER]);
  });

  it('still injects on the claude chain (both channels live)', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'api.anthropic.com',
      'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER',
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual(['Bearer claude-int']);
  });

  it('proxies a WebSocket upgrade to the upstream with the injected token (no 403 fallback)', async () => {
    const before = mockUpstream.receivedUpgradeAuthorizationHeaders.length;
    const statusLine = await upgradeThrough(
      'chatgpt.com',
      `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
    );
    expect(statusLine).toContain('101');
    expect(mockUpstream.receivedUpgradeAuthorizationHeaders.slice(before)).toEqual([
      REAL_CODEX_BEARER,
    ]);
  });
});
