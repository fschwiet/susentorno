import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

const HTTPS_PORT = 18443;
const HTTP_PORT = 18080;
const ADMIN_PORT = 19901;
const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
const REAL_AUTH = 'Bearer sandbox-test-real-token-12345';

let mockUpstream: MockUpstream;
let caCertPem: string;

async function waitForAdminReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: ADMIN_PORT, path: '/ready', timeout: 1000 },
          (res) =>
            res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`)),
        );
        req.on('error', reject);
        req.end();
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Envoy admin endpoint never became ready');
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');

  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );

  mkdirSync(join(proxyDir, 'secrets'), { recursive: true });
  writeFileSync(
    join(proxyDir, 'secrets', 'sds-secret.yaml'),
    [
      'resources:',
      '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
      '    name: sandbox_bearer_token',
      '    generic_secret:',
      '      secret:',
      `        inline_string: "${REAL_AUTH}"`,
      '',
    ].join('\n'),
  );

  await execa('docker', ['compose', 'up', '-d'], {
    cwd: proxyDir,
    env: {
      ...process.env,
      ENVOY_HTTPS_PORT: String(HTTPS_PORT),
      ENVOY_HTTP_PORT: String(HTTP_PORT),
      ENVOY_ADMIN_PORT: String(ADMIN_PORT),
    },
  });

  await waitForAdminReady(30000);
}, 90000);

afterAll(async () => {
  await execa('docker', ['compose', 'down'], { cwd: proxyDir });
  await stopMockUpstream(mockUpstream);
}, 30000);

function requestThroughTerminate(
  authorization: string | undefined,
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: caCertPem,
        path: '/',
        headers: authorization ? { authorization } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Envoy sandbox proxy stack', () => {
  it('injects the real credential when the placeholder Authorization header is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughTerminate(PLACEHOLDER_AUTH);

    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });

  it('rejects a non-placeholder Authorization header before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughTerminate('Bearer something-else');

    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });

  it('allows a real, allow-listed passthrough TLS host', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: HTTPS_PORT,
          servername: 'pypi.org',
          path: '/simple/',
          headers: { host: 'pypi.org' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBeLessThan(400);
  });

  it('closes the connection for a non-allow-listed SNI', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'not-allow-listed.example.com' },
          () => {
            socket.end();
            reject(
              new Error('expected the connection to be closed, but the TLS handshake succeeded'),
            );
          },
        );
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a real, allow-listed Host header on port 80', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: HTTP_PORT, path: '/', headers: { host: 'archive.ubuntu.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBeLessThan(400);
  });

  it('returns 403 for a non-allow-listed Host header on port 80', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: HTTP_PORT,
          path: '/',
          headers: { host: 'not-allow-listed.example.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(statusCode).toBe(403);
  });
});

describe('Envoy access logging', () => {
  async function readEnvoyLogs(): Promise<string> {
    const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy'], {
      cwd: proxyDir,
      env: {
        ...process.env,
        ENVOY_HTTPS_PORT: String(HTTPS_PORT),
        ENVOY_HTTP_PORT: String(HTTP_PORT),
        ENVOY_ADMIN_PORT: String(ADMIN_PORT),
      },
    });
    return stdout;
  }

  it('emits a CFGM line for terminate, passthrough, port-80, and blocked SNI', async () => {
    // terminate (ALLOW CRED)
    await requestThroughTerminate(PLACEHOLDER_AUTH);

    // passthrough (ALLOW PASS)
    // pypi.org's response never fires Node's 'end' event on its own (no close-delimited
    // body completion within a reasonable window), so force the socket closed once we
    // have a response — that's what flushes the tcp_proxy access log.
    await new Promise<void>((resolve) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: HTTPS_PORT,
          servername: 'pypi.org',
          path: '/simple/',
          headers: { host: 'pypi.org' },
        },
        (res) => {
          res.resume();
          req.destroy();
          resolve();
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // port-80 allowed (ALLOW HTTP)
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: HTTP_PORT, path: '/', headers: { host: 'archive.ubuntu.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // blocked SNI (BLOCK TLS)
    await new Promise<void>((resolve) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked.example.com' },
        () => socket.end(),
      );
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });

    const markers = ['CFGM|term|', 'CFGM|pass|', 'CFGM|http|', 'CFGM|deny443|'];
    const deadline = Date.now() + 10000;
    let logs = '';
    // Access logs flush on connection close; poll until all markers are present.
    while (Date.now() < deadline) {
      logs = await readEnvoyLogs();
      if (markers.every((m) => logs.includes(m))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const marker of markers) {
      expect(logs).toContain(marker);
    }
    expect(logs).toContain('CFGM|deny443|2026'.slice(0, 12)); // deny443 line present
    expect(logs).toMatch(/CFGM\|deny443\|[^|]*\|blocked\.example\.com\|/);
  });
});
