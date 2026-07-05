import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { gitBashPath } from './gitBash';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));

const HTTPS_PORT = 18543;
const HTTP_PORT = 18180;
const ADMIN_PORT = 19902;

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let proxyProc: ResultPromise | null = null;

const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
  ENVOY_ADMIN_PORT: String(ADMIN_PORT),
};

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

function adminConfigDump(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: ADMIN_PORT, path: '/config_dump', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Return the `last_updated` timestamp for the sandbox_bearer_token secret, or null. */
function secretLastUpdated(dump: string): string | null {
  const parsed = JSON.parse(dump) as {
    configs?: Array<{ dynamic_active_secrets?: Array<{ name: string; last_updated?: string }> }>;
  };
  for (const config of parsed.configs ?? []) {
    for (const secret of config.dynamic_active_secrets ?? []) {
      if (secret.name === 'sandbox_bearer_token') return secret.last_updated ?? null;
    }
  }
  return null;
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('waitFor timed out');
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-int-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-initial');

  await execa(gitBashPath(), ['scripts/generate-ca.sh'], { cwd: repoRoot });
  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '-o',
      `${repoRoot}/envoy/envoy.yaml`,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );
  mkdirSync(`${repoRoot}/envoy/secrets`, { recursive: true });

  // Start run-proxy in the background with refresh disabled (no real auth/network).
  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--credentials',
      credentialsPath,
      '--secret',
      'envoy/secrets/sds-secret.yaml',
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );

  // run-proxy performs the startup writeSecret + force-recreate; wait for admin readiness.
  await waitFor(
    () => adminConfigDump(),
    (dump) => secretLastUpdated(dump) !== null,
    60000,
  );
}, 90000);

afterAll(async () => {
  proxyProc?.kill('SIGINT');
  try {
    await proxyProc;
  } catch {
    // ignore non-zero/kill result
  }
  await execa('docker', ['compose', 'down'], {
    cwd: repoRoot,
    env: { ...process.env, ...envoyEnv },
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('run-proxy propagates credential changes to the running proxy', () => {
  it('recreates Envoy so the secret last_updated advances when the token changes', async () => {
    const before = secretLastUpdated(await adminConfigDump());
    expect(before).not.toBeNull();

    writeCredentials('token-rotated');

    const after = await waitFor(
      () => adminConfigDump(),
      (dump) => {
        const now = secretLastUpdated(dump);
        return now !== null && now !== before;
      },
      60000,
    );

    expect(secretLastUpdated(after)).not.toBe(before);
    expect(readFileSync(`${repoRoot}/envoy/secrets/sds-secret.yaml`, 'utf8')).toContain(
      'Bearer token-rotated',
    );
  }, 90000);
});
