import { execa } from 'execa';
import type { Color, ColorPorts } from './types';

/**
 * Force-recreate one color's Envoy container, published on the given host ports.
 * The per-color env vars feed the compose template's `${ENVOY_<COLOR>_*}` port
 * mappings; process.env is inherited so unrelated overrides still flow through.
 * Runs in composeDir (the environment's .configamatron/proxy folder).
 */
export async function bringUpColor(
  color: Color,
  ports: ColorPorts,
  composeDir: string,
): Promise<void> {
  const prefix = `ENVOY_${color.toUpperCase()}`;
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', `envoy_${color}`], {
    cwd: composeDir,
    env: {
      ...process.env,
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
