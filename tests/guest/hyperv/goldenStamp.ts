import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { goldenStampPath } from './imageCache';

/** Increment when the build pipeline, rather than a seed input, changes. */
export const BUILD_ALGORITHM_VERSION = 1;
export interface GoldenStampInputs {
  userData: string;
  metaData: string;
  grubCfg: string;
  isoUrl: string;
  harnessPublicKey: string;
  guestHostPublicKey: string;
  buildAlgorithmVersion: number;
}
export function computeGoldenStamp(inputs: GoldenStampInputs): string {
  const hash = createHash('sha256');
  for (const value of [
    inputs.userData,
    inputs.metaData,
    inputs.grubCfg,
    inputs.isoUrl,
    inputs.harnessPublicKey,
    inputs.guestHostPublicKey,
    String(inputs.buildAlgorithmVersion),
  ]) {
    hash.update(`${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value, 'utf8');
  }
  return hash.digest('hex');
}
export function readGoldenStamp(): string | null {
  return existsSync(goldenStampPath) ? readFileSync(goldenStampPath, 'utf8').trim() : null;
}
/** Write only after a clean build; a partial image is never cache-valid. */
export function writeGoldenStamp(stamp: string): void {
  writeFileSync(goldenStampPath, `${stamp}\n`);
}
export function clearGoldenStamp(): void {
  rmSync(goldenStampPath, { force: true });
}
