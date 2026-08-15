import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEnvironment } from '../../src/initEnv';
import {
  templatesDir,
  packagedAllowList,
  packagedAuthList,
  packagedBlockList,
} from '../../src/templates';
import { ENV_DIR_NAME } from '../../src/envPaths';
import { CODEX_PLACEHOLDER_ACCOUNT_ID } from '../../src/codexPlaceholder';

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
    allowListSource: packagedAllowList(),
    authListSource: packagedAuthList(),
    blockListSource: packagedBlockList(),
    ...overrides,
  };
}

describe('environment initialization', () => {
  describe('scaffolding VM shares, proxy config, and allowlist', () => {
    it('copies vm-shared-linux and proxy templates, the allowlist, and sanitized credentials', () => {
      initEnvironment(options());

      const root = join(dir, ENV_DIR_NAME);
      for (const file of [
        'vm-shared-linux/pre-scripts/01-apt-packages.sh',
        'vm-shared-linux/pre-scripts/04-configure-network.sh',
        'vm-shared-linux/post-scripts/01-auth-config.sh',
        'vm-shared-linux/post-scripts/02-apply-home-jq-transforms.sh',
        'vm-shared-linux/credentials.json',
        'proxy/docker-compose.yml',
        'proxy/gate.lua',
        'proxy/allow-list.txt',
        'proxy/auth-list.txt',
        'proxy/block-list.txt',
        'vm-shared-windows/pre-scripts/01-install-packages.ps1',
        'vm-shared-windows/pre-scripts/05-configure-network.ps1',
        'vm-shared-windows/post-scripts/01-auth-config.ps1',
        'vm-shared-windows/post-scripts/02-apply-home-jq-transforms.ps1',
        'vm-shared-windows/verify-config.ps1',
        'vm-shared-windows/credentials.json',
      ]) {
        expect(existsSync(join(root, file)), file).toBe(true);
      }

      const credentials = readFileSync(join(root, 'vm-shared-linux', 'credentials.json'), 'utf8');
      expect(credentials).not.toContain('\r');
      expect(credentials).not.toContain('sk-ant-oat-test-fixture-token');
      expect(JSON.parse(credentials).claudeAiOauth.accessToken).toBe(
        'sk-ant-oat-susentorno-PLACEHOLDER',
      );
    });

    it('copies the susentorno.gitignore as .gitignore', () => {
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
      for (const folder of ['vm-shared-linux', 'vm-shared-windows']) {
        const credentials = readFileSync(join(root, folder, 'credentials.json'), 'utf8');
        expect(JSON.parse(credentials).claudeAiOauth.accessToken, folder).toBe(
          'sk-ant-oat-susentorno-PLACEHOLDER',
        );
      }
    });

    it('writes the sanitized placeholder auth.json into both shared folders', () => {
      initEnvironment(options());
      const root = join(dir, ENV_DIR_NAME);
      for (const folder of ['vm-shared-linux', 'vm-shared-windows']) {
        const auth = readFileSync(join(root, folder, 'auth.json'), 'utf8');
        const parsed = JSON.parse(auth);
        expect(parsed.tokens.account_id, folder).toBe(CODEX_PLACEHOLDER_ACCOUNT_ID);
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
        'vm-shared-linux/home-jq-transforms/manifest.yaml',
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

    it('refuses to run when .susentorno already exists', () => {
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
