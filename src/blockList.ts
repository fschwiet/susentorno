import { WILDCARD_HOST_PATTERN } from './allowlist';

export interface BlockListFile {
  entries: string[];
  warnings: string[];
}

/** block-list.txt: flat bare hostnames (no port), wildcards allowed, blocks both :80 and :443. */
export function parseBlockListFile(content: string): BlockListFile {
  const entries = new Set<string>();
  const warnings = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.includes(':')) {
      warnings.add(`block-list entries are bare hostnames, no port: excluded '${line}'`);
      continue;
    }
    if (line.includes('*') && !WILDCARD_HOST_PATTERN.test(line)) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }
    entries.add(line);
  }

  return { entries: [...entries], warnings: [...warnings] };
}
