import { checkDockerRunning } from '../checkDockerRunning';
import { checkNoRunningProxy } from '../checkNoRunningProxy';

export default async function setup() {
  // Cheap host-side checks first, matching the VM suite: Docker Desktop down or
  // a live run-proxy fighting this suite for the Envoy containers are the most
  // common self-inflicted failures. The integration suite runs `docker compose
  // down` on the same stack, so a live run-proxy is left serving :80/:443 with
  // no backend — the real VM silently loses egress. Fail fast instead.
  await checkDockerRunning();
  await checkNoRunningProxy();
}
