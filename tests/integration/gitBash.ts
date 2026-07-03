import { existsSync } from 'node:fs';

function resolveFrom(candidates: string[], label: string): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`${label} not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

/**
 * Resolves Git Bash explicitly instead of relying on `bash` from PATH.
 * On Windows, `bash` can resolve to the WSL launcher stub (System32\bash.exe)
 * ahead of Git Bash depending on the invoking shell, and these scripts rely
 * on Git Bash/MSYS2 semantics (Windows-style paths, MSYS2_ARG_CONV_EXCL).
 */
export function gitBashPath(): string {
  return resolveFrom(
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'],
    'Git Bash',
  );
}

/**
 * Resolves Git for Windows' bundled openssl explicitly instead of relying on
 * `openssl` from PATH, which isn't present outside a Git Bash shell (e.g. PowerShell).
 */
export function opensslPath(): string {
  return resolveFrom(
    [
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    ],
    'openssl',
  );
}
