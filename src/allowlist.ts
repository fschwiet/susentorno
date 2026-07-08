export interface Allowlist {
  passthrough: string[];
  terminate: string[];
}

export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  let section: 'passthrough' | 'terminate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '# passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '# terminate') {
      section = 'terminate';
      continue;
    }
    if (line.startsWith('#')) continue;
    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'terminate') terminate.add(line);
  }

  return { passthrough: [...passthrough], terminate: [...terminate] };
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['# passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '# terminate');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  lines.push('');
  return lines.join('\n');
}
