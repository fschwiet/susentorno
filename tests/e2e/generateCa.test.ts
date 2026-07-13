import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

let dir: string;
const caCert = () => join(dir, '.configamatron', 'proxy', 'ca', 'cert.pem');
const caKey = () => join(dir, '.configamatron', 'proxy', 'ca', 'key.pem');
const caLeafCert = () => join(dir, '.configamatron', 'proxy', 'ca', 'leaf-cert.pem');
const caLeafKey = () => join(dir, '.configamatron', 'proxy', 'ca', 'leaf-key.pem');
const vmCert = () => join(dir, '.configamatron', 'vm-shared', 'cert.pem');
const vmWindowsCert = () => join(dir, '.configamatron', 'vm-shared-windows', 'cert.pem');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'configamatron-ca-'));
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configamatron generate-ca', () => {
  it('writes the root CA and a leaf, and copies the root cert.pem into vm-shared', async () => {
    const { exitCode } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(existsSync(caKey())).toBe(true);
    expect(existsSync(caLeafCert())).toBe(true);
    expect(existsSync(caLeafKey())).toBe(true);

    // vm-shared gets the ROOT, not the leaf
    expect(readFileSync(vmCert(), 'utf8')).toBe(readFileSync(caCert(), 'utf8'));

    // The Windows shared folder gets the same root cert.pem.
    expect(readFileSync(vmWindowsCert(), 'utf8')).toBe(readFileSync(caCert(), 'utf8'));

    const root = new X509Certificate(readFileSync(caCert(), 'utf8'));
    expect(root.subject).toContain('configamatron-proxy-certificate-authority');
    expect(root.ca).toBe(true);
    expect(root.subjectAltName).toBeUndefined(); // root carries no server SANs

    const leaf = new X509Certificate(readFileSync(caLeafCert(), 'utf8'));
    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toContain('DNS:api.anthropic.com');
    expect(leaf.subjectAltName).toContain('DNS:claude.com');
    expect(leaf.verify(root.publicKey)).toBe(true); // leaf chains to the root
  });

  it('reuses existing valid material instead of regenerating', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    const rootBefore = readFileSync(caCert(), 'utf8');
    const leafBefore = readFileSync(caLeafCert(), 'utf8');

    const { exitCode, stdout } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('reused root CA');
    expect(stdout).toContain('reused leaf');
    expect(readFileSync(caCert(), 'utf8')).toBe(rootBefore);
    expect(readFileSync(caLeafCert(), 'utf8')).toBe(leafBefore);
  });

  it('reissues the leaf from the unchanged root when the leaf is missing', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    const rootBefore = readFileSync(caCert(), 'utf8');
    const keyBefore = readFileSync(caKey(), 'utf8');
    rmSync(caLeafCert());
    rmSync(caLeafKey());

    const { exitCode, stdout } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('issued leaf');
    // root untouched → installed trust stays valid
    expect(readFileSync(caCert(), 'utf8')).toBe(rootBefore);
    expect(readFileSync(caKey(), 'utf8')).toBe(keyBefore);

    const root = new X509Certificate(rootBefore);
    const leaf = new X509Certificate(readFileSync(caLeafCert(), 'utf8'));
    expect(leaf.verify(root.publicKey)).toBe(true);
  });

  it('fails loudly on an unparseable existing root pair without overwriting it', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    writeFileSync(caKey(), 'garbage');

    const { exitCode, stderr } = await execa('node', [cliPath, 'generate-ca'], {
      cwd: dir,
      reject: false,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('key.pem');
    expect(readFileSync(caKey(), 'utf8')).toBe('garbage');
  });

  it('exits 1 without an environment', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'configamatron-bare-'));
    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'generate-ca'], {
        cwd: bare,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron init' first");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
