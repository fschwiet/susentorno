import { harness } from './wsl';

export default async function setup() {
  try {
    await harness('preflight.sh');
  } catch (error) {
    const all = (error as { all?: string }).all ?? String(error);
    throw new Error(`VM e2e preflight failed:\n${all}`, { cause: error });
  }
  // No-op when the golden image already exists; first run downloads the cloud
  // image and boots it once for cloud-init (~10-20 min).
  console.log('vm-e2e: ensuring golden image (first run takes 10-20 minutes)...');
  await harness('build-image.sh');
}
