import { execa } from 'execa';

/**
 * Guard (host-side): every integration/VM suite eventually shells out to
 * `docker`/`docker compose` (directly or via run-proxy). If the Docker Desktop
 * engine is not up, those calls fail deep inside a test with an opaque
 * ECONNREFUSED/exit-1, far from the real cause. Check up front and fail fast
 * with a message that names the fix.
 */
export async function checkDockerRunning(): Promise<void> {
  const result = await execa('docker', ['info'], { reject: false, all: true });
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker does not appear to be running (\`docker info\` failed):\n${result.all ?? ''}\n` +
        'Start Docker Desktop and re-run.',
    );
  }
}
