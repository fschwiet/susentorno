import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEnvironment } from '../../src/initEnv';
import { templatesDir, packagedAllowlist } from '../../src/templates';
import { ENV_DIR_NAME } from '../../src/envPaths';

const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

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
    codexCredentialsPath: authFixture,
    templatesDir: templatesDir(),
    allowlistSource: packagedAllowlist(),
    ...overrides,
  };
}

describe('environment initialization', () => {
  describe('scaffolding VM shares, proxy config, and allowlist', () => {
    it('copies vm-shared and proxy templates, the allowlist, and sanitized credentials', () => {
      initEnvironment(options());

      const root = join(dir, ENV_DIR_NAME);
      for (const file of [
        'vm-shared/pre-scripts/01-apt-packages.sh',
        'vm-shared/pre-scripts/05-configure-network.sh',
        'vm-shared/post-scripts/01-auth-config.sh',
        'vm-shared/post-scripts/02-apply-home-jq-transforms.sh',
        'vm-shared/credentials.json',
        'proxy/docker-compose.yml',
        'proxy/gate.lua',
        'proxy/host-allow-vm-inbound.ps1',
        'proxy/allowlist.txt',
        'vm-shared-windows/pre-scripts/01-install-packages.ps1',
        'vm-shared-windows/pre-scripts/05-configure-network.ps1',
        'vm-shared-windows/post-scripts/01-auth-config.ps1',
        'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
        'vm-shared-windows/verify-config.ps1',
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

    it('copies the configamatron.gitignore as .gitignore', () => {
      initEnvironment(options());
      const root = join(dir, ENV_DIR_NAME);
      expect(existsSync(join(root, '.gitignore')), '.gitignore').toBe(true);
    });

    it('scaffolds empty custom pre/post script folders with placeholder READMEs', () => {
      initEnvironment(options());
      const root = join(dir, ENV_DIR_NAME);
      expect(existsSync(join(root, 'pre-scripts', 'README.md'))).toBe(true);
      expect(existsSync(join(root, 'post-scripts', 'README.md'))).toBe(true);
    });
  });

  describe('sanitized credentials', () => {
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

    it('writes the sanitized placeholder auth.json into both shared folders', () => {
      initEnvironment(options());
      const root = join(dir, ENV_DIR_NAME);
      for (const folder of ['vm-shared', 'vm-shared-windows']) {
        const auth = readFileSync(join(root, folder, 'auth.json'), 'utf8');
        const parsed = JSON.parse(auth);
        expect(parsed.tokens.account_id, folder).toBe('acct-uuid-1234'); // pass-through
        expect(auth, folder).not.toContain('real.access.token.value'); // secret gone
      }
    });
  });

  describe('home settings transforms', () => {
    it('seeds home-jq-transforms into the source folder and both shares', () => {
      initEnvironment(options());
      const root = join(dir, ENV_DIR_NAME);
      for (const rel of [
        'home-jq-transforms/manifest.yaml',
        'home-jq-transforms/vscode-settings.jq',
        'vm-shared/home-jq-transforms/manifest.yaml',
        'vm-shared-windows/home-jq-transforms/manifest.yaml',
      ]) {
        expect(existsSync(join(root, rel)), rel).toBe(true);
      }
    });
  });

  describe('setup failures', () => {
    it('fails without writing anything when the codex auth file is missing', () => {
      expect(() =>
        initEnvironment(options({ codexCredentialsPath: join(dir, 'nope.json') })),
      ).toThrow('could not read codex credentials');
      expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
    });

    it('fails without writing anything when the codex auth file is unparseable', () => {
      const badPath = join(dir, 'bad-auth.json');
      writeFileSync(badPath, '{nope');
      expect(() => initEnvironment(options({ codexCredentialsPath: badPath }))).toThrow(
        'invalid codex auth file',
      );
      expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
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
});
