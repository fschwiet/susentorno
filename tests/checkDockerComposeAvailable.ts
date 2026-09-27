import { execa } from 'execa';

/**
 * Guard (host-side): the proxy stack is driven through `docker compose`. A
 * Docker install without the Compose plugin passes checkDockerRunning and then
 * fails when the stack first starts, far from the cause. Check up front.
 */
export async function checkDockerComposeAvailable(): Promise<void> {
  const result = await execa('docker', ['compose', 'version'], { reject: false, all: true });
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker Compose does not appear to be available (\`docker compose version\` failed):\n${result.all ?? ''}\n` +
        'Install or enable the Docker Compose plugin (it ships with Docker Desktop) and re-run.',
    );
  }
}
