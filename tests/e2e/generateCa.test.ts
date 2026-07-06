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
const vmCert = () => join(dir, '.configamatron', 'vm-shared', 'cert.pem');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'configamatron-ca-'));
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configamatron generate-ca', () => {
  it('writes the CA pair and copies cert.pem into vm-shared', async () => {
    const { exitCode } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(existsSync(caKey())).toBe(true);
    expect(readFileSync(vmCert(), 'utf8')).toBe(readFileSync(caCert(), 'utf8'));

    const cert = new X509Certificate(readFileSync(caCert(), 'utf8'));
    expect(cert.subject).toContain('sbx-sandbox-proxy-ca');
    expect(cert.subjectAltName).toContain('DNS:api.anthropic.com');
    expect(cert.subjectAltName).toContain('DNS:downloads.claude.ai');
  });

  it('reuses an existing valid pair instead of regenerating', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    const before = readFileSync(caCert(), 'utf8');

    const { exitCode, stdout } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('reusing');
    expect(readFileSync(caCert(), 'utf8')).toBe(before);
  });

  it('fails loudly on an unparseable existing pair without overwriting it', async () => {
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
