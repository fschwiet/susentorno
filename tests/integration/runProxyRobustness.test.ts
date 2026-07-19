import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { isColorRunning } from '../../src/runProxy/isColorRunning';
import { rmEnvRoot } from '../rmEnvRoot';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

// Distinct from runProxy.test.ts's ports to avoid any lingering-socket overlap.
const HTTPS_PORT = 18545;
const HTTP_PORT = 18182;
const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
};

let tempDir: string;
let credentialsPath: string;
let proxyProc: ResultPromise | null = null;
let lines: string[] = [];

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

function spawnProxy(fault: 'crash-config' | 'never-ready'): ResultPromise {
  lines = [];
  const proc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--inject-fault',
      fault,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => lines.push(line));
  }
  return proc;
}

function spawnProxyPlain(): ResultPromise {
  lines = [];
  const proc = execa(
    'node',
    [cliPath, 'run-proxy', '--no-refresh', '--no-forward', '--credentials', credentialsPath],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => lines.push(line));
  }
  return proc;
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (lines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-proxy output containing '${needle}'\n` +
          `--- output ---\n${lines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-robust-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-robust');

  await rmEnvRoot(envRoot);
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
}, 120000);

afterEach(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
    try {
      await proxyProc;
    } catch {
      // ignore kill/non-zero
    }
  }
  proxyProc = null;
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('run-proxy robustness', () => {
  it('fast-fails with a config-issue hint when the color exits during startup', async () => {
    proxyProc = spawnProxy('crash-config');
    await waitForLine('exited during startup', 30000); // a regression would wait ~60s
    const result = await proxyProc;
    proxyProc = null; // already exited; skip afterEach kill
    expect(result.exitCode).not.toBe(0);
  }, 60000);

  it('responds to SIGINT promptly while parked waiting for a never-ready color', async () => {
    proxyProc = spawnProxy('never-ready');
    // Once the container is running, run-proxy is parked in the startup waitColorReady.
    await waitFor(() => isColorRunning('blue', proxyDir), 60000);

    const t0 = Date.now();
    await killProcessTree(proxyProc.pid!, 'SIGINT');
    await proxyProc; // reject:false -> resolves on exit
    proxyProc = null;
    expect(Date.now() - t0).toBeLessThan(10000); // a regression would hang ~60s
  }, 120000);

  it('starts cleanly on a passthrough+terminate collision (single filter chain per SNI)', async () => {
    writeFileSync(
      join(proxyDir, 'allowlist.txt'),
      [
        '#pragma passthrough',
        'shared.example.com:443',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'shared.example.com:443',
        '',
      ].join('\n'),
    );

    proxyProc = spawnProxyPlain();
    // The collision warning appears, and Envoy accepts the resolved config and
    // becomes ready — a regression would leave Envoy refusing the config.
    await waitForLine("collision: 'shared.example.com:443'", 30000);
    await waitForLine('proxy is serving the current token', 60000);
  }, 120000);
});
