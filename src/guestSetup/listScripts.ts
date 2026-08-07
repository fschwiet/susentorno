import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GuestScript {
  path: string;
  filename: string;
  slug: string;
}

// Matches the woven output shape update-shares always produces: a two-digit
// prefix, a hyphen, and a .sh extension (see src/weaveScripts.ts's renumber(),
// which builds output names as `${NN}-${remainder}` and always uses '-'). The
// same rule applies to pre-scripts/ and post-scripts/ directories alike.
const SCRIPT_NAME_RE = /^(\d{2})-(.+)\.sh$/;

export function listScripts(dir: string): GuestScript[] {
  return readdirSync(dir)
    .filter((name) => SCRIPT_NAME_RE.test(name))
    .sort()
    .map((filename) => {
      const match = SCRIPT_NAME_RE.exec(filename)!;
      return { path: join(dir, filename), filename, slug: match[2] };
    });
}
