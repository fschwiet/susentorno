import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_DIR_NAME = '.configamatron';

export interface EnvPaths {
  root: string;
  vmShared: string;
  proxy: string;
  allowlist: string;
  envoyConfig: string;
  caDir: string;
  caCert: string;
  caKey: string;
  secretsDir: string;
  sdsSecret: string;
  vmCert: string;
  vmCredentials: string;
  githubConfig: string;
}

export function envPaths(cwd: string): EnvPaths {
  const root = join(cwd, ENV_DIR_NAME);
  const vmShared = join(root, 'vm-shared');
  const proxy = join(root, 'proxy');
  return {
    root,
    vmShared,
    proxy,
    allowlist: join(proxy, 'allowlist.txt'),
    envoyConfig: join(proxy, 'envoy.yaml'),
    caDir: join(proxy, 'ca'),
    caCert: join(proxy, 'ca', 'cert.pem'),
    caKey: join(proxy, 'ca', 'key.pem'),
    secretsDir: join(proxy, 'secrets'),
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    vmCert: join(vmShared, 'cert.pem'),
    vmCredentials: join(vmShared, 'credentials.json'),
    githubConfig: join(vmShared, 'github-config.txt'),
  };
}

export function hasEnvironment(cwd: string): boolean {
  return existsSync(join(cwd, ENV_DIR_NAME));
}

/**
 * Resolve the environment for a command, or report the standard missing-environment
 * error. Commands must bail (`return`) when this returns null.
 */
export function requireEnvPathsOrExit(commandName: string, cwd = process.cwd()): EnvPaths | null {
  if (!hasEnvironment(cwd)) {
    console.error(`${commandName}: no ${ENV_DIR_NAME} in ${cwd} — run 'configamatron init' first`);
    process.exitCode = 1;
    return null;
  }
  return envPaths(cwd);
}
