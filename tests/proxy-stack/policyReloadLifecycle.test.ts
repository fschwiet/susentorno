import { appendFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countProxyLines,
  HTTPS_PORT,
  PLACEHOLDER_AUTH,
  startProxyStack,
  stopProxyStack,
  waitForProxyLine,
  writeStackCredentials,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;

beforeAll(async () => {
  stack = await startProxyStack();
}, 120_000);

afterAll(async () => {
  if (stack) await stopProxyStack(stack);
}, 60_000);

/**
 * HEAD, and the socket forced closed once a response arrives: pypi.org/simple/
 * is a ~44 MB index whose body never completes within a sane window, and it is
 * the connection close that flushes Envoy's tcp_proxy access log — which is the
 * only thing these tests observe.
 */
function passthroughProbe(): Promise<void> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        method: 'HEAD',
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
}

function claudeProbe(): Promise<void> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: stack.caCertPem,
        path: '/',
        headers: { authorization: PLACEHOLDER_AUTH },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end();
  });
}

describe('proxy stack policy reload & log follow', () => {
  it('streams a unique tagged line per host+handling', async () => {
    await passthroughProbe();
    await claudeProbe();
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000);
    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000);
  }, 120_000);

  it('an allowlist edit restarts the proxy, re-attaches the follow, and resets unique tracking', async () => {
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');
    expect(pypiBefore).toBeGreaterThan(0);
    const mark = stack.stdoutLines.length;

    // The staged fixture ends with the '#pragma claude authenticated' section, so
    // appending adds a claude-authenticated host — the TLS-terminated host set
    // changes and the leaf-reissue path runs too, not just the config rebuild.
    appendFileSync(stack.allowListPath, 'example.org:443\n');

    await waitForProxyLine(stack, 'restarting proxy — policy changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);

    await passthroughProbe();

    // The same host+handling prints again only because unique tracking was
    // cleared — and the line only reaches us because the follow re-attached to
    // the freshly recreated container.
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000, mark);
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore + 1);
  }, 300_000);

  it('a credential rotation restarts the proxy and preserves unique tracking', async () => {
    const mark = stack.stdoutLines.length;
    writeStackCredentials(stack, 'rotated-proxy-stack-token');

    await waitForProxyLine(stack, 'restarting proxy — claude credentials changed', 120_000, mark);
    await waitForProxyLine(stack, 'swap complete', 120_000, mark);
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');

    // pypi.org was re-logged after the allowlist restart above, so it is in the
    // preserved unique map: this request must NOT produce a new line.
    await passthroughProbe();
    // api.anthropic.com has NOT been logged since that allowlist reset, so it
    // does print — proving the follow re-attached after this restart too.
    await claudeProbe();

    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000, mark);
    // Envoy logs in request order: the api.anthropic.com line arriving means any
    // pypi line would already be here. It is not: unique was preserved.
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore);
  }, 300_000);
});
