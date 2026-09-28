import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GuestScript {
  path: string;
  filename: string;
  slug: string;
}

/**
 * Data describing which filenames are steps: a two-digit prefix, a hyphen, a
 * name, and this extension. Discovery holds no platform knowledge of its own;
 * each platform passes its constant.
 */
export interface StepNaming {
  /** Including the leading dot, e.g. '.sh'. */
  extension: string;
  caseInsensitiveExtension: boolean;
}

// Matches the woven output shape update-shares always produces (see
// src/weaveScripts.ts's renumber(), which builds output names as
// `${NN}-${remainder}` and always uses '-'). The same rule applies to
// pre-scripts/ and post-scripts/ directories alike.
export const UNIX_STEP_NAMING: StepNaming = { extension: '.sh', caseInsensitiveExtension: false };

// PowerShell steps follow the same `NN-name` shape, but Windows treats file
// extensions case-insensitively.
export const WINDOWS_STEP_NAMING: StepNaming = {
  extension: '.ps1',
  caseInsensitiveExtension: true,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stepNameRegExp(naming: StepNaming): RegExp {
  // Only the extension's case is relaxed: the prefix is digits and the name is
  // matched as-is, so the flag cannot change what those parts accept.
  return new RegExp(
    `^(\\d{2})-(.+)${escapeRegExp(naming.extension)}$`,
    naming.caseInsensitiveExtension ? 'i' : '',
  );
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listScripts(dir: string, naming: StepNaming): GuestScript[] {
  const nameRe = stepNameRegExp(naming);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && nameRe.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareOrdinal)
    .map((filename) => {
      const match = nameRe.exec(filename)!;
      return { path: join(dir, filename), filename, slug: match[2] };
    });
}
