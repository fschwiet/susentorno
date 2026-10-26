import { execa } from 'execa';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Color, ColorPorts } from './types';

/** The root CA private key never enters a container; Envoy only needs the leaf key. */
const ROOT_CA_KEY_FILE = 'key.pem';

const containerName = (color: Color) => `susentorno-envoy-${color}`;

/**
 * Bring up one color's Envoy container, published on the given host ports, with
 * the environment's proxy configuration copied into it (ADR 0029): remove any
 * existing container for the color, create a fresh one through compose, `docker cp`
 * the configuration in, then start it. Nothing is bind-mounted from the host.
 *
 * The per-color env vars feed the compose template's `${ENVOY_<COLOR>_*}` port
 * mappings; process.env is inherited so unrelated overrides still flow through.
 * `environmentDir` (the directory that owns .susentorno) becomes the container's
 * `susentorno.environment` label, which verify-proxy.ps1 reads to prove ownership.
 * Runs in composeDir (the environment's .susentorno/proxy folder), which is also
 * the source of the copied configuration.
 *
 * Resolves once the color is started; rejects on any failure (including a failed
 * copy) after removing the half-built container, so the current color keeps serving.
 */
export async function bringUpColor(
  color: Color,
  ports: ColorPorts,
  composeDir: string,
  environmentDir: string,
): Promise<void> {
  const prefix = `ENVOY_${color.toUpperCase()}`;
  const service = `envoy_${color}`;
  const name = containerName(color);
  const options = {
    cwd: composeDir,
    env: {
      ...process.env,
      SUSENTORNO_ENVIRONMENT_DIR: environmentDir,
      [`${prefix}_HTTPS_PORT`]: String(ports.httpsPort),
      [`${prefix}_HTTP_PORT`]: String(ports.httpPort),
      [`${prefix}_ADMIN_PORT`]: String(ports.adminPort),
    },
  };

  await removeColor(color, composeDir, options.env);
  try {
    await execa('docker', ['compose', 'create', service], options);
    await copyConfiguration(name, composeDir);
    await execa('docker', ['compose', 'start', service], options);
  } catch (error) {
    await removeColor(color, composeDir, options.env).catch(() => undefined);
    throw error;
  }
}

/** Copy the proxy configuration into a created (not yet started) Envoy container. */
async function copyConfiguration(name: string, composeDir: string): Promise<void> {
  const docker = (...args: string[]) => execa('docker', ['cp', ...args]);
  await docker(join(composeDir, 'envoy.yaml'), `${name}:/etc/envoy/envoy.yaml`);
  await docker(join(composeDir, 'gate.lua'), `${name}:/etc/envoy/gate.lua`);
  await docker(join(composeDir, 'secrets', '.'), `${name}:/etc/envoy/secrets`);

  // Stage the CA directory without the root key so `docker cp` can copy it whole.
  const staging = await mkdtemp(join(tmpdir(), 'susentorno-ca-'));
  try {
    await cp(join(composeDir, 'ca'), staging, {
      recursive: true,
      filter: (source) => basename(source) !== ROOT_CA_KEY_FILE,
    });
    await docker(join(staging, '.'), `${name}:/etc/envoy/ca`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Remove one color's container if it exists; a no-op when it does not. */
async function removeColor(
  color: Color,
  composeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await execa('docker', ['compose', 'rm', '--stop', '--force', `envoy_${color}`], {
    cwd: composeDir,
    env,
  });
}

/** Stop one color's container (leaves it defined; a later bring-up recreates it). */
export async function stopColor(color: Color, composeDir: string): Promise<void> {
  await execa('docker', ['compose', 'stop', `envoy_${color}`], { cwd: composeDir });
}
