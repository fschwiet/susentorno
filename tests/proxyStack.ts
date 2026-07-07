import { execa } from 'execa';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './integration/mockUpstream';

export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const ADMIN_PORT = 19901;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
export const REAL_AUTH = 'Bearer sandbox-test-real-token-12345';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowlistFixture = join(repoRoot, 'tests', 'integration', 'fixtures', 'allowlist.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const envRoot = join(repoRoot, '.configamatron');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
}

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

export async function startProxyStack(): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
    ENVOY_ADMIN_PORT: String(ADMIN_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

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

  await execa('docker', ['compose', 'up', '-d'], { cwd: proxyDir, env: composeEnv });

  await waitForAdminReady(30000);
  const caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
  return { mockUpstream, caCertPem, proxyDir, composeEnv };
}

export async function stopProxyStack(stack: ProxyStack): Promise<void> {
  await execa('docker', ['compose', 'down'], { cwd: stack.proxyDir });
  await stopMockUpstream(stack.mockUpstream);
}
