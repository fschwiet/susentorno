import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const grandchildScript = fileURLToPath(new URL('./grandchild.mjs', import.meta.url));
const pidFile = process.argv[2];

const child = spawn(process.execPath, [grandchildScript], { stdio: 'ignore' });
writeFileSync(pidFile, String(child.pid));

setInterval(() => {}, 1_000_000);
