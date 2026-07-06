import { execa } from 'execa';

/**
 * Recreate the Envoy container so it re-reads the on-disk SDS secret.
 * `--force-recreate` is required: writing the secret does not change the compose
 * config, so a plain `up -d` would leave a running container untouched with its
 * stale in-memory token. Idempotent across absent/running/stopped/dead states.
 * Runs in `composeDir` (the environment's .configamatron/proxy folder, which holds
 * docker-compose.yml); inherits process.env so ENVOY_* port overrides flow through.
 */
export async function recreateContainer(serviceName: string, composeDir: string): Promise<void> {
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', serviceName], {
    cwd: composeDir,
  });
}
