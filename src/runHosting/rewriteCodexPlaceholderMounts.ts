import { readFileSync } from 'node:fs';
import { sanitizeCodexCredentials } from '../sanitizeCodexCredentials';
import { writeFileAtomic } from '../writeFileAtomic';

/**
 * Regenerate the Codex CLI's placeholder mount (auth.json) in every VM share from the
 * host's current ~/.codex/auth.json, through the same sanitizer `init` uses, so for the
 * same host input the files are byte-identical to what `init` writes. Each file is
 * replaced atomically so a Linux guest reading through its symlink into the share never
 * sees a half-written file. Throws on the first failure.
 */
export function rewriteCodexPlaceholderMounts(hostAuthPath: string, mountPaths: string[]): void {
  const sanitized = sanitizeCodexCredentials(readFileSync(hostAuthPath, 'utf8'));
  for (const target of mountPaths) writeFileAtomic(target, sanitized);
}
