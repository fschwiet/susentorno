import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PreScript {
  path: string;
  filename: string;
  slug: string;
}

// Matches the woven output shape update-shares always produces: a two-digit
// prefix, a hyphen, and a .sh extension (see src/weaveScripts.ts's renumber(),
// which builds output names as `${NN}-${remainder}` and always uses '-').
const PRE_SCRIPT_NAME_RE = /^(\d{2})-(.+)\.sh$/;

export function listPreScripts(dir: string): PreScript[] {
  return readdirSync(dir)
    .filter((name) => PRE_SCRIPT_NAME_RE.test(name))
    .sort()
    .map((filename) => {
      const match = PRE_SCRIPT_NAME_RE.exec(filename)!;
      return { path: join(dir, filename), filename, slug: match[2] };
    });
}
