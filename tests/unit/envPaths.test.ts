import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_DIR_NAME, envPaths, hasEnvironment } from '../../src/envPaths';

describe('environment paths & layout', () => {
  describe('environment root layout', () => {
    it('maps a cwd to the environment layout', () => {
      const paths = envPaths('/some/dir');
      const root = join('/some/dir', ENV_DIR_NAME);
      expect(paths.root).toBe(root);
      expect(paths.vmShared).toBe(join(root, 'vm-shared-linux'));
      expect(paths.proxy).toBe(join(root, 'proxy'));
      expect(paths.allowList).toBe(join(root, 'proxy', 'allow-list.txt'));
      expect(paths.authList).toBe(join(root, 'proxy', 'auth-list.txt'));
      expect(paths.blockList).toBe(join(root, 'proxy', 'block-list.txt'));
      expect(paths.envoyConfig).toBe(join(root, 'proxy', 'envoy.yaml'));
      expect(paths.caDir).toBe(join(root, 'proxy', 'ca'));
      expect(paths.caCert).toBe(join(root, 'proxy', 'ca', 'cert.pem'));
      expect(paths.caKey).toBe(join(root, 'proxy', 'ca', 'key.pem'));
      expect(paths.caLeafCert).toBe(join(root, 'proxy', 'ca', 'leaf-cert.pem'));
      expect(paths.caLeafKey).toBe(join(root, 'proxy', 'ca', 'leaf-key.pem'));
      expect(paths.secretsDir).toBe(join(root, 'proxy', 'secrets'));
      expect(paths.sdsSecret).toBe(join(root, 'proxy', 'secrets', 'sds-secret.yaml'));
      expect(paths.codexSecret).toBe(join(root, 'proxy', 'secrets', 'codex-secret.yaml'));
      expect(paths.githubBasicSecret).toBe(
        join(root, 'proxy', 'secrets', 'github-basic-secret.yaml'),
      );
      expect(paths.githubApiTokenSecret).toBe(
        join(root, 'proxy', 'secrets', 'github-api-token-secret.yaml'),
      );
      expect(paths.vmCert).toBe(join(root, 'vm-shared-linux', 'cert.pem'));
      expect(paths.vmCredentials).toBe(join(root, 'vm-shared-linux', 'credentials.json'));
      expect(paths.githubConfig).toBe(join(root, 'vm-shared-linux', 'github-config.txt'));

      // Windows guest shared folder + the both-folders target list.
      expect(paths.vmSharedWindows).toBe(join(root, 'vm-shared-windows'));
      expect(paths.vmSharedTargets).toHaveLength(2);
      expect(paths.vmSharedTargets[0]).toEqual({
        dir: join(root, 'vm-shared-linux'),
        cert: join(root, 'vm-shared-linux', 'cert.pem'),
        credentials: join(root, 'vm-shared-linux', 'credentials.json'),
        authJson: join(root, 'vm-shared-linux', 'auth.json'),
        githubConfig: join(root, 'vm-shared-linux', 'github-config.txt'),
        homeJqTransforms: join(root, 'vm-shared-linux', 'home-jq-transforms'),
        preScripts: join(root, 'vm-shared-linux', 'pre-scripts'),
        postScripts: join(root, 'vm-shared-linux', 'post-scripts'),
      });
      expect(paths.mcpServers).toBe(join(root, 'mcp-servers.yaml'));

      expect(paths.vmSharedTargets[1]).toEqual({
        dir: join(root, 'vm-shared-windows'),
        cert: join(root, 'vm-shared-windows', 'cert.pem'),
        credentials: join(root, 'vm-shared-windows', 'credentials.json'),
        authJson: join(root, 'vm-shared-windows', 'auth.json'),
        githubConfig: join(root, 'vm-shared-windows', 'github-config.txt'),
        homeJqTransforms: join(root, 'vm-shared-windows', 'home-jq-transforms'),
        preScripts: join(root, 'vm-shared-windows', 'pre-scripts'),
        postScripts: join(root, 'vm-shared-windows', 'post-scripts'),
      });
    });

    it('hasEnvironment reflects whether .susentorno exists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'envpaths-'));
      try {
        expect(hasEnvironment(dir)).toBe(false);
        mkdirSync(join(dir, ENV_DIR_NAME));
        expect(hasEnvironment(dir)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('VM share locations', () => {
    it('places the codex placeholder auth.json in each vm-shared-linux target', () => {
      const paths = envPaths('/work');
      expect(paths.vmSharedTargets.map((t) => t.authJson)).toEqual([
        join('/work', '.susentorno', 'vm-shared-linux', 'auth.json'),
        join('/work', '.susentorno', 'vm-shared-windows', 'auth.json'),
      ]);
    });

    it('gives each share its own home-jq-transforms copy', () => {
      const p = envPaths('/work');
      expect(p.vmSharedTargets[0].homeJqTransforms).toBe(join(p.vmShared, 'home-jq-transforms'));
      expect(p.vmSharedTargets[1].homeJqTransforms).toBe(
        join(p.vmSharedWindows, 'home-jq-transforms'),
      );
    });
  });

  describe('proxy secret locations', () => {
    it('places the codex SDS secret under proxy/secrets', () => {
      const paths = envPaths('/work');
      expect(paths.codexSecret).toBe(
        join('/work', '.susentorno', 'proxy', 'secrets', 'codex-secret.yaml'),
      );
    });
  });

  describe('home settings transform sources', () => {
    it('locates the user-edited custom script source folders', () => {
      const p = envPaths('/work');
      expect(p.preScripts).toBe(join('/work', '.susentorno', 'pre-scripts'));
      expect(p.postScripts).toBe(join('/work', '.susentorno', 'post-scripts'));
    });

    it('locates the source transforms folder and the env gitignore', () => {
      const p = envPaths('/work');
      expect(p.homeJqTransforms).toBe(join('/work', '.susentorno', 'home-jq-transforms'));
      expect(p.gitignore).toBe(join('/work', '.susentorno', '.gitignore'));
    });
  });
});
