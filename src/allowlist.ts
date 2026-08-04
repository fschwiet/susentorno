export interface Allowlist {
  passthrough: string[];
  claudeAuthenticated: string[];
  githubAuthenticated: string[];
  codexAuthenticated: string[];
  authCandidate: string[];
  blocked: string[];
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
      suffixes.push(host.slice(1));
      wildcardSuffixesByPort.set(port, suffixes);
    }
  }
  return entries.filter((entry) => {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) return true;
    return !wildcardSuffixesByPort.get(port)?.some((suffix) => host.endsWith(suffix));
  });
}

export interface AllowListFile {
  entries: string[];
  warnings: string[];
}

export function parseAllowListFile(content: string): AllowListFile {
  const entries = new Set<string>();
  const warnings = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const { host } = splitHostPort(line);
    if (host.includes('*') && !WILDCARD_HOST_PATTERN.test(host)) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }
    entries.add(line);
  }
  return { entries: prunePassthrough([...entries]), warnings: [...warnings] };
}

export interface AuthListFile {
  claudeAuthenticated: string[];
  githubAuthenticated: string[];
  codexAuthenticated: string[];
  authCandidate: string[];
  warnings: string[];
}

type AuthSection =
  | 'claudeAuthenticated'
  | 'githubAuthenticated'
  | 'codexAuthenticated'
  | 'authCandidate';

export function parseAuthListFile(content: string): AuthListFile {
  const claudeAuthenticated = new Set<string>();
  const githubAuthenticated = new Set<string>();
  const codexAuthenticated = new Set<string>();
  const authCandidate = new Set<string>();
  const warnings = new Set<string>();
  let section: AuthSection | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
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
    if (line === '# terminate') {
      throw new Error('Legacy allowlist header "# terminate"; use "#pragma claude authenticated"');
    }
    if (line.startsWith('#pragma ')) throw new Error(`Invalid pragma: "${line}"`);
    if (line.startsWith('#') || section === null) continue;

    const { host } = splitHostPort(line);
    if (host.includes('*')) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }
    if (section === 'claudeAuthenticated') claudeAuthenticated.add(line);
    else if (section === 'githubAuthenticated') githubAuthenticated.add(line);
    else if (section === 'codexAuthenticated') codexAuthenticated.add(line);
    else authCandidate.add(line);
  }

  return {
    claudeAuthenticated: [...claudeAuthenticated],
    githubAuthenticated: [...githubAuthenticated],
    codexAuthenticated: [...codexAuthenticated],
    authCandidate: [...authCandidate],
    warnings: [...warnings],
  };
}

export interface BlockListFile {
  entries: string[];
  warnings: string[];
}

function isBlocked(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))));
}

export function combinePolicy(
  allowList: AllowListFile,
  authList: AuthListFile,
  blockList: BlockListFile,
): Allowlist {
  const passthrough = new Set(allowList.entries);
  const claudeAuthenticated = new Set(authList.claudeAuthenticated);
  const githubAuthenticated = new Set(authList.githubAuthenticated);
  const codexAuthenticated = new Set(authList.codexAuthenticated);
  const authCandidate = new Set(authList.authCandidate);
  const warnings = new Set([...allowList.warnings, ...authList.warnings, ...blockList.warnings]);
  const sections: Array<{ name: string; set: Set<string> }> = [
    { name: 'passthrough', set: passthrough },
    { name: 'claudeAuthenticated', set: claudeAuthenticated },
    { name: 'githubAuthenticated', set: githubAuthenticated },
    { name: 'codexAuthenticated', set: codexAuthenticated },
    { name: 'authCandidate', set: authCandidate },
  ];
  for (const { name, set } of sections) {
    for (const entry of [...set]) {
      const { host } = splitHostPort(entry);
      if (isBlocked(host, blockList.entries)) {
        set.delete(entry);
        warnings.add(`blocked: '${entry}' removed from ${name} (matches block-list.txt)`);
      }
    }
  }

  const passthroughSet = new Set(prunePassthrough([...passthrough]));
  const byPriority: Array<{ name: string; set: Set<string> }> = [
    { name: 'authCandidate', set: authCandidate },
    { name: 'githubAuthenticated', set: githubAuthenticated },
    { name: 'codexAuthenticated', set: codexAuthenticated },
    { name: 'claudeAuthenticated', set: claudeAuthenticated },
    { name: 'passthrough', set: passthroughSet },
  ];
  const displayOrder = ['passthrough', 'claudeAuthenticated', 'codexAuthenticated', 'githubAuthenticated', 'authCandidate'];
  for (const entry of new Set([...passthroughSet, ...claudeAuthenticated, ...githubAuthenticated, ...codexAuthenticated, ...authCandidate])) {
    const present = byPriority.filter((section) => section.set.has(entry));
    if (present.length < 2) continue;
    const [winner, ...losers] = present;
    for (const loser of losers) loser.set.delete(entry);
    const listed = displayOrder.filter((name) => present.some((section) => section.name === name));
    warnings.add(`collision: '${entry}' listed in ${listed.join(' and ')}; using ${winner.name}`);
  }

  return {
    passthrough: [...passthroughSet],
    claudeAuthenticated: [...claudeAuthenticated],
    githubAuthenticated: [...githubAuthenticated],
    codexAuthenticated: [...codexAuthenticated],
    authCandidate: [...authCandidate],
    blocked: [...blockList.entries],
    warnings: [...warnings],
  };
}

export function terminateTlsHosts(
  allowlist: Pick<Allowlist, 'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'>,
): string[] {
  return [
    ...allowlist.claudeAuthenticated,
    ...allowlist.githubAuthenticated,
    ...allowlist.codexAuthenticated,
    ...allowlist.authCandidate,
  ]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

export function formatAllowListFile(entries: string[]): string {
  return [...entries].sort().concat('').join('\n');
}

export function formatAuthListFile(
  authList: Pick<Allowlist, 'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'>,
): string {
  const lines: string[] = ['#pragma claude authenticated'];
  for (const entry of [...authList.claudeAuthenticated].sort()) lines.push(entry);
  if (authList.githubAuthenticated.length > 0) {
    lines.push('', '#pragma github authenticated');
    for (const entry of [...authList.githubAuthenticated].sort()) lines.push(entry);
  }
  if (authList.codexAuthenticated.length > 0) {
    lines.push('', '#pragma codex authenticated');
    for (const entry of [...authList.codexAuthenticated].sort()) lines.push(entry);
  }
  if (authList.authCandidate.length > 0) {
    lines.push('', '#pragma auth candidate');
    for (const entry of [...authList.authCandidate].sort()) lines.push(entry);
  }
  lines.push('');
  return lines.join('\n');
}
