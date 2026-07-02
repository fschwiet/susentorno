import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../scripts/generate-ca.sh', import.meta.url));
const certPath = fileURLToPath(new URL('../../envoy/ca/cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('../../envoy/ca/key.pem', import.meta.url));

describe('generate-ca.sh', () => {
  afterAll(() => {
    rmSync(certPath, { force: true });
    rmSync(keyPath, { force: true });
  });

  it('generates a CA cert/key covering the terminate hostnames', async () => {
    await execa('bash', [scriptPath]);

    expect(existsSync(certPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);

    const { stdout } = await execa('openssl', ['x509', '-in', certPath, '-noout', '-text']);
    expect(stdout).toContain('api.anthropic.com');
    expect(stdout).toContain('downloads.claude.ai');
  });
});
