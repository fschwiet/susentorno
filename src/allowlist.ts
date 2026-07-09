export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  invalid: string[];
}

const WILDCARD_HOST_PATTERN = /^\*{1,2}\.[^*]+$/;

function splitHostPort(entry: string): { host: string; port: string } {
  const idx = entry.lastIndexOf(':');
  return { host: entry.slice(0, idx), port: entry.slice(idx + 1) };
}

function normalizeWildcardHost(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}

function prunePassthrough(entries: string[]): string[] {
  const wildcardSuffixesByPort = new Map<string, string[]>();
  for (const entry of entries) {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) {
      const suffixes = wildcardSuffixesByPort.get(port) ?? [];
      suffixes.push(host.slice(1)); // "*.ubuntu.com" -> ".ubuntu.com"
      wildcardSuffixesByPort.set(port, suffixes);
    }
  }

  return entries.filter((entry) => {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) return true;
    const suffixes = wildcardSuffixesByPort.get(port);
    return !suffixes?.some((suffix) => host.endsWith(suffix));
  });
}

export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const invalid = new Set<string>();
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
    if (section === null) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');

    if (hasWildcard && (section === 'terminate' || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    const entry = hasWildcard ? `${normalizeWildcardHost(host)}:${splitHostPort(line).port}` : line;
    if (section === 'passthrough') passthrough.add(entry);
    else terminate.add(entry);
  }

  return {
    passthrough: prunePassthrough([...passthrough]),
    terminate: [...terminate],
    invalid: [...invalid],
  };
}

/** Hosts the proxy terminates TLS for (the leaf's SANs): terminate entries on :443, port stripped. */
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return allowlist.terminate
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['# passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '# terminate');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  lines.push('');
  return lines.join('\n');
}
