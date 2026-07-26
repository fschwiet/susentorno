import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './integration/mockUpstream';
import { killProcessTree } from '../src/runProxy/killProcessTree';
import { rmEnvRoot } from './rmEnvRoot';
import { repoRoot, envParent, envRoot } from './testEnvRoot';
import { buildJwt } from '../src/jwt';

export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
export const REAL_TOKEN = 'sandbox-test-real-token-12345';
export const REAL_AUTH = `Bearer ${REAL_TOKEN}`;

const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowlistFixture = join(repoRoot, 'tests', 'integration', 'fixtures', 'allowlist.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const authFixture = join(repoRoot, 'tests', 'fixtures', 'auth.json');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
  proxyProc: ResultPromise;
  /** Every stdout/stderr line run-proxy has produced so far, in order. */
  stdoutLines: string[];
  /** The environment's live allowlist — edit it to trigger a proxy restart. */
  allowlistPath: string;
  /** The mutable credentials file run-proxy watches — rotate it to trigger a restart. */
  credentialsPath: string;
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
 * Wait until run-proxy prints a line containing `needle` at index >= fromIndex.
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
        `timed out waiting for run-proxy output containing '${needle}'\n` +
          `--- run-proxy output ---\n${stack.stdoutLines.join('\n')}`,
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
    `run-proxy never logged '${needle}'\n--- run-proxy output ---\n${lines.join('\n')}`,
  );
}

export async function startProxyStack(): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // Stage the test allowlist as the environment's own before generate-ca so
  // the leaf SANs derive from it; run-proxy then builds envoy.yaml from it too.
  const allowlistPath = join(proxyDir, 'allowlist.txt');
  copyFileSync(allowlistFixture, allowlistPath);
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // run-proxy owns the SDS secret now: the token in this mutable credentials
  // file becomes the injected `Bearer ${REAL_TOKEN}` header.
  const credentialsPath = join(envRoot, 'run-proxy-credentials.json');
  writeCredentialsFile(credentialsPath, REAL_TOKEN);

  const codexCredentialsPath = join(envRoot, 'run-proxy-auth.json');
  writeCodexAuthFile(
    codexCredentialsPath,
    buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
  );

  const proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: envParent, env: composeEnv, buffer: false, reject: false },
  );

  const stdoutLines: string[] = [];
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      stdoutLines.push(line);
      console.log(`run-proxy| ${line}`);
    });
  }

  // run-proxy builds envoy.yaml, writes the secret, and force-recreates; ready
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
    allowlistPath,
    credentialsPath,
  };
}

export async function stopProxyStack(stack: ProxyStack): Promise<void> {
  // Kill the whole tree: run-proxy's docker-logs child holds a stdout pipe
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
