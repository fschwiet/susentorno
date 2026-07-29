export interface Allowlist {
  passthrough: string[];
  claudeAuthenticated: string[];
  githubAuthenticated: string[];
  codexAuthenticated: string[];
  authCandidate: string[];
  warnings: string[];
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

type Section =
  | 'passthrough'
  | 'claudeAuthenticated'
  | 'githubAuthenticated'
  | 'codexAuthenticated'
  | 'authCandidate';

export interface ParseAllowlistOptions {
  /**
   * Canonicalized (lowercased) hostnames already reserved by a declared Host MCP
   * server. Any allowlist entry whose host matches one is dropped — MCP precedence —
   * with a warning, using the same drop-the-loser-and-warn mechanism as intra-allowlist
   * collision resolution below. This only runs on a live-watched reload; the initial
   * mcp-servers.yaml-vs-allowlist collision at startup is a separate, fatal check
   * (src/mcpServers.ts).
   */
  reservedMcpHosts?: string[];
}

export function parseAllowlist(content: string, opts: ParseAllowlistOptions = {}): Allowlist {
  const passthrough = new Set<string>();
  const claudeAuthenticated = new Set<string>();
  const githubAuthenticated = new Set<string>();
  const codexAuthenticated = new Set<string>();
  const authCandidate = new Set<string>();
  const warnings = new Set<string>();
  let section: Section | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '#pragma passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '#pragma claude authenticated') {
      section = 'claudeAuthenticated';
      continue;
    }
    if (line === '#pragma github authenticated') {
      section = 'githubAuthenticated';
      continue;
    }
    if (line === '#pragma codex authenticated') {
      section = 'codexAuthenticated';
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
    const noWildcards = section !== 'passthrough'; // terminated sections take exact hosts only

    if (hasWildcard && (noWildcards || !WILDCARD_HOST_PATTERN.test(host))) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'claudeAuthenticated') claudeAuthenticated.add(line);
    else if (section === 'githubAuthenticated') githubAuthenticated.add(line);
    else if (section === 'codexAuthenticated') codexAuthenticated.add(line);
    else authCandidate.add(line);
  }

  const passthroughSet = new Set(prunePassthrough([...passthrough]));

  // Resolve exact host:port strings present in more than one section. Priority:
  // authCandidate > githubAuthenticated > claudeAuthenticated > passthrough. Losing
  // copies are dropped so Envoy emits exactly one filter chain per SNI, and each
  // drop is reported as a warning.
  const byPriority: Array<{ name: string; set: Set<string> }> = [
    { name: 'authCandidate', set: authCandidate },
    { name: 'githubAuthenticated', set: githubAuthenticated },
    { name: 'codexAuthenticated', set: codexAuthenticated },
    { name: 'claudeAuthenticated', set: claudeAuthenticated },
    { name: 'passthrough', set: passthroughSet },
  ];
  const displayOrder = [
    'passthrough',
    'claudeAuthenticated',
    'codexAuthenticated',
    'githubAuthenticated',
    'authCandidate',
  ];

  for (const entry of new Set([
    ...passthroughSet,
    ...claudeAuthenticated,
    ...githubAuthenticated,
    ...codexAuthenticated,
    ...authCandidate,
  ])) {
    const present = byPriority.filter((s) => s.set.has(entry));
    if (present.length < 2) continue;
    const [winner, ...losers] = present; // byPriority is priority-ordered
    for (const loser of losers) loser.set.delete(entry);
    const listed = displayOrder.filter((name) => present.some((p) => p.name === name));
    warnings.add(`collision: '${entry}' listed in ${listed.join(' and ')}; using ${winner.name}`);
  }

  // MCP precedence: a reserved Host MCP server hostname always wins over anything a
  // reloaded allowlist introduces for the same host, so the running proxy keeps a
  // single filter chain per SNI without needing to reissue the leaf or restart the
  // MCP server. Runs after intra-allowlist collision resolution, so at most one
  // section still holds a given entry.
  const reservedMcpHosts = new Set((opts.reservedMcpHosts ?? []).map((h) => h.toLowerCase()));
  if (reservedMcpHosts.size > 0) {
    for (const section of byPriority) {
      for (const entry of [...section.set]) {
        const { host } = splitHostPort(entry);
        const canonicalHost = host.toLowerCase();
        if (!reservedMcpHosts.has(canonicalHost)) continue;
        section.set.delete(entry);
        warnings.add(
          `collision: '${entry}' listed in ${section.name}; using Host MCP server '${canonicalHost}'`,
        );
      }
    }
  }

  return {
    passthrough: [...passthroughSet],
    claudeAuthenticated: [...claudeAuthenticated],
    githubAuthenticated: [...githubAuthenticated],
    codexAuthenticated: [...codexAuthenticated],
    authCandidate: [...authCandidate],
    warnings: [...warnings],
  };
}

/** Hosts the proxy terminates TLS for (the leaf's SANs): claude + github + codex + authCandidate entries on :443, port stripped. */
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return [
    ...allowlist.claudeAuthenticated,
    ...allowlist.githubAuthenticated,
    ...allowlist.codexAuthenticated,
    ...allowlist.authCandidate,
  ]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

/**
 * The full leaf SAN set: the union of `terminateTlsHosts(allowlist)` and the declared
 * Host MCP server hostnames (already-canonicalized, from src/mcpServers.ts records'
 * `.host` field). A guest that already trusts the root CA needs no new certificate
 * when a Host MCP server is added, since its hostname was already folded into the leaf.
 */
export function leafSanHosts(allowlist: Allowlist, mcpServerHosts: string[] = []): string[] {
  return [...new Set([...terminateTlsHosts(allowlist), ...mcpServerHosts])];
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['#pragma passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '#pragma claude authenticated');
  for (const entry of [...allowlist.claudeAuthenticated].sort()) lines.push(entry);
  if (allowlist.githubAuthenticated.length > 0) {
    lines.push('', '#pragma github authenticated');
    for (const entry of [...allowlist.githubAuthenticated].sort()) lines.push(entry);
  }
  if (allowlist.codexAuthenticated.length > 0) {
    lines.push('', '#pragma codex authenticated');
    for (const entry of [...allowlist.codexAuthenticated].sort()) lines.push(entry);
  }
  if (allowlist.authCandidate.length > 0) {
    lines.push('', '#pragma auth candidate');
    for (const entry of [...allowlist.authCandidate].sort()) lines.push(entry);
  }
  lines.push('');
  return lines.join('\n');
}
