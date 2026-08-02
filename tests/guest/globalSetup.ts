import { checkDockerRunning } from '../checkDockerRunning';
import { checkNoRunningProxy } from '../checkNoRunningProxy';
import {
  checkWslDhcpPortIgnored,
  checkWslDistro,
  checkWslMirroredNetworking,
  harness,
} from './wsl';

export default async function setup() {
  // First: instant, needs nothing installed, and they are the most common
  // self-inflicted failures — Docker Desktop not running, or a live run-hosting
  // fighting this suite for the Envoy containers. Everything below is slower
  // and some of it is destructive.
  await checkDockerRunning();
  await checkNoRunningProxy();
  await checkWslDistro();
  try {
    await harness('preflight.sh');
  } catch (error) {
    const all = (error as { all?: string }).all ?? String(error);
    throw new Error(`guest preflight failed:\n${all}`, { cause: error });
  }
  // These two need socat, which preflight.sh just confirmed is installed —
  // and they're cheap, so check them before the slow build-image step below.
  await checkWslMirroredNetworking();
  await checkWslDhcpPortIgnored();
  // No-op when the golden image already exists; first run downloads the cloud
  // image and boots it once for cloud-init (~10-20 min).
  console.log('guest: ensuring golden image (first run takes 10-20 minutes)...');
  await harness('build-image.sh');
}
