import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './proxy-stack/mockUpstream';
import { killProcessTree } from '../src/runHosting/killProcessTree';
import { rmEnvRoot } from './rmEnvRoot';
import { repoRoot, envParent, envRoot } from './testEnvRoot';
import { buildJwt } from '../src/jwt';

export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-susentorno-PLACEHOLDER';
export const REAL_TOKEN = 'susentorno-test-real-token-12345';
export const REAL_AUTH = `Bearer ${REAL_TOKEN}`;

const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'allow-list.txt');
const authListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'auth-list.txt');
const blockListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'block-list.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const authFixture = join(repoRoot, 'tests', 'fixtures', 'auth.json');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
  proxyProc: ResultPromise;
  /** Every stdout/stderr line run-hosting has produced so far, in order. */
  stdoutLines: string[];
  /** The environment's live allowlist — edit it to trigger a proxy restart. */
  allowListPath: string;
  authListPath: string;
  blockListPath: string;
  /** The mutable credentials file run-hosting watches — rotate it to trigger a restart. */
  credentialsPath: string;
}

export interface ProxyStackOptions {
  /** Omit for --no-forward on 18080/18443 — today's default, and every proxy-stack caller. */
  forward?: { isolationName: string };
  extraArgs?: string[];
}

/**
 * --no-forward disables the gateway's non-loopback listener, the DNS responder,
 * and the DHCP server together, and run-hosting rejects it alongside
 * --isolation-name. So the two are alternatives, never both.
 */
export function buildForwardArgs(options: ProxyStackOptions): string[] {
  return options.forward ? ['--isolation-name', options.forward.isolationName] : ['--no-forward'];
}

/**
 * ENVOY_HTTP_PORT/ENVOY_HTTPS_PORT are misleadingly named: they are the
 * *gateway's* listen ports, and startGateway opens one port pair across every
 * address in listenAddresses. A forwarding stack therefore cannot give the
 * adapter :443 and loopback :18443 — it takes the 80/443 defaults on both, and
 * leaving these unset is how it gets them.
 */
export function buildGatewayPortEnv(options: ProxyStackOptions): NodeJS.ProcessEnv {
  return options.forward
    ? {}
    : { ENVOY_HTTP_PORT: String(HTTP_PORT), ENVOY_HTTPS_PORT: String(HTTPS_PORT) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeCredentialsFile(path: string, token: string): void {
  writeFileSync(
    path,
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

export function writeStackCredentials(stack: ProxyStack, token: string): void {
  writeCredentialsFile(stack.credentialsPath, token);
}

export function countProxyLines(stack: ProxyStack, needle: string): number {
  return stack.stdoutLines.filter((line) => line.includes(needle)).length;
}

/**
 * Wait until run-hosting prints a line containing `needle` at index >= fromIndex.
 * Returns the matching index; capture `stack.stdoutLines.length` before an
 * action to assert on output the action caused.
 */
export async function waitForProxyLine(
  stack: ProxyStack,
  needle: string,
  timeoutMs: number,
  fromIndex = 0,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = fromIndex; i < stack.stdoutLines.length; i++) {
      if (stack.stdoutLines[i].includes(needle)) return i;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-hosting output containing '${needle}'\n` +
          `--- run-hosting output ---\n${stack.stdoutLines.join('\n')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForStartupLine(
  lines: string[],
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some((l) => l.includes(needle))) return;
    await sleep(250);
  }
  throw new Error(
    `run-hosting never logged '${needle}'\n--- run-hosting output ---\n${lines.join('\n')}`,
  );
}

export async function startProxyStack(options: ProxyStackOptions = {}): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = { ...process.env, ...buildGatewayPortEnv(options) };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // Stage the test allowlist as the environment's own before generate-ca so
  // the leaf SANs derive from it; run-hosting then builds envoy.yaml from it too.
  const allowListPath = join(proxyDir, 'allow-list.txt');
  const authListPath = join(proxyDir, 'auth-list.txt');
  const blockListPath = join(proxyDir, 'block-list.txt');
  copyFileSync(allowListFixture, allowListPath);
  copyFileSync(authListFixture, authListPath);
  copyFileSync(blockListFixture, blockListPath);
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // run-hosting owns the SDS secret now: the token in this mutable credentials
  // file becomes the injected `Bearer ${REAL_TOKEN}` header.
  const credentialsPath = join(envRoot, 'run-hosting-credentials.json');
  writeCredentialsFile(credentialsPath, REAL_TOKEN);

  const codexCredentialsPath = join(envRoot, 'run-hosting-auth.json');
  writeCodexAuthFile(
    codexCredentialsPath,
    buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
  );

  const proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      ...buildForwardArgs(options),
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
      ...(options.extraArgs ?? []),
    ],
    { cwd: envParent, env: composeEnv, buffer: false, reject: false },
  );

  const stdoutLines: string[] = [];
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      stdoutLines.push(line);
      console.log(`run-hosting| ${line}`);
    });
  }

  // run-hosting builds envoy.yaml, writes the secret, and force-recreates; ready
  // means the whole startup sequence completed.
  await waitForStartupLine(stdoutLines, 'serving the current token', 60000);
  const caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
  return {
    mockUpstream,
    caCertPem,
    proxyDir,
    composeEnv,
    proxyProc,
    stdoutLines,
    allowListPath,
    authListPath,
    blockListPath,
    credentialsPath,
  };
}

export async function stopProxyStack(stack: ProxyStack): Promise<void> {
  // Kill the whole tree: run-hosting's docker-logs child holds a stdout pipe
  // that would otherwise keep `await proxyProc` hanging on Windows.
  if (stack.proxyProc.pid !== undefined) {
    await killProcessTree(stack.proxyProc.pid, 'SIGINT');
  }
  try {
    await stack.proxyProc;
  } catch {
    // killed above / non-zero exit is expected
  }
  await execa('docker', ['compose', 'down'], { cwd: stack.proxyDir });
  await stopMockUpstream(stack.mockUpstream);
}
