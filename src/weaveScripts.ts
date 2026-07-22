import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type ScriptExtension = 'sh' | 'ps1';

const SCRIPT_NAME_RE = /^(nn|[0-9]{2})[-_](.+)\.(sh|ps1)$/;
const SCRIPT_LIKE_RE = /\.(sh|ps1)$/i;

export interface OrderedScript {
  sourcePath: string;
  sourceName: string;
  remainder: string;
  ext: ScriptExtension;
  sentinel: boolean;
}

export interface PassthroughEntry {
  sourcePath: string;
  name: string;
  isDirectory: boolean;
}

export interface FolderContents {
  scripts: OrderedScript[];
  passthrough: PassthroughEntry[];
}

interface ParsedScript extends OrderedScript {
  prefix: string;
}

export interface ReadFolderOptions {
  dir: string;
  extension: ScriptExtension;
  allowSentinel: boolean;
  strictExtension: boolean;
}

export function readFolderContents(opts: ReadFolderOptions): FolderContents {
  const { dir, extension, allowSentinel, strictExtension } = opts;
  if (!existsSync(dir)) return { scripts: [], passthrough: [] };

  const offenders: string[] = [];
  const parsed: ParsedScript[] = [];
  const passthrough: PassthroughEntry[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const sourcePath = join(dir, name);
    if (entry.isDirectory()) {
      passthrough.push({ sourcePath, name, isDirectory: true });
      continue;
    }

    const match = SCRIPT_NAME_RE.exec(name);
    if (match) {
      const prefix = match[1];
      const ext = match[3] as ScriptExtension;
      const sentinel = prefix === 'nn';
      if (sentinel && !allowSentinel) {
        offenders.push(`${name} (reserved 'nn' prefix is only for built-in scripts)`);
        continue;
      }
      if (strictExtension && ext !== extension) {
        offenders.push(`${name} (built-in folder must contain only .${extension} scripts)`);
        continue;
      }
      if (ext !== extension) continue;
      parsed.push({
        sourcePath,
        sourceName: name,
        remainder: `${match[2]}.${match[3]}`,
        ext,
        sentinel,
        prefix,
      });
      continue;
    }

    if (SCRIPT_LIKE_RE.test(name)) {
      offenders.push(`${name} (must match NN[-_]name.(sh|ps1) with a lowercase extension)`);
      continue;
    }
    passthrough.push({ sourcePath, name, isDirectory: false });
  }

  if (offenders.length > 0) {
    throw new Error(`invalid script name(s) in ${dir}:\n  - ${offenders.join('\n  - ')}`);
  }

  parsed.sort(compareScripts);
  return {
    scripts: parsed.map(({ sourcePath, sourceName, remainder, ext, sentinel }) => ({
      sourcePath,
      sourceName,
      remainder,
      ext,
      sentinel,
    })),
    passthrough,
  };
}

function compareScripts(a: ParsedScript, b: ParsedScript): number {
  if (a.sentinel !== b.sentinel) return a.sentinel ? 1 : -1;
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  if (a.sourceName < b.sourceName) return -1;
  if (a.sourceName > b.sourceName) return 1;
  return 0;
}

export interface RenumberedScript {
  sourcePath: string;
  outputName: string;
}

export function renumber(scripts: OrderedScript[]): RenumberedScript[] {
  if (scripts.length > 99) {
    throw new Error(
      `too many scripts after weaving (${scripts.length}); the two-digit prefix caps the total at 99`,
    );
  }
  return scripts.map((script, index) => ({
    sourcePath: script.sourcePath,
    outputName: `${String(index + 1).padStart(2, '0')}-${script.remainder}`,
  }));
}
