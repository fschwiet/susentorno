import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_DIR_NAME, envPaths, hasEnvironment } from '../../src/envPaths';

describe('envPaths', () => {
  it('maps a cwd to the environment layout', () => {
    const paths = envPaths('/some/dir');
    const root = join('/some/dir', ENV_DIR_NAME);
    expect(paths.root).toBe(root);
    expect(paths.vmShared).toBe(join(root, 'vm-shared'));
    expect(paths.proxy).toBe(join(root, 'proxy'));
    expect(paths.allowlist).toBe(join(root, 'proxy', 'allowlist.txt'));
    expect(paths.envoyConfig).toBe(join(root, 'proxy', 'envoy.yaml'));
    expect(paths.caDir).toBe(join(root, 'proxy', 'ca'));
    expect(paths.caCert).toBe(join(root, 'proxy', 'ca', 'cert.pem'));
    expect(paths.caKey).toBe(join(root, 'proxy', 'ca', 'key.pem'));
    expect(paths.caLeafCert).toBe(join(root, 'proxy', 'ca', 'leaf-cert.pem'));
    expect(paths.caLeafKey).toBe(join(root, 'proxy', 'ca', 'leaf-key.pem'));
    expect(paths.secretsDir).toBe(join(root, 'proxy', 'secrets'));
    expect(paths.sdsSecret).toBe(join(root, 'proxy', 'secrets', 'sds-secret.yaml'));
    expect(paths.githubBasicSecret).toBe(
      join(root, 'proxy', 'secrets', 'github-basic-secret.yaml'),
    );
    expect(paths.githubApiTokenSecret).toBe(
      join(root, 'proxy', 'secrets', 'github-api-token-secret.yaml'),
    );
    expect(paths.vmCert).toBe(join(root, 'vm-shared', 'cert.pem'));
    expect(paths.vmCredentials).toBe(join(root, 'vm-shared', 'credentials.json'));
    expect(paths.githubConfig).toBe(join(root, 'vm-shared', 'github-config.txt'));

    // Windows guest shared folder + the both-folders target list.
    expect(paths.vmSharedWindows).toBe(join(root, 'vm-shared-windows'));
    expect(paths.vmSharedTargets).toHaveLength(2);
    expect(paths.vmSharedTargets[0]).toEqual({
      dir: join(root, 'vm-shared'),
      cert: join(root, 'vm-shared', 'cert.pem'),
      credentials: join(root, 'vm-shared', 'credentials.json'),
      githubConfig: join(root, 'vm-shared', 'github-config.txt'),
    });
    expect(paths.vmSharedTargets[1]).toEqual({
      dir: join(root, 'vm-shared-windows'),
      cert: join(root, 'vm-shared-windows', 'cert.pem'),
      credentials: join(root, 'vm-shared-windows', 'credentials.json'),
      githubConfig: join(root, 'vm-shared-windows', 'github-config.txt'),
    });
  });

  it('hasEnvironment reflects whether .configamatron exists', () => {
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
