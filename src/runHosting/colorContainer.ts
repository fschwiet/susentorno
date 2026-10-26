import { execa } from 'execa';
import type { Color, ColorPorts } from './types';

/**
 * Force-recreate one color's Envoy container, published on the given host ports.
 * The per-color env vars feed the compose template's `${ENVOY_<COLOR>_*}` port
 * mappings; process.env is inherited so unrelated overrides still flow through.
 * `environmentDir` (the directory that owns .susentorno) becomes the container's
 * `susentorno.environment` label, which verify-proxy.ps1 reads to prove ownership.
 * Runs in composeDir (the environment's .susentorno/proxy folder).
 */
export async function bringUpColor(
  color: Color,
  ports: ColorPorts,
  composeDir: string,
  environmentDir: string,
): Promise<void> {
  const prefix = `ENVOY_${color.toUpperCase()}`;
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', `envoy_${color}`], {
    cwd: composeDir,
    env: {
      ...process.env,
      SUSENTORNO_ENVIRONMENT_DIR: environmentDir,
      [`${prefix}_HTTPS_PORT`]: String(ports.httpsPort),
      [`${prefix}_HTTP_PORT`]: String(ports.httpPort),
      [`${prefix}_ADMIN_PORT`]: String(ports.adminPort),
    },
  });
}

/** Stop one color's container (leaves it defined; a later bring-up recreates it). */
export async function stopColor(color: Color, composeDir: string): Promise<void> {
  await execa('docker', ['compose', 'stop', `envoy_${color}`], { cwd: composeDir });
}
