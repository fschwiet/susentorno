import { execa } from 'execa';
import type { Color } from './types';

/**
 * True only when this color's Envoy container is up and staying up. A container
 * that has exited, is crash-looping, or does not exist yields false — the signal
 * run-proxy uses to fast-fail instead of waiting out the readiness timeout. Any
 * inspect failure is treated as "not running".
 *
 * We check `.State.Status == "running"` AND `.RestartCount == 0` rather than the
 * more obvious `.State.Running`. The compose template sets
 * `restart: unless-stopped`, so a container whose Envoy keeps rejecting its
 * config CRASH-LOOPS rather than staying dead, and Docker reports
 * `.State.Running == true` for the whole loop (including the restart backoff
 * between crashes). `.RestartCount > 0` is the race-free signal that this
 * container has already died at least once and is not going to serve — a healthy
 * Envoy under this restart policy never exits, so its RestartCount stays 0.
 *
 * The container is named `configamatron-envoy-<color>` (an explicit
 * container_name in the compose template), which is what `docker inspect`
 * matches — the compose *service* name `envoy_<color>` would not resolve here.
 */
export async function isColorRunning(color: Color, composeDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'docker',
      ['inspect', '--format', '{{.State.Status}} {{.RestartCount}}', `configamatron-envoy-${color}`],
      { cwd: composeDir },
    );
    const [status, restarts] = stdout.trim().split(/\s+/);
    return status === 'running' && restarts === '0';
  } catch {
    return false;
  }
}
