import { execa } from 'execa';
import type { Color } from './types';

/**
 * True only when this color's Envoy container is currently running. A container
 * that has exited (e.g. Envoy rejected its config and quit) or that does not
 * exist yields false — the signal run-proxy uses to fast-fail instead of waiting
 * out the readiness timeout. Any inspect failure is treated as "not running".
 *
 * The container is named `configamatron-envoy-<color>` (an explicit
 * container_name in the compose template), which is what `docker inspect`
 * matches — the compose *service* name `envoy_<color>` would not resolve here.
 */
export async function isColorRunning(color: Color, composeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'docker',
      ['inspect', '--format', '{{.State.Running}}', `configamatron-envoy-${color}`],
      { cwd: composeDir },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
