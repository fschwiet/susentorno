import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { MockUpstream } from './mockUpstream';
import {
  startProxyStack,
  stopProxyStack,
  HTTPS_PORT,
  HTTP_PORT,
  PLACEHOLDER_AUTH,
  REAL_AUTH,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;
let mockUpstream: MockUpstream;
let caCertPem: string;

beforeAll(async () => {
  stack = await startProxyStack();
  mockUpstream = stack.mockUpstream;
  caCertPem = stack.caCertPem;
}, 90000);

afterAll(async () => {
  await stopProxyStack(stack);
}, 30000);

function requestThroughClaudeHost(
  authorization: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: caCertPem,
        path: '/',
        headers: { ...(authorization ? { authorization } : {}), ...extraHeaders },
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

function requestThroughAuthCandidate(authorization: string): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'auth-candidate.test',
        ca: caCertPem,
        path: '/',
        headers: { authorization },
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

describe('proxy stack policy enforcement', () => {
  describe('passthrough routing', () => {
    it('allows a real, allow-listed passthrough TLS host', async () => {
      const statusCode = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpsRequest(
          {
            // HEAD, not GET: pypi.org/simple/ is a ~44 MB index whose full download
            // can exceed the test timeout. A HEAD proves the passthrough TLS
            // handshake to the real pypi.org succeeds and returns a non-error status
            // without transferring the body. Mirrors tests/guest/guest.test.ts.
            method: 'HEAD',
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
  });

  describe('leaf certificate & CA chain', () => {
    it('presents a leaf that chains to the CA, not a self-signed CA cert', async () => {
      const peer = await new Promise<{ subjectCN?: string; issuerCN?: string }>(
        (resolve, reject) => {
          const socket = tlsConnect(
            { host: '127.0.0.1', port: HTTPS_PORT, servername: 'api.anthropic.com', ca: caCertPem },
            () => {
              const cert = socket.getPeerCertificate();
              socket.end();
              const cn = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
              resolve({ subjectCN: cn(cert.subject?.CN), issuerCN: cn(cert.issuer?.CN) });
            },
          );
          socket.on('error', reject);
        },
      );

      // Handshake succeeded with `ca: caCertPem` (rejectUnauthorized defaults true), so the leaf
      // already chained to the installed root. Confirm it is a distinct leaf, not the CA itself.
      expect(peer.subjectCN).toBe('susentorno-proxy-leaf');
      expect(peer.issuerCN).toBe('susentorno-proxy-certificate-authority');
      expect(peer.subjectCN).not.toBe(peer.issuerCN);
    });
  });

  describe('dropped non-allow-listed SNI', () => {
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
  });

  describe('port-80 host', () => {
    it('allows a real, allow-listed Host header on port 80', async () => {
      const statusCode = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: HTTP_PORT,
            path: '/',
            headers: { host: 'archive.ubuntu.com' },
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

    it('allows a wildcard-covered Host header on port 80 that was never explicitly listed', async () => {
      const statusCode = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: HTTP_PORT,
            path: '/',
            headers: { host: 'connectivity-check.ubuntu.com' },
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
});

describe('proxy stack credential injection', () => {
  describe('claude credential channel', () => {
    it('injects the real credential when the placeholder Authorization header is presented, with no marker leak', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThroughClaudeHost(PLACEHOLDER_AUTH);

      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe(REAL_AUTH);
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });

    it('passes a non-placeholder Authorization header through to the upstream unmodified, with no marker leak or unrelated-header changes', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThroughClaudeHost('Bearer something-else', {
        'x-test-probe': 'keep-me',
      });

      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe('Bearer something-else');
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
      expect(received[0]['x-test-probe']).toBe('keep-me');
    });

    it('passes a request through with no Authorization header when the client sent none', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThroughClaudeHost(undefined);

      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received).toHaveLength(1);
      expect(received[0].authorization).toBeUndefined();
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });

    it('strips a client-forged no-auth marker header instead of trusting it', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThroughClaudeHost('Bearer something-else', {
        'x-susentorno-no-auth': '1',
      });

      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      // The forged marker must not cause the post-filter to strip this credential.
      expect(received[0].authorization).toBe('Bearer something-else');
      expect(received[0]['x-susentorno-no-auth']).toBeUndefined();
    });

    it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const { statusCode } = await requestThroughClaudeHost(PLACEHOLDER_AUTH, {
        'x-susentorno-no-auth': '1',
      });

      expect(statusCode).toBe(200);
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
    });
  });

  describe('auth candidate credential channel', () => {
    it('passes a non-placeholder auth header straight through an auth-candidate host (no gate, no injection)', async () => {
      const before = mockUpstream.receivedAuthorizationHeaders.length;
      const original = 'Bearer candidate-original-secret-value';
      const { statusCode } = await requestThroughAuthCandidate(original);

      // No lua gate: a non-placeholder credential is NOT 403'd (contrast the claude host).
      expect(statusCode).toBe(200);
      // No credential_injector: the upstream sees the client's own header, unmodified.
      expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([original]);
    });
  });
});

describe('proxy stack access logging', () => {
  async function readEnvoyLogs(): Promise<string> {
    // The stack never rotates credentials or the allowlist in this suite, so
    // it stays on the color run-hosting always starts with.
    const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy_blue'], {
      cwd: stack.proxyDir,
      env: stack.composeEnv,
    });
    return stdout;
  }

  it('emits a CFGM line for claude, passthrough, port-80, and blocked SNI', async () => {
    // claude (ALLOW CRED)
    await requestThroughClaudeHost(PLACEHOLDER_AUTH);

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

  it('truncates auth-candidate header values to 12 chars in the cand access log', async () => {
    await requestThroughAuthCandidate('Bearer truncation-probe-0123456789');

    // Give Envoy a moment to flush the access log, then read it. An earlier
    // test in this file also hits auth-candidate.test, so match on this
    // request's own truncated prefix rather than the first line for the host.
    let candLine: string | undefined;
    for (let attempt = 0; attempt < 20 && !candLine; attempt++) {
      const logs = await readEnvoyLogs();
      candLine = logs
        .split('\n')
        .find(
          (l) =>
            l.includes('CFGM|cand|') &&
            l.includes('auth-candidate.test') &&
            l.includes('Bearer trunc'),
        );
      if (!candLine) await new Promise((r) => setTimeout(r, 500));
    }
    expect(candLine, 'expected a CFGM|cand| line for auth-candidate.test').toBeDefined();

    const fields = candLine!.slice(candLine!.indexOf('CFGM|')).trim().split('|');
    // Field 6 (0-indexed) is %REQ(AUTHORIZATION):12% — exactly the first 12 chars.
    expect(fields[6]).toBe('Bearer trunc');
  }, 30000);
});
