export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  authCandidate: string[];
  invalid: string[];
}

export const WILDCARD_HOST_PATTERN = /^\*\.[^*]+$/;

function splitHostPort(entry: string): { host: string; port: string } {
  const idx = entry.lastIndexOf(':');
  return { host: entry.slice(0, idx), port: entry.slice(idx + 1) };
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
  const authCandidate = new Set<string>();
  const invalid = new Set<string>();
  let section: 'passthrough' | 'terminate' | 'authCandidate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '#pragma passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '#pragma claude authenticated') {
      section = 'terminate';
      continue;
    }
    if (line === '#pragma auth candidate') {
      section = 'authCandidate';
      continue;
    }
    if (line === '# passthrough' || line === '# terminate') {
      const replacement =
        line === '# passthrough' ? '#pragma passthrough' : '#pragma claude authenticated';
      throw new Error(`Legacy allowlist header "${line}"; use "${replacement}"`);
    }
    if (line.startsWith('#pragma ')) {
      throw new Error(`Invalid pragma: "${line}"`);
    }
    if (line.startsWith('#')) continue;
    if (section === null) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');
    const noWildcards = section === 'terminate' || section === 'authCandidate';

    if (hasWildcard && (noWildcards || !WILDCARD_HOST_PATTERN.test(host))) {
      invalid.add(line);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'terminate') terminate.add(line);
    else authCandidate.add(line);
  }

  // A host in both terminate and authCandidate would emit two :443 filter
  // chains with the same SNI, which Envoy rejects at load. Pull the conflict
  // out of both sections and mark it invalid so run-proxy keeps the prior
  // config instead of building a config Envoy refuses.
  for (const entry of [...terminate]) {
    if (authCandidate.has(entry)) {
      terminate.delete(entry);
      authCandidate.delete(entry);
      invalid.add(entry);
    }
  }

  return {
    passthrough: prunePassthrough([...passthrough]),
    terminate: [...terminate],
    authCandidate: [...authCandidate],
    invalid: [...invalid],
  };
}

/** Hosts the proxy terminates TLS for (the leaf's SANs): terminate + authCandidate entries on :443, port stripped. */
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return [...allowlist.terminate, ...allowlist.authCandidate]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['#pragma passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '#pragma claude authenticated');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  if (allowlist.authCandidate.length > 0) {
    lines.push('', '#pragma auth candidate');
    for (const entry of [...allowlist.authCandidate].sort()) lines.push(entry);
  }
  lines.push('');
  return lines.join('\n');
}
