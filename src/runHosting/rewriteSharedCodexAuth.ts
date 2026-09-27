import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { sanitizeCodexCredentials } from '../sanitizeCodexCredentials';

/**
 * Regenerate every VM-shared codex auth.json from the host's current ~/.codex/auth.json,
 * through the same sanitizer `init` uses, so for the same host input the files are
 * byte-identical to what `init` writes. Each file is replaced atomically (temp file in
 * the same directory, then rename) so a Linux guest reading through its symlink into the
 * share never sees a half-written file. Throws on the first failure.
 */
export function rewriteSharedCodexAuth(hostAuthPath: string, sharedAuthPaths: string[]): void {
  const sanitized = sanitizeCodexCredentials(readFileSync(hostAuthPath, 'utf8'));
  for (const target of sharedAuthPaths) {
    const temp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, sanitized);
      renameSync(temp, target);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
  }
}
