import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { killProcessTree } from '../../src/runHosting/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { generateLeaf } from '../../src/ca';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { buildJwt } from '../../src/jwt';
import { envParent, envRoot } from '../testEnvRoot';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const proxyDir = join(envRoot, 'proxy');

/**
 * The fixture's access_token is a placeholder string, not a real JWT — fine for
 * `init`, but readCodexCredentials derives expiry from a JWT `exp` claim and
 * returns null otherwise, which run-hosting treats as a startup refusal. Every
 * other proxy-stack suite works around this the same way.
 */
function writeCodexAuthFile(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        refresh_token: 'upstream-validation-refresh',
        account_id: 'acct-upstream-validation',
      },
      auth_mode: 'chatgpt',
    }),
  );
}

// Distinct from every other proxy-stack suite's ports.
const HTTPS_PORT = 18451;
const HTTP_PORT = 18188;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-susentorno-PLACEHOLDER';
const REAL_TOKEN = 'susentorno-upstream-validation-real-token';
const REAL_AUTH = `Bearer ${REAL_TOKEN}`;

const GOOD = 'claude-good.test';
const WILDCARD = 'sub.claude-wild.test';
const BAD_NAME = 'claude-badname.test';
const UNTRUSTED = 'claude-untrusted.test';
const EXPIRED = 'claude-expired.test';
const ALL_HOSTS = [GOOD, WILDCARD, BAD_NAME, UNTRUSTED, EXPIRED];

let mocks: Record<string, MockUpstream>;
let tempDir: string;
let credentialsPath: string;
let codexCredentialsPath: string;
let caCertPem: string;
let throwawayCaPath: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

/**
 * A throwaway root CA with a name that cannot collide with a real susentorno
 * proxy CA. generateRootCa() (src/ca.ts) always uses the fixed CommonName
 * 'susentorno-proxy-certificate-authority' — fine for the one real CA a host
 * has, but a second CA reusing that identical Subject Name would make Envoy's
 * chain builder pick between two same-named-but-different-keyed candidates
 * when this suite's ambient trust snapshot includes a previously-trusted
 * susentorno CA from earlier work on the same machine, which fails RSA
 * signature verification outright rather than falling back to the other
 * candidate.
 */
function mintThrowawayRootCa(): { caCertPem: string; caKeyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: `upstream-validation-test-root-${Date.now()}` }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    caCertPem: forge.pki.certificateToPem(cert),
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * A leaf whose notAfter is already in the past. src/ca.ts's validityDates() is
 * private and takes no override, so this one certificate is minted directly
 * with node-forge — the same library generateLeaf uses internally.
 */
function mintExpiredLeaf(
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): { leafCertPem: string; leafKeyPem: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - 60 * 86_400_000);
  cert.validity.notAfter = new Date(Date.now() - 86_400_000);
  cert.setSubject([{ name: 'commonName', value: 'expired-leaf' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    leafCertPem: forge.pki.certificateToPem(cert),
    leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** A self-signed server cert carrying real SANs — chains to nothing in the bundle. */
function mintSelfSigned(sans: string[]): { leafCertPem: string; leafKeyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: sans[0] }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: sans.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    leafCertPem: forge.pki.certificateToPem(cert),
    leafKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for '${needle}'\n--- output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(servername: string): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername,
        ca: caCertPem,
        path: '/',
        headers: { authorization: PLACEHOLDER_AUTH },
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

beforeAll(async () => {
  const throwaway = mintThrowawayRootCa();

  // One leaf per destination. Only the SAN set and the issuer differ.
  const goodLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, [GOOD]);
  const wildLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, ['*.claude-wild.test']);
  const badNameLeaf = generateLeaf(throwaway.caCertPem, throwaway.caKeyPem, [
    'somewhere-else.test',
  ]);
  const untrustedLeaf = mintSelfSigned([UNTRUSTED]);
  const expiredLeaf = mintExpiredLeaf(throwaway.caCertPem, throwaway.caKeyPem, [EXPIRED]);

  mocks = {
    [GOOD]: await startMockUpstream({ key: goodLeaf.leafKeyPem, cert: goodLeaf.leafCertPem }),
    [WILDCARD]: await startMockUpstream({ key: wildLeaf.leafKeyPem, cert: wildLeaf.leafCertPem }),
    [BAD_NAME]: await startMockUpstream({
      key: badNameLeaf.leafKeyPem,
      cert: badNameLeaf.leafCertPem,
    }),
    [UNTRUSTED]: await startMockUpstream({
      key: untrustedLeaf.leafKeyPem,
      cert: untrustedLeaf.leafCertPem,
    }),
    [EXPIRED]: await startMockUpstream({
      key: expiredLeaf.leafKeyPem,
      cert: expiredLeaf.leafCertPem,
    }),
  };

  tempDir = mkdtempSync(join(tmpdir(), 'upstream-validation-'));
  credentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: REAL_TOKEN, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
  writeCodexAuthFile(codexCredentialsPath);

  throwawayCaPath = join(tempDir, 'throwaway-ca.pem');
  writeFileSync(throwawayCaPath, throwaway.caCertPem);

  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // The auth list must be written BEFORE generate-ca so the downstream leaf's
  // SANs cover all five destinations.
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(
    join(proxyDir, 'auth-list.txt'),
    ['#pragma claude authenticated', ...ALL_HOSTS.map((h) => `${h}:443`), ''].join('\n'),
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
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--verify-upstream-overrides',
      throwawayCaPath,
      ...ALL_HOSTS.flatMap((h) => [
        '--upstream-override',
        `${h}=host.docker.internal:${mocks[h].port}`,
      ]),
    ],
    { cwd: envParent, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 180000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore kill/non-zero
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  for (const host of ALL_HOSTS) {
    await stopMockUpstream(mocks[host]);
  }
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

/**
 * The access log is Envoy's own file-based logger writing to /dev/stdout
 * inside the container — it never reaches run-hosting's own stdout, so it has
 * to be read back via `docker compose logs`, the same way
 * allowlistEnforcement.test.ts does.
 */
async function readEnvoyLogs(): Promise<string> {
  const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy_blue'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
  });
  return stdout;
}

describe('upstream trust bundle assembly', () => {
  it('reports the bundle it assembled at startup', () => {
    expect(stdoutLines.some((l) => l.includes('upstream trust bundle:'))).toBe(true);
  });
});

describe('accepted upstream certificates', () => {
  it('connects and injects the real credential when the chain and SAN both match', async () => {
    const before = mocks[GOOD].receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(GOOD);
    expect(statusCode).toBe(200);
    expect(mocks[GOOD].receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });

  it('accepts a wildcard SAN covering the SNI host', async () => {
    const before = mocks[WILDCARD].receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(WILDCARD);
    expect(statusCode).toBe(200);
    expect(mocks[WILDCARD].receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });
});

describe('rejected upstream certificates', () => {
  // Each case asserts BOTH that the credential never crossed AND that the mock
  // saw a connection attempt. Non-disclosure alone would also pass if Envoy had
  // simply never dialled the mock — a wrong port would look identical.
  it('refuses a valid chain whose SAN does not cover the SNI host', async () => {
    const { statusCode } = await requestThrough(BAD_NAME);
    expect(statusCode).toBe(503);
    expect(mocks[BAD_NAME].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[BAD_NAME].connectionCount).toBeGreaterThan(0);
  });

  it('refuses a self-signed certificate even when its SAN matches', async () => {
    const { statusCode } = await requestThrough(UNTRUSTED);
    expect(statusCode).toBe(503);
    expect(mocks[UNTRUSTED].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[UNTRUSTED].connectionCount).toBeGreaterThan(0);
  });

  it('refuses an expired certificate from a trusted issuer', async () => {
    const { statusCode } = await requestThrough(EXPIRED);
    expect(statusCode).toBe(503);
    expect(mocks[EXPIRED].receivedAuthorizationHeaders).toEqual([]);
    expect(mocks[EXPIRED].connectionCount).toBeGreaterThan(0);
  });

  it('logs the refusal on the access log line for the destination', async () => {
    await requestThrough(UNTRUSTED);
    // Access logs flush on connection close; poll until the line appears.
    const deadline = Date.now() + 10000;
    let line: string | undefined;
    for (;;) {
      const logs = await readEnvoyLogs();
      line = logs.split('\n').find((l) => l.includes('CFGM|') && l.includes(UNTRUSTED));
      if (line !== undefined || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(line).toBeDefined();
    expect(line).toContain('503');
  });
});
