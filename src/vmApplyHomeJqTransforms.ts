import { platform as osPlatform } from 'node:process';
import { applyTransforms, type Platform } from './homeJqTransforms';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: apply-home-jq-transforms <transforms-dir>');
  process.exit(2);
}

const platform: Platform = osPlatform === 'win32' ? 'windows' : 'linux';

try {
  const results = applyTransforms({ dir, platform });
  let failed = false;
  for (const r of results) {
    if (r.ok) {
      console.log(
        `apply-home-jq-transforms: ${r.created ? 'created' : 'updated'} ${r.target} (${r.transform})`,
      );
    } else {
      failed = true;
      console.error(`apply-home-jq-transforms: FAILED ${r.transform} -> ${r.target}: ${r.error}`);
    }
  }
  if (results.length === 0) {
    console.log('apply-home-jq-transforms: no transforms for this platform');
  }
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(`apply-home-jq-transforms: ${(error as Error).message}`);
  process.exit(1);
}
