import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEnvironment } from '../../src/initEnv';
import { templatesDir, packagedAllowlist } from '../../src/templates';
import { ENV_DIR_NAME } from '../../src/envPaths';

const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof initEnvironment>[0]> = {}) {
  return {
    cwd: dir,
    credentialsPath: credentialsFixture,
    templatesDir: templatesDir(),
    allowlistSource: packagedAllowlist(),
    ...overrides,
  };
}

describe('initEnvironment', () => {
  it('copies vm-shared and proxy templates, the allowlist, and sanitized credentials', () => {
    initEnvironment(options());

    const root = join(dir, ENV_DIR_NAME);
    for (const file of [
      'vm-shared/01-apt-packages.sh',
      'vm-shared/06-trust-ca.sh',
      'vm-shared/07-setup-persistence.sh',
      'vm-shared/configamatron-egress.service',
      'vm-shared/credentials.json',
      'proxy/docker-compose.yml',
      'proxy/gate.lua',
      'proxy/host-allow-vm-inbound.ps1',
      'proxy/allowlist.txt',
      'vm-shared-windows/01-install-packages.ps1',
      'vm-shared-windows/07-setup-network.ps1',
      'vm-shared-windows/verify-config.ps1',
      'vm-shared-windows/dns-responder/Program.cs',
      'vm-shared-windows/credentials.json',
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }

    const credentials = readFileSync(join(root, 'vm-shared', 'credentials.json'), 'utf8');
    expect(credentials).not.toContain('\r');
    expect(credentials).not.toContain('sk-ant-oat-test-fixture-token');
    expect(JSON.parse(credentials).claudeAiOauth.accessToken).toBe(
      'sk-ant-oat-SANDBOX-PLACEHOLDER',
    );
  });

  it('writes the sanitized placeholder credential into both shared folders', () => {
    initEnvironment(options());
    const root = join(dir, ENV_DIR_NAME);
    for (const folder of ['vm-shared', 'vm-shared-windows']) {
      const credentials = readFileSync(join(root, folder, 'credentials.json'), 'utf8');
      expect(JSON.parse(credentials).claudeAiOauth.accessToken, folder).toBe(
        'sk-ant-oat-SANDBOX-PLACEHOLDER',
      );
    }
  });

  it('does not copy dns-responder bin/obj build artifacts into vm-shared-windows', () => {
    const templateDnsDir = join(templatesDir(), 'vm-shared-windows', 'dns-responder');
    const binFixture = join(templateDnsDir, 'bin');
    const objFixture = join(templateDnsDir, 'obj');
    // bin/ and obj/ are gitignored, so creating them here does not dirty the repo.
    mkdirSync(binFixture, { recursive: true });
    mkdirSync(objFixture, { recursive: true });
    writeFileSync(join(binFixture, 'stale.dll'), 'x');
    writeFileSync(join(objFixture, 'stale.json'), 'x');
    try {
      initEnvironment(options());
      const copiedDns = join(dir, ENV_DIR_NAME, 'vm-shared-windows', 'dns-responder');
      expect(existsSync(join(copiedDns, 'bin')), 'bin should not be copied').toBe(false);
      expect(existsSync(join(copiedDns, 'obj')), 'obj should not be copied').toBe(false);
      // The source files must still be copied.
      expect(existsSync(join(copiedDns, 'Program.cs'))).toBe(true);
      expect(existsSync(join(copiedDns, 'ConfigamatronDnsResponder.csproj'))).toBe(true);
    } finally {
      rmSync(binFixture, { recursive: true, force: true });
      rmSync(objFixture, { recursive: true, force: true });
    }
  });

  it('refuses to run when .configamatron already exists', () => {
    initEnvironment(options());
    expect(() => initEnvironment(options())).toThrow('already exists');
  });

  it('fails without writing anything when the credentials file is missing', () => {
    expect(() => initEnvironment(options({ credentialsPath: join(dir, 'nope.json') }))).toThrow(
      'could not read credentials',
    );
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });

  it('fails without writing anything when the credentials file is unparseable', () => {
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{nope');
    expect(() => initEnvironment(options({ credentialsPath: badPath }))).toThrow(
      'invalid credentials file',
    );
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });
});
