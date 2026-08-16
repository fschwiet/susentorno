import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { request as httpRequest } from 'node:http';
import {
  startProxyStack,
  stopProxyStack,
  HTTPS_PORT,
  HTTP_PORT,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;

beforeAll(async () => {
  stack = await startProxyStack({ extraArgs: ['--skip-allow-list'] });
}, 90000);
afterAll(async () => {
  await stopProxyStack(stack);
}, 30000);

describe('run-hosting --skip-allow-list', () => {
  it('prints the startup banner', () => {
    expect(stack.stdoutLines.some((line) => line.includes('--skip-allow-list is set'))).toBe(true);
  });

  it('allows an unlisted TLS SNI and still blocks a block-listed SNI', async () => {
    await expect(
      new Promise<void>((resolve) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'never-allow-listed.example.com' },
          () => {
            socket.end();
            resolve();
          },
        );
        socket.on('error', () => resolve());
      }),
    ).resolves.toBeUndefined();

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked-by-list.example.com' },
          () => {
            socket.end();
            reject(new Error('blocked handshake succeeded'));
          },
        );
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      }),
    ).resolves.toBeUndefined();
  }, 30000);

  it('does not return 403 for an unlisted HTTP host', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: HTTP_PORT,
          path: '/',
          headers: { host: 'never-allow-listed-http.example.com' },
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('error', reject);
      request.end();
    });
    const deadline = Date.now() + 10000;
    while (
      Date.now() < deadline &&
      !stack.stdoutLines.some((line) =>
        line.includes('ALLOW OPEN  never-allow-listed-http.example.com:80'),
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      stack.stdoutLines.some((line) =>
        line.includes('ALLOW OPEN  never-allow-listed-http.example.com:80'),
      ),
    ).toBe(true);
  }, 30000);

  it('logs ALLOW OPEN for the unlisted TLS host', async () => {
    await new Promise<void>((resolve) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'never-allow-listed.example.com' },
        () => socket.end(),
      );
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !stack.stdoutLines.some((line) => line.includes('ALLOW OPEN')))
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stack.stdoutLines.some((line) => line.includes('ALLOW OPEN'))).toBe(true);
  }, 30000);
});
