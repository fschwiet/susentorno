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
import { buildJwt } from '../../src/jwt';
import { envParent, envRoot } from '../testEnvRoot';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const fakeMcpScript = fileURLToPath(new URL('../fixtures/mcpFakeServer.mjs', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other proxy-stack suites' ports.
const HTTPS_PORT = 18450;
const HTTP_PORT = 18187;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

let tempDir: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];
let caCertPem: string;

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for '${needle}'\n${stdoutLines.join('\n')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(
  servername: string,
  path: string,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mcp-proxy-stack-'));
  // Written BEFORE run-hosting is spawned: run-hosting reads credentials synchronously
  // at startup and fails fast if they're missing, so this must not race the spawn.
  writeFileSync(
    join(tempDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 86400000 } }),
  );
  writeFileSync(
    join(tempDir, 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        refresh_token: 'itest-refresh',
        account_id: 'acct-itest',
      },
      auth_mode: 'chatgpt',
    }),
  );

  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(join(proxyDir, 'auth-list.txt'), '');
  writeFileSync(
    join(envRoot, 'mcp-servers.yaml'),
    [
      'servers:',
      '  - name: faketool',
      '    hostname: faketool.internal',
      `    command: node ${fakeMcpScript} {ip} {port}`,
      '',
    ].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      join(tempDir, '.credentials.json'),
      '--codex-credentials',
      join(tempDir, 'auth.json'),
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }
  await waitForLine('serving the current token', 60000);
  // Confirms the fixture server actually came up and passed its readiness probe —
  // not just that run-hosting itself started.
  await waitForLine('[faketool] ready in', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 120000);

afterAll(async () => {
  // run-hosting's own SIGINT shutdown kills the faketool child it spawned (Task 10);
  // no separate cleanup of that process is needed here.
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
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('host-run MCP server, reached through the proxy on loopback', () => {
  it('reaches the spawned host-loopback server in cleartext via host.docker.internal', async () => {
    const { statusCode, body } = await requestThrough('faketool.internal', '/mcp-tool-call');
    expect(statusCode).toBe(200);
    expect(body).toBe('mcp ok:/mcp-tool-call');
  });

  it('logs the request with the ALLOW MCP tag', async () => {
    const before = stdoutLines.length;
    await requestThrough('faketool.internal', '/another-call');

    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !stdoutLines.slice(before).some((l) => l.includes('ALLOW MCP'))
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      stdoutLines
        .slice(before)
        .some((l) => l.includes('ALLOW MCP') && l.includes('faketool.internal')),
    ).toBe(true);
  });
});
