import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_DIR_NAME = '.susentorno';

export interface VmSharedPaths {
  dir: string;
  cert: string;
  credentials: string;
  authJson: string;
  githubConfig: string;
  homeJqTransforms: string;
  preScripts: string;
  postScripts: string;
}

export interface EnvPaths {
  root: string;
  vmShared: string;
  vmSharedWindows: string;
  vmSharedTargets: VmSharedPaths[];
  homeJqTransforms: string;
  preScripts: string;
  postScripts: string;
  gitignore: string;
  proxy: string;
  allowList: string;
  authList: string;
  blockList: string;
  mcpServers: string;
  envoyConfig: string;
  caDir: string;
  caCert: string;
  caKey: string;
  caLeafCert: string;
  caLeafKey: string;
  secretsDir: string;
  sdsSecret: string;
  codexSecret: string;
  codexAccountIdSecret: string;
  githubBasicSecret: string;
  githubApiTokenSecret: string;
  vmCert: string;
  vmCredentials: string;
  githubConfig: string;
}

export function envPaths(cwd: string): EnvPaths {
  const root = join(cwd, ENV_DIR_NAME);
  const vmShared = join(root, 'vm-shared-linux');
  const vmSharedWindows = join(root, 'vm-shared-windows');
  const proxy = join(root, 'proxy');
  const target = (dir: string): VmSharedPaths => ({
    dir,
    cert: join(dir, 'cert.pem'),
    credentials: join(dir, 'credentials.json'),
    authJson: join(dir, 'auth.json'),
    githubConfig: join(dir, 'github-config.txt'),
    homeJqTransforms: join(dir, 'home-jq-transforms'),
    preScripts: join(dir, 'pre-scripts'),
    postScripts: join(dir, 'post-scripts'),
  });
  const vmSharedTargets = [target(vmShared), target(vmSharedWindows)];
  return {
    root,
    vmShared,
    vmSharedWindows,
    vmSharedTargets,
    homeJqTransforms: join(root, 'home-jq-transforms'),
    preScripts: join(root, 'pre-scripts'),
    postScripts: join(root, 'post-scripts'),
    gitignore: join(root, '.gitignore'),
    proxy,
    allowList: join(proxy, 'allow-list.txt'),
    authList: join(proxy, 'auth-list.txt'),
    blockList: join(proxy, 'block-list.txt'),
    mcpServers: join(root, 'mcp-servers.yaml'),
    envoyConfig: join(proxy, 'envoy.yaml'),
    caDir: join(proxy, 'ca'),
    caCert: join(proxy, 'ca', 'cert.pem'),
    caKey: join(proxy, 'ca', 'key.pem'),
    caLeafCert: join(proxy, 'ca', 'leaf-cert.pem'),
    caLeafKey: join(proxy, 'ca', 'leaf-key.pem'),
    secretsDir: join(proxy, 'secrets'),
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    codexSecret: join(proxy, 'secrets', 'codex-secret.yaml'),
    codexAccountIdSecret: join(proxy, 'secrets', 'codex-account-id-secret.yaml'),
    githubBasicSecret: join(proxy, 'secrets', 'github-basic-secret.yaml'),
    githubApiTokenSecret: join(proxy, 'secrets', 'github-api-token-secret.yaml'),
    vmCert: vmSharedTargets[0].cert,
    vmCredentials: vmSharedTargets[0].credentials,
    githubConfig: vmSharedTargets[0].githubConfig,
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
    console.error(`${commandName}: no ${ENV_DIR_NAME} in ${cwd} — run 'susentorno init' first`);
    process.exitCode = 1;
    return null;
  }
  return envPaths(cwd);
}
