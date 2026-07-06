import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Package root resolved relative to this module. Works both from src/ (vitest runs
 * the TypeScript directly) and from the bundled dist/cli.js (tsup), because each
 * sits exactly one directory below the package root.
 */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function packagedAllowlist(): string {
  return join(packageRoot(), 'current-allow-list.txt');
}
