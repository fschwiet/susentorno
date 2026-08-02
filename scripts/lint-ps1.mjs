import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkerScript = join(root, 'scripts', 'check-ps1-syntax.ps1');

const { stdout } = await execa('git', ['ls-files', '--', '*.ps1'], { cwd: root });
const files = stdout
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (files.length === 0) {
  console.log('lint-ps1: no .ps1 files tracked in git');
  process.exit(0);
}

let failed = false;

for (const file of files) {
  const result = await execa(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', checkerScript, '-Path', join(root, file)],
    { cwd: root, reject: false },
  );

  if (result.code === 'ENOENT') {
    console.error(
      'lint-ps1: pwsh not found on PATH — install PowerShell 7+ (https://aka.ms/powershell) to run this check',
    );
    process.exit(1);
  }

  if (result.exitCode !== 0) {
    failed = true;
    console.error(result.stdout || `lint-ps1: ${file} failed to parse (no error detail returned)`);
  }
}

if (failed) {
  console.error('lint-ps1: one or more .ps1 files failed to parse');
  process.exit(1);
}

console.log(`lint-ps1: ${files.length} .ps1 file(s) parsed cleanly`);
