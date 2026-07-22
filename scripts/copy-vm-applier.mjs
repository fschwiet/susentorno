import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'dist', 'apply-home-jq-transforms.js');
for (const share of ['vm-shared', 'vm-shared-windows']) {
  copyFileSync(src, join(root, 'templates', share, 'post-scripts', 'apply-home-jq-transforms.mjs'));
}
console.log('copied apply-home-jq-transforms.mjs into template post-scripts folders');
