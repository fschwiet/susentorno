# Allow/Auth/Block List Split + `--skip-allow-list` Implementation Plan

**Goal:** Replace `.susentorno/proxy/allowlist.txt` with three files — `allow-list.txt` (plain passthrough hosts), `auth-list.txt` (credential-injection/auth-candidate hosts, same pragma format as today), and `block-list.txt` (hosts that are always denied, overriding the other two) — and add a `run-hosting --skip-allow-list` flag that turns off allow-list enforcement (block-list and auth-list stay enforced), with access-log tags extended so a host let through only because of the flag is visibly distinguishable.

**Architecture:** `src/allowlist.ts` splits its single `parseAllowlist` into `parseAllowListFile` (flat), `parseAuthListFile` (pragma-sectioned, unchanged shape minus passthrough), and a new `combinePolicy` that prunes block-list matches before running the existing cross-section collision priority. A new `src/blockList.ts` parses `block-list.txt`. `Allowlist` gains a `blocked: string[]` field that `src/envoyConfig.ts` turns into explicit deny chains/routes (always present) and an open-passthrough default branch (only under `--skip-allow-list`). `src/runHosting/{parseLine,classify,formatOutput}.ts` gain two new tags (`ALLOW OPEN`, `BLOCK LIST`) and print `domain:port` on every line, with port-80 lines distinguished by a new Envoy route-name field since that listener shares one access log across routes.

**Tech Stack:** TypeScript (Node.js CLI, `commander`), Envoy static config generation (plain JS objects serialized to YAML via the `yaml` package), Vitest for unit/CLI/integration tests, Docker Compose for the real-Envoy integration suite under `tests/proxy-stack/`.

## Global Constraints

- No migration path for an existing `.susentorno/proxy/allowlist.txt` — it is left on disk, untouched, and no longer read by any code path.
- `allow-list.txt`/`block-list.txt` use no pragma headers; `auth-list.txt` keeps today's exact pragma format and error tiers (unrecognized pragma throws; bad wildcard is a warning+drop).
- `block-list.txt` entries are bare hostnames (no port), wildcards allowed in the existing single-leading-`*.` form; a line with a `:port` suffix is a warned, dropped malformed entry.
- Hostname matching stays exact-string / case-sensitive everywhere — no new canonicalization.
- Block-list pruning always runs, regardless of `--skip-allow-list`; auth-list entries are never affected by `--skip-allow-list`; MCP hostnames (`mcp-servers.yaml`) are exempt from block-list pruning (a wildcard block naturally still yields to Envoy's more-specific MCP chain; an exact collision is explicitly resolved in `mcpServers.ts`, MCP winning, with a warning).
- Every access-log line prints `domain:port`, not a bare domain, for every tag.
- `writeEnvoyConfig`/`generateEnvoyConfig` gain a `skipAllowList` option; `runHostingLoop.ts`/`RunHostingConfig` do **not** need to know about it — `--skip-allow-list` is constant for a whole `run-hosting` run and is threaded in entirely from `src/commands/runHosting.ts`'s existing closure.

---

## Task 1: `block-list.txt` parser

**Files:**

- Create: `src/blockList.ts`
- Test: `tests/unit/blockList.test.ts`

**Interfaces:**

- Produces: `parseBlockListFile(content: string): { entries: string[]; warnings: string[] }` — used by Task 2's `combinePolicy` and Task 9's `runHostingLoop.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseBlockListFile } from '../../src/blockList';

describe('block-list parsing', () => {
  it('parses bare hostnames, one per line', () => {
    const content = ['self.events.data.microsoft.com', '*.doubleclick.net', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com', '*.doubleclick.net'],
      warnings: [],
    });
  });

  it('ignores blank lines and comment lines', () => {
    const content = ['# a comment', '', 'self.events.data.microsoft.com', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com'],
      warnings: [],
    });
  });

  it('dedupes repeated entries', () => {
    const content = ['self.events.data.microsoft.com', 'self.events.data.microsoft.com', ''].join(
      '\n',
    );
    expect(parseBlockListFile(content)).toEqual({
      entries: ['self.events.data.microsoft.com'],
      warnings: [],
    });
  });

  it('warns and drops an entry with a port suffix', () => {
    const content = ['self.events.data.microsoft.com:443', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: [],
      warnings: [
        "block-list entries are bare hostnames, no port: excluded 'self.events.data.microsoft.com:443'",
      ],
    });
  });

  it('accepts a single leading *.host wildcard', () => {
    expect(parseBlockListFile('*.doubleclick.net\n')).toEqual({
      entries: ['*.doubleclick.net'],
      warnings: [],
    });
  });

  it('warns and drops a **.host wildcard instead of normalizing it', () => {
    const content = ['**.doubleclick.net', 'ads.example.com', ''].join('\n');
    expect(parseBlockListFile(content)).toEqual({
      entries: ['ads.example.com'],
      warnings: ["unsupported wildcard syntax, excluded: '**.doubleclick.net'"],
    });
  });

  it('warns and drops a mid-string wildcard', () => {
    expect(parseBlockListFile('bad*.example.com\n')).toEqual({
      entries: [],
      warnings: ["unsupported wildcard syntax, excluded: 'bad*.example.com'"],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/blockList.test.ts`
Expected: FAIL — `Cannot find module '../../src/blockList'`

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/blockList.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/blockList.ts tests/unit/blockList.test.ts
git commit -m "feat(policy): add block-list.txt parser"
```

---

## Task 2: Split `allowlist.ts` into allow-list/auth-list parsers + `combinePolicy`

**Files:**

- Modify: `src/allowlist.ts`
- Modify: `tests/unit/allowlist.test.ts` (full rewrite)

**Interfaces:**

- Consumes: `parseBlockListFile` from Task 1 (`../../src/blockList` in the test; `./blockList` in source is not needed — `combinePolicy` takes an already-parsed `BlockListFile`, not a path).
- Produces (replacing today's `parseAllowlist`/`formatAllowlist`):
  - `Allowlist` interface, now with `blocked: string[]` added.
  - `parseAllowListFile(content: string): { entries: string[]; warnings: string[] }`
  - `parseAuthListFile(content: string): { claudeAuthenticated: string[]; githubAuthenticated: string[]; codexAuthenticated: string[]; authCandidate: string[]; warnings: string[] }`
  - `combinePolicy(allowList, authList, blockList): Allowlist`
  - `terminateTlsHosts(allowlist: Pick<Allowlist, 'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'>): string[]` (signature narrowed so callers can pass just an auth-list parse result)
  - `formatAllowListFile(entries: string[]): string`
  - `formatAuthListFile(authList: Pick<Allowlist, 'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'>): string`
  - `WILDCARD_HOST_PATTERN` (unchanged, still exported — Task 1 imports it)
  - These are used by: Task 3 (`mcpServers.ts`), Task 4 (`policyFile.ts`/`importSbxNetworkPolicy.ts`), Task 5 (`generateCa.ts`), Task 9 (`runHostingLoop.ts`), Task 10 (`envoyConfig.ts` via the `Allowlist.blocked` field), and the templates/init tests in Task 6–7.

- [ ] **Step 1: Write the failing tests (full replacement of `tests/unit/allowlist.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import {
  parseAllowListFile,
  parseAuthListFile,
  combinePolicy,
  formatAllowListFile,
  formatAuthListFile,
  terminateTlsHosts,
  type Allowlist,
} from '../../src/allowlist';
import { parseBlockListFile } from '../../src/blockList';

const noBlocks = parseBlockListFile('');

describe('allow-list parsing (allow-list.txt)', () => {
  it('parses flat host:port lines with no pragma header', () => {
    const content = ['*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({
      entries: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      warnings: [],
    });
  });

  it('ignores blank lines and comment lines, including a stray #pragma line', () => {
    const content = ['#pragma passthrough', '## a free-text comment', 'pypi.org:443', ''].join(
      '\n',
    );
    expect(parseAllowListFile(content)).toEqual({ entries: ['pypi.org:443'], warnings: [] });
  });

  it('drops an exact-duplicate line, keeping first-occurrence order', () => {
    const content = ['archive.ubuntu.com:80', '*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join(
      '\n',
    );
    expect(parseAllowListFile(content)).toEqual({
      entries: ['archive.ubuntu.com:80', '*.chatgpt.com:443'],
      warnings: [],
    });
  });

  it('flags a **.host wildcard as invalid instead of normalizing it', () => {
    const content = ['**.ubuntu.com:80', 'archive.ubuntu.com:80', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({
      entries: ['archive.ubuntu.com:80'],
      warnings: ["unsupported wildcard syntax, excluded: '**.ubuntu.com:80'"],
    });
  });

  it('flags a mid-string wildcard as invalid instead of treating it as passthrough', () => {
    const content = ['crl*.digicert.com:80', 'archive.ubuntu.com:80', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({
      entries: ['archive.ubuntu.com:80'],
      warnings: ["unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'"],
    });
  });

  it('prunes an exact entry covered by a same-port wildcard', () => {
    const content = ['*.ubuntu.com:80', 'archive.ubuntu.com:80', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({ entries: ['*.ubuntu.com:80'], warnings: [] });
  });

  it('does not prune an exact entry at a different port than the wildcard', () => {
    const content = ['*.ubuntu.com:80', 'archive.ubuntu.com:443', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({
      entries: ['*.ubuntu.com:80', 'archive.ubuntu.com:443'],
      warnings: [],
    });
  });

  it("does not prune the wildcard's own bare base domain, since it is not a subdomain", () => {
    const content = ['*.ubuntu.com:80', 'ubuntu.com:80', ''].join('\n');
    expect(parseAllowListFile(content)).toEqual({
      entries: ['*.ubuntu.com:80', 'ubuntu.com:80'],
      warnings: [],
    });
  });
});

describe('auth-list parsing (auth-list.txt)', () => {
  it('splits entries into claude/github/codex/auth-candidate sections', () => {
    const content = [
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
      '#pragma github authenticated',
      'github.com:443',
      'api.github.com:443',
      '',
      '#pragma codex authenticated',
      'chatgpt.com:443',
      '',
      '#pragma auth candidate',
      'partner.example.com:443',
      '',
    ].join('\n');

    expect(parseAuthListFile(content)).toEqual({
      claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      codexAuthenticated: ['chatgpt.com:443'],
      authCandidate: ['partner.example.com:443'],
      warnings: [],
    });
  });

  it('throws on an unrecognized #pragma line', () => {
    expect(() => parseAuthListFile('#pragma bogus\n')).toThrow('Invalid pragma: "#pragma bogus"');
  });

  it('throws a migration hint on the legacy # terminate header', () => {
    expect(() => parseAuthListFile('# terminate\napi.anthropic.com:443\n')).toThrow(
      'Legacy allowlist header "# terminate"; use "#pragma claude authenticated"',
    );
  });

  it('still ignores non-pragma comment lines', () => {
    const content = [
      '#pragma claude authenticated',
      '## a free-text comment',
      'api.anthropic.com:443',
      '',
    ].join('\n');
    expect(parseAuthListFile(content).claudeAuthenticated).toEqual(['api.anthropic.com:443']);
  });

  it('ignores a line before any section header', () => {
    const content = [
      'orphan.example.com:443',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
    ].join('\n');
    expect(parseAuthListFile(content).claudeAuthenticated).toEqual(['api.anthropic.com:443']);
  });

  it('flags any wildcard as invalid — auth-list.txt takes exact hosts only', () => {
    const content = [
      '#pragma claude authenticated',
      '*.anthropic.com:443',
      'api.anthropic.com:443',
      '',
    ].join('\n');
    expect(parseAuthListFile(content)).toEqual({
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      warnings: ["unsupported wildcard syntax, excluded: '*.anthropic.com:443'"],
    });
  });

  it('drops an exact-duplicate line within a section, keeping first-occurrence order', () => {
    const content = [
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');
    expect(parseAuthListFile(content).claudeAuthenticated).toEqual([
      'api.anthropic.com:443',
      'claude.com:443',
    ]);
  });
});

describe('formatting', () => {
  it('formats allow-list.txt as sorted flat lines', () => {
    expect(formatAllowListFile(['archive.ubuntu.com:80', '*.chatgpt.com:443'])).toBe(
      ['*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join('\n'),
    );
  });

  it('formats auth-list.txt with sorted, present-only sections', () => {
    const authList = {
      claudeAuthenticated: ['claude.com:443', 'api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
    };
    expect(formatAuthListFile(authList)).toBe(
      ['#pragma claude authenticated', 'api.anthropic.com:443', 'claude.com:443', ''].join('\n'),
    );
  });

  it('includes github/codex/auth-candidate sections only when non-empty', () => {
    const authList = {
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      codexAuthenticated: ['chatgpt.com:443'],
      authCandidate: ['b.example.com:443', 'a.example.com:443'],
    };
    expect(formatAuthListFile(authList)).toBe(
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma github authenticated',
        'api.github.com:443',
        'github.com:443',
        '',
        '#pragma codex authenticated',
        'chatgpt.com:443',
        '',
        '#pragma auth candidate',
        'a.example.com:443',
        'b.example.com:443',
        '',
      ].join('\n'),
    );
  });
});

describe('combinePolicy', () => {
  it('combines a plain allow-list and auth-list with no collisions or blocks', () => {
    const allowList = parseAllowListFile(['*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join('\n'));
    const authList = parseAuthListFile(
      ['#pragma claude authenticated', 'api.anthropic.com:443', 'claude.com:443', ''].join('\n'),
    );
    expect(combinePolicy(allowList, authList, noBlocks)).toEqual({
      passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
      claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
      warnings: [],
    });
  });

  describe('collision resolution', () => {
    it('resolves a passthrough+claudeAuthenticated collision to claudeAuthenticated with a warning', () => {
      const allowList = parseAllowListFile('shared.example.com:443\n');
      const authList = parseAuthListFile(
        ['#pragma claude authenticated', 'shared.example.com:443', ''].join('\n'),
      );
      expect(combinePolicy(allowList, authList, noBlocks)).toEqual({
        passthrough: [],
        claudeAuthenticated: ['shared.example.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: [
          "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated",
        ],
      });
    });

    it('resolves a host present in passthrough, claude, and auth-candidate to authCandidate, naming all three', () => {
      const allowList = parseAllowListFile('shared.example.com:443\n');
      const authList = parseAuthListFile(
        [
          '#pragma claude authenticated',
          'shared.example.com:443',
          '',
          '#pragma auth candidate',
          'shared.example.com:443',
          '',
        ].join('\n'),
      );
      expect(combinePolicy(allowList, authList, noBlocks)).toEqual({
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: ['shared.example.com:443'],
        blocked: [],
        warnings: [
          "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated and authCandidate; using authCandidate",
        ],
      });
    });

    it('does not treat a wildcard-covered claude-authenticated host as a collision', () => {
      const allowList = parseAllowListFile('*.example.com:443\n');
      const authList = parseAuthListFile(
        ['#pragma claude authenticated', 'foo.example.com:443', ''].join('\n'),
      );
      expect(combinePolicy(allowList, authList, noBlocks).warnings).toEqual([]);
    });
  });

  describe('block-list pruning', () => {
    it('removes a matching allow-list entry before collision resolution runs, with a warning', () => {
      const allowList = parseAllowListFile('blocked.example.com:443\n');
      const authList = parseAuthListFile('');
      const blockList = parseBlockListFile('blocked.example.com\n');
      expect(combinePolicy(allowList, authList, blockList)).toEqual({
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: ['blocked.example.com'],
        warnings: [
          "blocked: 'blocked.example.com:443' removed from passthrough (matches block-list.txt)",
        ],
      });
    });

    it('removes a matching auth-list entry, not just passthrough', () => {
      const allowList = parseAllowListFile('');
      const authList = parseAuthListFile(
        ['#pragma claude authenticated', 'blocked.example.com:443', ''].join('\n'),
      );
      const blockList = parseBlockListFile('blocked.example.com\n');
      const result = combinePolicy(allowList, authList, blockList);
      expect(result.claudeAuthenticated).toEqual([]);
      expect(result.warnings).toEqual([
        "blocked: 'blocked.example.com:443' removed from claudeAuthenticated (matches block-list.txt)",
      ]);
    });

    it('a wildcard block pattern removes matching subdomains but not the bare base domain', () => {
      const allowList = parseAllowListFile(
        ['ads.doubleclick.net:443', 'doubleclick.net:443', ''].join('\n'),
      );
      const authList = parseAuthListFile('');
      const blockList = parseBlockListFile('*.doubleclick.net\n');
      const result = combinePolicy(allowList, authList, blockList);
      expect(result.passthrough).toEqual(['doubleclick.net:443']);
    });

    it('removes an entry that is both blocked and involved in a collision, emitting only the block warning', () => {
      const allowList = parseAllowListFile('shared.example.com:443\n');
      const authList = parseAuthListFile(
        ['#pragma claude authenticated', 'shared.example.com:443', ''].join('\n'),
      );
      const blockList = parseBlockListFile('shared.example.com\n');
      expect(combinePolicy(allowList, authList, blockList)).toEqual({
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: ['shared.example.com'],
        warnings: [
          "blocked: 'shared.example.com:443' removed from passthrough (matches block-list.txt)",
          "blocked: 'shared.example.com:443' removed from claudeAuthenticated (matches block-list.txt)",
        ],
      });
    });
  });
});

describe('terminateTlsHosts', () => {
  it('returns claude-authenticated :443 hosts without the port and excludes passthrough', () => {
    const authList = parseAuthListFile(
      ['#pragma claude authenticated', 'api.anthropic.com:443', 'claude.com:443', ''].join('\n'),
    );
    expect(terminateTlsHosts(authList)).toEqual(['api.anthropic.com', 'claude.com']);
  });

  it('ignores non-:443 entries', () => {
    expect(
      terminateTlsHosts({
        claudeAuthenticated: ['example.com:80'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
      }),
    ).toEqual([]);
  });

  it('includes auth candidate :443 hosts alongside claude hosts', () => {
    const authList = parseAuthListFile(
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma auth candidate',
        'partner.example.com:443',
        '',
      ].join('\n'),
    );
    expect(terminateTlsHosts(authList)).toEqual(['api.anthropic.com', 'partner.example.com']);
  });

  it('includes github and codex :443 hosts', () => {
    const authList = parseAuthListFile(
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma github authenticated',
        'github.com:443',
        'api.github.com:443',
        '',
        '#pragma codex authenticated',
        'chatgpt.com:443',
        '',
      ].join('\n'),
    );
    expect(terminateTlsHosts(authList)).toEqual([
      'api.anthropic.com',
      'github.com',
      'api.github.com',
      'chatgpt.com',
    ]);
  });

  it('accepts the fully combined Allowlist shape too', () => {
    const combined: Allowlist = {
      passthrough: ['pypi.org:443'],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
      warnings: [],
    };
    expect(terminateTlsHosts(combined)).toEqual(['api.anthropic.com']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/allowlist.test.ts`
Expected: FAIL — `parseAllowListFile`/`parseAuthListFile`/`combinePolicy`/`formatAllowListFile`/`formatAuthListFile` are not exported yet.

- [ ] **Step 3: Rewrite `src/allowlist.ts`**

Replace the entire file with:

```ts
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

export interface AllowListFile {
  entries: string[];
  warnings: string[];
}

/** allow-list.txt: flat `host:port` lines, wildcards allowed, no pragma headers. */
export function parseAllowListFile(content: string): AllowListFile {
  const entries = new Set<string>();
  const warnings = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');
    if (hasWildcard && !WILDCARD_HOST_PATTERN.test(host)) {
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

/** auth-list.txt: `#pragma`-sectioned, exact hosts only (no wildcards). */
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
    if (line.startsWith('#pragma ')) {
      throw new Error(`Invalid pragma: "${line}"`);
    }
    if (line.startsWith('#')) continue;
    if (section === null) continue;

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

function isBlocked(host: string, blockPatterns: string[]): boolean {
  for (const pattern of blockPatterns) {
    if (pattern === host) return true;
    if (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * Combine an allow-list, auth-list, and block-list parse into the resolved policy
 * `generateEnvoyConfig` consumes. Block-list pruning runs first (dropping any
 * allow/auth entry whose host matches a block pattern, with a warning), then the
 * existing cross-section collision priority — `auth candidate` > `github
 * authenticated` > `codex authenticated` > `claude authenticated` > passthrough —
 * runs on what's left, exactly as it did when all of this lived in one file.
 */
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

  // Resolve exact host:port strings present in more than one section. Priority:
  // authCandidate > githubAuthenticated > codexAuthenticated > claudeAuthenticated
  // > passthrough. Losing copies are dropped so Envoy emits exactly one filter
  // chain per SNI, and each drop is reported as a warning.
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

/** Hosts the proxy terminates TLS for (the leaf's SANs): claude + github + codex + authCandidate entries on :443, port stripped. */
export function terminateTlsHosts(
  allowlist: Pick<
    Allowlist,
    'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'
  >,
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
  const lines = [...entries].sort();
  lines.push('');
  return lines.join('\n');
}

export function formatAuthListFile(
  authList: Pick<
    Allowlist,
    'claudeAuthenticated' | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'
  >,
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/allowlist.test.ts`
Expected: PASS (all tests). Note this leaves other files that still import `parseAllowlist`/`formatAllowlist` broken — that's expected until Tasks 3–14 land; the project will not typecheck cleanly until then. Do not attempt `pnpm typecheck`, `pnpm build`, or `pnpm test` until Task 16.

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "feat(policy): split allowlist.ts into allow-list/auth-list parsers + combinePolicy"
```

---

## Task 3: MCP hostnames are exempt from block-list pruning

**Files:**

- Modify: `src/mcpServers.ts`
- Modify: `tests/unit/mcpServers.test.ts`

**Interfaces:**

- Consumes: `Allowlist` from Task 2 (now has `blocked: string[]`).
- Produces: `resolveMcpAllowlistCollisions(allowlist: Allowlist, servers: McpServerConfig[]): Allowlist` — same name/signature as today, now also resolves an exact block-list/MCP-hostname collision. Consumed unchanged by Task 9 (`runHostingLoop.ts`).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/mcpServers.test.ts`, update `baseAllowlist` to add the new field:

```ts
  const baseAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: [],
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    blocked: [],
    warnings: [],
  };
```

(This replaces the existing `baseAllowlist` literal, which is missing `blocked: []`.)

Append, after the existing `describe('resolveMcpAllowlistCollisions', ...)` block:

```ts
describe('resolveMcpAllowlistCollisions — block-list', () => {
  it('removes an exact block-list entry that collides with an MCP hostname and warns', () => {
    const allowlist: Allowlist = {
      ...baseAllowlist,
      blocked: ['filesystem.internal', 'other.blocked'],
    };
    const servers = [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.blocked).toEqual(['other.blocked']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal' listed in block-list.txt and mcp-servers.yaml; MCP servers are not subject to block-list pruning, so it stays reachable",
    ]);
  });

  it('leaves a wildcard block-list entry in place but still warns when it matches an MCP hostname', () => {
    const allowlist: Allowlist = { ...baseAllowlist, blocked: ['*.internal'] };
    const servers = [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.blocked).toEqual(['*.internal']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal' listed in block-list.txt and mcp-servers.yaml; MCP servers are not subject to block-list pruning, so it stays reachable",
    ]);
  });

  it('does not warn when a wildcard block-list entry does not match any MCP hostname', () => {
    const allowlist: Allowlist = { ...baseAllowlist, blocked: ['*.other'] };
    const servers = [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.blocked).toEqual(['*.other']);
    expect(resolved.warnings).toEqual([]);
  });

  it('does not modify or warn when there is no block-list collision', () => {
    const allowlist: Allowlist = { ...baseAllowlist, blocked: ['unrelated.example.com'] };
    const servers = [{ name: 'fs', hostname: 'fs.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved).toEqual(allowlist);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/mcpServers.test.ts`
Expected: FAIL — `resolved.blocked` is `undefined` (the current `resolveMcpAllowlistCollisions` doesn't copy or use `blocked` at all), and the file also currently fails to typecheck since `baseAllowlist` lacks `blocked`.

- [ ] **Step 3: Update `src/mcpServers.ts`**

Replace the `resolveMcpAllowlistCollisions` function with:

```ts
export function resolveMcpAllowlistCollisions(
  allowlist: Allowlist,
  servers: McpServerConfig[],
): Allowlist {
  const resolved: Allowlist = {
    passthrough: [...allowlist.passthrough],
    claudeAuthenticated: [...allowlist.claudeAuthenticated],
    githubAuthenticated: [...allowlist.githubAuthenticated],
    codexAuthenticated: [...allowlist.codexAuthenticated],
    authCandidate: [...allowlist.authCandidate],
    blocked: [...allowlist.blocked],
    warnings: [...allowlist.warnings],
  };

  for (const server of servers) {
    const entry = `${server.hostname}:443`;
    for (const [key, label] of ALLOWLIST_SECTIONS) {
      const list = resolved[key];
      const idx = list.indexOf(entry);
      if (idx === -1) continue;
      list.splice(idx, 1);
      resolved.warnings.push(
        `collision: '${entry}' listed in ${label} and mcp-servers.yaml; using mcp-servers.yaml`,
      );
    }

    // Block-list is never allowed to remove a declared MCP server's own chain: an
    // exact block-list entry equal to this hostname would otherwise produce two
    // :443 filter chains matching the same SNI, so it's the one case removed here.
    // A wildcard block pattern needs no removal — Envoy always prefers the more
    // specific exact MCP chain over a wildcard block chain for the same SNI — but
    // the mismatch is still surfaced as a warning either way, since a maintainer
    // reading block-list.txt would otherwise have no way to know it doesn't apply.
    const blockedIdx = resolved.blocked.indexOf(server.hostname);
    const matchingWildcard = resolved.blocked.some(
      (pattern) => pattern.startsWith('*.') && server.hostname.endsWith(pattern.slice(1)),
    );
    if (blockedIdx === -1 && !matchingWildcard) continue;
    if (blockedIdx !== -1) resolved.blocked.splice(blockedIdx, 1);
    resolved.warnings.push(
      `collision: '${server.hostname}' listed in block-list.txt and mcp-servers.yaml; ` +
        'MCP servers are not subject to block-list pruning, so it stays reachable',
    );
  }

  return resolved;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/mcpServers.test.ts`
Expected: PASS (all tests, including the 4 new ones and the pre-existing ones now that `baseAllowlist` has `blocked: []`).

- [ ] **Step 5: Commit**

```bash
git add src/mcpServers.ts tests/unit/mcpServers.test.ts
git commit -m "feat(policy): exempt MCP hostnames from block-list pruning"
```

---

## Task 4: `policyFile.ts` + `import-sbx-network-policy` write two files

**Files:**

- Modify: `src/policyFile.ts`
- Modify: `src/commands/importSbxNetworkPolicy.ts`
- Modify: `tests/unit/policyFile.test.ts`
- Modify: `tests/cli/importSbxNetworkPolicy.test.ts`

**Interfaces:**

- Consumes: `formatAllowListFile`, `formatAuthListFile` from Task 2.
- Produces: `parsePolicyFile` keeps its existing signature/shape (now including `blocked: []`); `import-sbx-network-policy` gets `--allow-output <path>` (default `current-allow-list.txt`) and `--auth-output <path>` (default `current-auth-list.txt`) instead of the single `-o, --output <path>`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/policyFile.test.ts`, add `blocked: [],` to each of the three `toEqual({...})` literals (after `authCandidate: [],` and before `warnings: [...]`), e.g. the first becomes:

```ts
      expect(parsePolicyFile(content)).toEqual({
        passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
        claudeAuthenticated: ['api.anthropic.com:443', 'claude.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: [],
      });
```

Apply the same one-line insertion to the other two `toEqual` blocks in that file.

Replace `tests/cli/importSbxNetworkPolicy.test.ts` in full with:

```ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('susentorno import-sbx-network-policy', () => {
  it('warns in help that import-sbx-network-policy regeneration drops comments', async () => {
    const { stdout, exitCode } = await execa('node', [
      cliPath,
      'import-sbx-network-policy',
      '--help',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      'does not preserve customizations since last import, including hand-added comments',
    );
  });

  it('parses a policy file into current-allow-list.txt and current-auth-list.txt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toBe(
        ['*.chatgpt.com:443', 'archive.ubuntu.com:80', ''].join('\n'),
      );
      expect(readFileSync(join(dir, 'current-auth-list.txt'), 'utf8')).toBe(
        ['#pragma claude authenticated', 'api.anthropic.com:443', 'claude.com:443', ''].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns and skips unsupported wildcard patterns but still writes both files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toContain('foo*.bar.com:443');
      const written = readFileSync(join(dir, 'current-allow-list.txt'), 'utf8');
      expect(written).toContain('*.chatgpt.com:443');
      expect(written).not.toContain('foo*.bar.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to --allow-output and --auth-output when given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'susentorno-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

    try {
      const { exitCode } = await execa(
        'node',
        [
          cliPath,
          'import-sbx-network-policy',
          fixturePath,
          '--allow-output',
          'my-allow.txt',
          '--auth-output',
          'my-auth.txt',
        ],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'my-allow.txt'), 'utf8')).toContain('*.chatgpt.com:443');
      expect(readFileSync(join(dir, 'my-auth.txt'), 'utf8')).toContain('api.anthropic.com:443');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/policyFile.test.ts`
Expected: FAIL — `blocked` missing from `parsePolicyFile`'s actual return value.

(The CLI test can't run yet — `dist/cli.js` doesn't reflect source changes until built; it will be exercised at the end of Step 4 below and again in Task 16's full build.)

- [ ] **Step 3: Update `src/policyFile.ts` and `src/commands/importSbxNetworkPolicy.ts`**

In `src/policyFile.ts`, change the final return statement from:

```ts
  return {
    passthrough: [...passthrough].sort(),
    claudeAuthenticated: [...claudeAuthenticated].sort(),
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    warnings: [...warnings].sort(),
  };
```

to:

```ts
  return {
    passthrough: [...passthrough].sort(),
    claudeAuthenticated: [...claudeAuthenticated].sort(),
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    blocked: [],
    warnings: [...warnings].sort(),
  };
```

Replace `src/commands/importSbxNetworkPolicy.ts` in full with:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parsePolicyFile } from '../policyFile';
import { formatAllowListFile, formatAuthListFile } from '../allowlist';

export function registerImportSbxNetworkPolicy(program: Command): void {
  program
    .command('import-sbx-network-policy')
    .configureHelp({ helpWidth: 300 })
    .description(
      'Maintainer command: parse a network policy file into current-allow-list.txt and ' +
        'current-auth-list.txt (the tracked default allow list and auth list copied into ' +
        'environments by init). Regeneration does not preserve customizations since last ' +
        'import, including hand-added comments.',
    )
    .argument('<policyFile>', 'path to the source policy file')
    .option('--allow-output <path>', 'output allow list path', 'current-allow-list.txt')
    .option('--auth-output <path>', 'output auth list path', 'current-auth-list.txt')
    .action((policyFile: string, options: { allowOutput: string; authOutput: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      for (const warning of allowlist.warnings) {
        console.warn(`import-sbx-network-policy: ${warning}`);
      }
      writeFileSync(options.allowOutput, formatAllowListFile(allowlist.passthrough));
      writeFileSync(
        options.authOutput,
        formatAuthListFile({
          claudeAuthenticated: allowlist.claudeAuthenticated,
          githubAuthenticated: allowlist.githubAuthenticated,
          codexAuthenticated: allowlist.codexAuthenticated,
          authCandidate: allowlist.authCandidate,
        }),
      );
    });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/unit/policyFile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policyFile.ts src/commands/importSbxNetworkPolicy.ts tests/unit/policyFile.test.ts tests/cli/importSbxNetworkPolicy.test.ts
git commit -m "feat(policy): import-sbx-network-policy writes allow-list and auth-list separately"
```

(The `importSbxNetworkPolicy.test.ts` CLI test runs against `dist/cli.js`, which isn't rebuilt until Task 16 — leave it staged/committed now; it will be verified then.)

---

## Task 5: `envPaths.ts` — three paths instead of one

**Files:**

- Modify: `src/envPaths.ts`
- Modify: `tests/unit/envPaths.test.ts`

**Interfaces:**

- Produces: `EnvPaths.allowList: string` (`.susentorno/proxy/allow-list.txt`), `EnvPaths.authList: string` (`.susentorno/proxy/auth-list.txt`), `EnvPaths.blockList: string` (`.susentorno/proxy/block-list.txt`) — replacing `EnvPaths.allowlist`. Consumed by Tasks 7, 8, 9.

- [ ] **Step 1: Write the failing test**

In `tests/unit/envPaths.test.ts`, replace:

```ts
      expect(paths.allowlist).toBe(join(root, 'proxy', 'allowlist.txt'));
```

with:

```ts
      expect(paths.allowList).toBe(join(root, 'proxy', 'allow-list.txt'));
      expect(paths.authList).toBe(join(root, 'proxy', 'auth-list.txt'));
      expect(paths.blockList).toBe(join(root, 'proxy', 'block-list.txt'));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — `paths.allowList` is `undefined`.

- [ ] **Step 3: Update `src/envPaths.ts`**

Replace:

```ts
  proxy: string;
  allowlist: string;
  mcpServers: string;
```

with:

```ts
  proxy: string;
  allowList: string;
  authList: string;
  blockList: string;
  mcpServers: string;
```

Replace:

```ts
    proxy,
    allowlist: join(proxy, 'allowlist.txt'),
    mcpServers: join(root, 'mcp-servers.yaml'),
```

with:

```ts
    proxy,
    allowList: join(proxy, 'allow-list.txt'),
    authList: join(proxy, 'auth-list.txt'),
    blockList: join(proxy, 'block-list.txt'),
    mcpServers: join(root, 'mcp-servers.yaml'),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/envPaths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat(policy): envPaths exposes allow-list.txt, auth-list.txt, block-list.txt"
```

---

## Task 6: Repo-root seed files (`current-*-list.txt`) + `templates.ts`

**Files:**

- Modify: `src/templates.ts`
- Modify: `current-allow-list.txt` (rewrite: plain lines, no pragma header)
- Create: `current-auth-list.txt`
- Create: `current-block-list.txt`
- Modify: `package.json`
- Modify: `tests/unit/templates.test.ts`

**Interfaces:**

- Produces: `packagedAllowList(): string`, `packagedAuthList(): string`, `packagedBlockList(): string` — replacing `packagedAllowlist()`. Consumed by Task 7 (`init.ts`).

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, replace:

```ts
import { packagedAllowlist, templatesDir } from '../../src/templates';
import { loadManifest } from '../../src/homeJqTransforms';
import { parseAllowlist } from '../../src/allowlist';
```

with:

```ts
import {
  packagedAllowList,
  packagedAuthList,
  packagedBlockList,
  templatesDir,
} from '../../src/templates';
import { loadManifest } from '../../src/homeJqTransforms';
import { parseAllowListFile, parseAuthListFile } from '../../src/allowlist';
```

Replace:

```ts
    it('ships the packaged allowlist', () => {
      expect(existsSync(packagedAllowlist())).toBe(true);
    });

    it('ships chatgpt.com under codex authenticated, not passthrough', () => {
      const parsed = parseAllowlist(readFileSync(packagedAllowlist(), 'utf8'));
      expect(parsed.codexAuthenticated).toContain('chatgpt.com:443');
      expect(parsed.passthrough).not.toContain('chatgpt.com:443');
      expect(parsed.passthrough).toContain('*.chatgpt.com:443');
    });
```

with:

```ts
    it('ships the packaged allow list, auth list, and block list', () => {
      expect(existsSync(packagedAllowList())).toBe(true);
      expect(existsSync(packagedAuthList())).toBe(true);
      expect(existsSync(packagedBlockList())).toBe(true);
    });

    it('ships chatgpt.com under codex authenticated, not the allow list', () => {
      const authList = parseAuthListFile(readFileSync(packagedAuthList(), 'utf8'));
      const allowList = parseAllowListFile(readFileSync(packagedAllowList(), 'utf8'));
      expect(authList.codexAuthenticated).toContain('chatgpt.com:443');
      expect(allowList.entries).not.toContain('chatgpt.com:443');
      expect(allowList.entries).toContain('*.chatgpt.com:443');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/templates.test.ts`
Expected: FAIL — `packagedAuthList`/`packagedBlockList` are not exported, and `current-auth-list.txt`/`current-block-list.txt` don't exist yet.

- [ ] **Step 3: Update `src/templates.ts`, rewrite `current-allow-list.txt`, create the two new seed files, update `package.json`**

Replace the end of `src/templates.ts`:

```ts
export function packagedAllowlist(): string {
  return join(packageRoot(), 'current-allow-list.txt');
}
```

with:

```ts
export function packagedAllowList(): string {
  return join(packageRoot(), 'current-allow-list.txt');
}

export function packagedAuthList(): string {
  return join(packageRoot(), 'current-auth-list.txt');
}

export function packagedBlockList(): string {
  return join(packageRoot(), 'current-block-list.txt');
}
```

Rewrite `current-allow-list.txt` (repo root) to keep only the plain passthrough content, with the `#pragma passthrough` header removed and everything from `#pragma github authenticated` onward removed (that content moves to the new `current-auth-list.txt` below). The file becomes:

```
## ubunto unblocked specifically for connectivity-check.ubuntu.com
*.ubuntu.com:443
*.ubuntu.com:80
ubuntu.com:443
ubuntu.com:80

##
github.githubassets.com:443
assets-proxy.anthropic.com:443
a-cdn.anthropic.com:443
s-cdn.anthropic.com:443
a-cdn.claude.ai:443
s-cdn.claude.ai:443
assets.claude.ai:443

mcp.context7.com:443
learn.microsoft.com:443

api.nuget.org:443
*.vscode-cdn.net:443
*.gallerycdn.vsassets.io:443
*.gallery.vsassets.io:443
*.core.windows.net:443

# Windows
cdn.winget.microsoft.com:443
storeedgefd.dsx.mp.microsoft.com:443

## misc
cdn.fwupd.org:443
cdn.playwright.dev:443
*.datadoghq.com:443
playwright.download.prss.microsoft.com:443
api.snapcraft.io:443
unofficial-builds.nodejs.org:443
cdn.tailwindcss.com:443

## original passthrough entries

*.amazonaws.com:443
*.amazontrust.com:443
*.amazontrust.com:80
*.bun.sh:443
*.chatgpt.com:443
*.cursor.sh:443
*.data.mcr.microsoft.com:443
*.debian.org:443
*.docker.com:443
*.docker.io:443
*.factory.ai:443
*.gcr.io:443
*.github.com:443
*.githubcopilot.com:443
*.githubusercontent.com:443
*.gitlab.com:443
*.googleapis.com:443
*.googleusercontent.com:443
*.gradle.org:443
*.gstatic.com:443
*.gvt1.com:443
*.hashicorp.com:443
*.lencr.org:443
*.lencr.org:80
*.oaistatic.com:443
*.oaiusercontent.com:443
*.openai.com:443
*.packagist.org:443
*.pki.goog:443
*.pki.goog:80
*.pki.microsoft.com:443
*.pki.microsoft.com:80
*.production.cloudflare.docker.com:443
*.production.cloudfront.docker.com:443
*.public.blob.vercel-storage.com:443
*.visualstudio.com:443
*.yarnpkg.com:443
*.one.au.digicert.com:80
*.one.ch.digicert.com:80
*.one.digicert.co.jp:80
*.one.digicert.com:80
*.one.nl.digicert.com:80
alpinelinux.org:443
apache.org:443
api.perplexity.ai:443
api.workos.com:443
apis.google.com:443
app.daytona.io:443
apt.llvm.org:443
archive.ubuntu.com:443
archive.ubuntu.com:80
archlinux.org:443
astral.sh:443
azure.com:443
binaries.prisma.sh:443
bitbucket.org:443
bootstrap.pypa.io:443
bun.sh:443
cacerts.digicert.com:80
cdn.openaimerge.com:443
centos.org:443
challenges.cloudflare.com:443
clerk.com:443
cocoapods.org:443
cpan.org:443
crates.io:443
crl.comodoca.com:80
crl.globalsign.com:80
crl.globalsign.net:80
crl.sectigo.com:80
crl.usertrust.com:80
crt.sectigo.com:80
csp.withgoogle.com:443
cursor.com:443
debian.org:443
dev.azure.com:443
dhi.io:443
dl-cdn.alpinelinux.org:443
dl.google.com:443
docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com:443
docker.com:443
docker.io:443
dot.net:443
dotnet.microsoft.com:443
eclipse.org:443
factory.ai:443
fastly.com:443
fedoraproject.org:443
figma.com:443
files.pythonhosted.org:443
gcr.io:443
gemini.google.com:443
generativelanguage.googleapis.com:443
ghcr.io:443
gitlab.com:443
golang.org:443
goproxy.io:443
gradle.org:443
hashicorp.com:443
haskell.org:443
hex.pm:443
index.crates.io:443
isrg.trustid.ocsp.identrust.com:80
java.com:443
java.net:443
jsdelivr.net:443
json-schema.org:443
json.schemastore.org:443
k8s.io:443
launchpad.net:443
login.microsoftonline.com:443
maven.org:443
mcr.microsoft.com:443
metacpan.org:443
mise-versions.jdx.dev:443
mise.run:443
models.dev:443
nodejs.org:443
nodesource.com:443
npm.duckdb.org:443
npmjs.com:443
npmjs.org:443
nuget.org:443
ocsp.comodoca.com:80
ocsp.digicert.com:80
ocsp.globalsign.com:443
ocsp.globalsign.com:80
ocsp.sectigo.com:80
ocsp.usertrust.com:80
ocsp2.globalsign.com:443
ocsp2.globalsign.com:80
packagecloud.io:443
packages.microsoft.com:443
packagist.com:443
packagist.org:443
pkg.go.dev:443
play.google.com:443
play.googleapis.com:443
playwright.azureedge.net:443
ports.ubuntu.com:443
ports.ubuntu.com:80
ppa.launchpad.net:443
production.cloudflare.docker.com:443
production.cloudfront.docker.com:443
proxy.golang.org:443
pub.dev:443
public.ecr.aws:443
pypa.io:443
pypi.org:443
pypi.python.org:443
pythonhosted.org:443
quay.io:443
registry.k8s.io:443
registry.npmjs.org:443
repo.maven.apache.org:443
ruby-lang.org:443
rubygems.org:443
rubyonrails.org:443
rustup.rs:443
rvm.io:443
security.ubuntu.com:443
security.ubuntu.com:80
sh.rustup.rs:443
sourceforge.net:443
spring.io:443
static.crates.io:443
static.rust-lang.org:443
sum.golang.org:443
supabase.com:443
swift.org:443
tuf-repo-cdn.sigstore.dev:443
ubuntu.com:443
unpkg.com:443
vercel.com:443
visualstudio.com:443
www.google.com:443
yarnpkg.com:443
ziglang.org:443
```

Create `current-auth-list.txt` (repo root) with the sections extracted from the old file's `#pragma github authenticated`/`#pragma claude authenticated`/`#pragma codex authenticated` sections:

```
#pragma claude authenticated
api.anthropic.com:443
claude.com:443
downloads.claude.ai:443
mcp-proxy.anthropic.com:443
platform.claude.com:443
statsig.anthropic.com:443

# added after original import from sandbox
claude.ai:443
a.claude.ai:443
a-api.anthropic.com:443

#pragma github authenticated
api.github.com:443
github.com:443

#pragma codex authenticated
chatgpt.com:443
```

Create `current-block-list.txt` (repo root), seeded with one entry to demonstrate the format:

```
self.events.data.microsoft.com
```

In `package.json`, replace:

```json
  "files": [
    "dist",
    "templates",
    "current-allow-list.txt"
  ],
```

with:

```json
  "files": [
    "dist",
    "templates",
    "current-allow-list.txt",
    "current-auth-list.txt",
    "current-block-list.txt"
  ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/templates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/templates.ts current-allow-list.txt current-auth-list.txt current-block-list.txt package.json tests/unit/templates.test.ts
git commit -m "feat(policy): split current-allow-list.txt into allow/auth/block seed files"
```

---

## Task 7: `init` scaffolds all three files

**Files:**

- Modify: `src/initEnv.ts`
- Modify: `src/commands/init.ts`
- Modify: `templates/susentorno.gitignore`
- Modify: `tests/unit/initEnv.test.ts`
- Modify: `tests/unit/gitignore.test.ts`
- Modify: `tests/cli/init.test.ts`

**Interfaces:**

- Consumes: `packagedAllowList`, `packagedAuthList`, `packagedBlockList` from Task 6; `EnvPaths.allowList/authList/blockList` from Task 5.
- Produces: `InitOptions.allowListSource/authListSource/blockListSource: string` — replacing `InitOptions.allowlistSource`.

**Note:** `templates/susentorno.gitignore` currently re-includes only `!/proxy/allowlist.txt` (everything else under `.susentorno/` is ignored by default). Without updating it, the three new files this task starts writing into `.susentorno/proxy/` would silently stay untracked in every real environment. This is caught here rather than left as a Task 16 surprise.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/initEnv.test.ts`, replace:

```ts
import { templatesDir, packagedAllowlist } from '../../src/templates';
```

with:

```ts
import { templatesDir, packagedAllowList, packagedAuthList, packagedBlockList } from '../../src/templates';
```

Replace the `options()` helper:

```ts
function options(overrides: Partial<Parameters<typeof initEnvironment>[0]> = {}) {
  return {
    cwd: dir,
    credentialsPath: credentialsFixture,
    codexCredentialsPath: authFixture,
    templatesDir: templatesDir(),
    allowlistSource: packagedAllowlist(),
    ...overrides,
  };
}
```

with:

```ts
function options(overrides: Partial<Parameters<typeof initEnvironment>[0]> = {}) {
  return {
    cwd: dir,
    credentialsPath: credentialsFixture,
    codexCredentialsPath: authFixture,
    templatesDir: templatesDir(),
    allowListSource: packagedAllowList(),
    authListSource: packagedAuthList(),
    blockListSource: packagedBlockList(),
    ...overrides,
  };
}
```

Replace, in the file-existence list inside `'copies vm-shared-linux and proxy templates, the allowlist, and sanitized credentials'`:

```ts
        'proxy/allowlist.txt',
```

with:

```ts
        'proxy/allow-list.txt',
        'proxy/auth-list.txt',
        'proxy/block-list.txt',
```

In `tests/cli/init.test.ts`, replace:

```ts
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'allowlist.txt'))).toBe(true);
```

with:

```ts
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'allow-list.txt'))).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'auth-list.txt'))).toBe(true);
      expect(existsSync(join(dir, '.susentorno', 'proxy', 'block-list.txt'))).toBe(true);
```

In `tests/unit/gitignore.test.ts`, replace:

```ts
        '!/proxy/',
        '!/proxy/allowlist.txt',
      ]) {
```

with:

```ts
        '!/proxy/',
        '!/proxy/allow-list.txt',
        '!/proxy/auth-list.txt',
        '!/proxy/block-list.txt',
      ]) {
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npx vitest run tests/unit/initEnv.test.ts tests/unit/gitignore.test.ts`
Expected: FAIL — `initEnvironment` doesn't accept `allowListSource`/`authListSource`/`blockListSource` yet and doesn't write the three files; `templates/susentorno.gitignore` doesn't re-include the two new file names yet.

- [ ] **Step 3: Update `src/initEnv.ts`, `src/commands/init.ts`, and `templates/susentorno.gitignore`**

In `src/initEnv.ts`, replace:

```ts
export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  codexCredentialsPath: string;
  templatesDir: string;
  allowlistSource: string;
}
```

with:

```ts
export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  codexCredentialsPath: string;
  templatesDir: string;
  allowListSource: string;
  authListSource: string;
  blockListSource: string;
}
```

Replace:

```ts
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  copyFileSync(join(options.templatesDir, 'mcp-servers.yaml'), paths.mcpServers);
```

with:

```ts
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowListSource, paths.allowList);
  copyFileSync(options.authListSource, paths.authList);
  copyFileSync(options.blockListSource, paths.blockList);
  copyFileSync(join(options.templatesDir, 'mcp-servers.yaml'), paths.mcpServers);
```

In `src/commands/init.ts`, replace:

```ts
import { packagedAllowlist, templatesDir } from '../templates';
```

with:

```ts
import { packagedAllowList, packagedAuthList, packagedBlockList, templatesDir } from '../templates';
```

Replace:

```ts
        initEnvironment({
          cwd: process.cwd(),
          credentialsPath: options.credentials,
          codexCredentialsPath: options.codexCredentials,
          templatesDir: templatesDir(),
          allowlistSource: packagedAllowlist(),
        });
```

with:

```ts
        initEnvironment({
          cwd: process.cwd(),
          credentialsPath: options.credentials,
          codexCredentialsPath: options.codexCredentials,
          templatesDir: templatesDir(),
          allowListSource: packagedAllowList(),
          authListSource: packagedAuthList(),
          blockListSource: packagedBlockList(),
        });
```

In `templates/susentorno.gitignore`, replace:

```
!/proxy/
!/proxy/allowlist.txt
!/mcp-servers.yaml
```

with:

```
!/proxy/
!/proxy/allow-list.txt
!/proxy/auth-list.txt
!/proxy/block-list.txt
!/mcp-servers.yaml
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/initEnv.test.ts tests/unit/gitignore.test.ts`
Expected: PASS

(`tests/cli/init.test.ts` runs against the built CLI — verified in Task 16.)

- [ ] **Step 5: Commit**

```bash
git add src/initEnv.ts src/commands/init.ts templates/susentorno.gitignore tests/unit/initEnv.test.ts tests/unit/gitignore.test.ts tests/cli/init.test.ts
git commit -m "feat(policy): init scaffolds allow-list.txt, auth-list.txt, block-list.txt"
```

---

## Task 8: `generate-ca` derives SANs from `auth-list.txt` only

**Files:**

- Modify: `src/commands/generateCa.ts`

**Interfaces:**

- Consumes: `parseAuthListFile`, `terminateTlsHosts` from Task 2; `EnvPaths.authList` from Task 5.

No test changes are needed: `tests/cli/generateCa.test.ts` exercises this indirectly through `init` + `generate-ca`, asserting the resulting leaf's SANs include `api.anthropic.com`/`claude.com` — those hosts live in `current-auth-list.txt` (Task 6) exactly as they lived in `current-allow-list.txt`'s claude-authenticated section before, so the existing assertions keep passing unchanged once this task and Task 16's rebuild land.

- [ ] **Step 1: Update `src/commands/generateCa.ts`**

Replace:

```ts
import { parseAllowlist, terminateTlsHosts } from '../allowlist';

function deriveSans(paths: EnvPaths): string[] {
  if (!existsSync(paths.allowlist)) return [];
  return terminateTlsHosts(parseAllowlist(readFileSync(paths.allowlist, 'utf8')));
}
```

with:

```ts
import { parseAuthListFile, terminateTlsHosts } from '../allowlist';

function deriveSans(paths: EnvPaths): string[] {
  if (!existsSync(paths.authList)) return [];
  return terminateTlsHosts(parseAuthListFile(readFileSync(paths.authList, 'utf8')));
}
```

Also update the command's user-facing description — replace:

```ts
    .description(
      'Generate the proxy root CA and the leaf it signs into .susentorno/proxy/ca, copy the ' +
        'root cert.pem into vm-shared-linux, and derive the leaf SANs from the allowlist sections the ' +
        'proxy terminates TLS for. Reuses existing valid material; reissues the leaf without ' +
        'touching the root.',
    )
```

with:

```ts
    .description(
      'Generate the proxy root CA and the leaf it signs into .susentorno/proxy/ca, copy the ' +
        'root cert.pem into vm-shared-linux, and derive the leaf SANs from the auth-list.txt sections ' +
        'the proxy terminates TLS for. Reuses existing valid material; reissues the leaf without ' +
        'touching the root.',
    )
```

- [ ] **Step 2: This task has no dedicated new test — verified via Task 16's full suite run**

Skip straight to commit; `tests/cli/generateCa.test.ts` will confirm this works once Task 16 rebuilds the CLI and runs the full suite.

- [ ] **Step 3: Commit**

```bash
git add src/commands/generateCa.ts
git commit -m "feat(policy): generate-ca derives leaf SANs from auth-list.txt"
```

---

## Task 9: `envoyConfig.ts` — block-list chains/routes, `--skip-allow-list`, empty-chain fix

This is the largest single task: it wires the `Allowlist.blocked` field into real Envoy config, adds the `--skip-allow-list` default-branch toggle at both listeners, fixes a latent bug where an empty allow list would accidentally make the 443 passthrough chain match everything, and switches the port-80 access log to a route-name-based format so the shared HTTP connection manager can distinguish matched/blocked/default-deny/open routes in one log stream.

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Consumes: `Allowlist` (with `blocked: string[]`) from Task 2.
- Produces: `BuildEnvoyConfigOptions.skipAllowList?: boolean` (new). The generated config's port-80 access log format gains an 11th field (`%ROUTE_NAME%`) — consumed by Task 10 (`parseLine.ts`).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/proxyConfig.test.ts`, add `blocked: [],` (after `authCandidate: [...],` and before `warnings: [],`) to each of the 5 existing `Allowlist` object literals in the file: the top-level `allowlist` const (near line 15), the `wildcardAllowlist` inside `'routes wildcard :80 hosts...'` (near line 146), `candAllowlist` (near line 303), `ghAllowlist` (near line 391), and `codexAllowlist` (near line 498).

Then append these new `describe` blocks inside `describe('proxy configuration generation', ...)`, after the existing `describe('default deny chain', ...)` block:

```ts
  describe('block-list routing', () => {
    const blockedAllowlist: Allowlist = {
      ...allowlist,
      blocked: ['blocked.example.com', '*.blocked-wild.com'],
    };

    it('adds a 443 filter chain matching block-list hosts, routed to the blackhole cluster', () => {
      const config = generateEnvoyConfig(blockedAllowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const blockChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('blocked.example.com'),
      );
      expect(blockChain).toBeDefined();
      expect(blockChain.filter_chain_match.server_names).toContain('*.blocked-wild.com');
      const tcp = blockChain.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      ).typed_config;
      expect(tcp.cluster).toBe('blackhole');
      const log = tcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
      expect(log).toMatch(/^CFGM\|blocklist\|/);
    });

    it('omits the block-list 443 chain when block-list.txt is empty', () => {
      const config = generateEnvoyConfig(allowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const hasBlockChain = listener443.filter_chains.some((fc: any) =>
        fc.filters?.some((f: any) =>
          f.typed_config?.access_log?.[0]?.typed_config?.log_format?.text_format_source?.inline_string?.startsWith(
            'CFGM|blocklist|',
          ),
        ),
      );
      expect(hasBlockChain).toBe(false);
    });

    it('adds an 80 vhost matching block-list hosts, returning 403 with route name "blocked"', () => {
      const config = generateEnvoyConfig(blockedAllowlist) as any;
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
      const hcm = listener80.filter_chains[0].filters[0].typed_config;
      const vhost = hcm.route_config.virtual_hosts.find((v: any) =>
        v.domains.includes('blocked.example.com'),
      );
      expect(vhost).toBeDefined();
      expect(vhost.domains).toContain('*.blocked-wild.com');
      expect(vhost.routes[0].name).toBe('blocked');
      expect(vhost.routes[0].direct_response.status).toBe(403);
    });
  });

  describe('--skip-allow-list', () => {
    it('replaces the 443 default_filter_chain with an open SNI passthrough tagged passopen', () => {
      const config = generateEnvoyConfig(allowlist, { skipAllowList: true }) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const fallback = listener443.default_filter_chain;
      const tcp = fallback.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      ).typed_config;
      expect(tcp.cluster).toBe('dynamic_forward_proxy_cluster');
      const log = tcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
      expect(log).toMatch(/^CFGM\|passopen\|/);
    });

    it('replaces the 80 default route with an open proxy route named "open"', () => {
      const config = generateEnvoyConfig(allowlist, { skipAllowList: true }) as any;
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
      const hcm = listener80.filter_chains[0].filters[0].typed_config;
      const defaultVhost = hcm.route_config.virtual_hosts.find((v: any) =>
        v.domains.includes('*'),
      );
      expect(defaultVhost.routes[0].name).toBe('open');
      expect(defaultVhost.routes[0].route.cluster).toBe('dynamic_forward_proxy_cluster_http');
      expect(hcm.http_filters.map((f: any) => f.name)).toContain(
        'envoy.filters.http.dynamic_forward_proxy',
      );
    });

    it('still blocks a block-list host even with --skip-allow-list set', () => {
      const blockedAllowlist: Allowlist = { ...allowlist, blocked: ['blocked.example.com'] };
      const config = generateEnvoyConfig(blockedAllowlist, { skipAllowList: true }) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const blockChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('blocked.example.com'),
      );
      expect(blockChain).toBeDefined();
      const tcp = blockChain.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      ).typed_config;
      expect(tcp.cluster).toBe('blackhole');
    });

    it('does not add the dynamic-forward-proxy http filter/cluster when skip-allow-list is off and there are no wildcard :80 entries', () => {
      const config = generateEnvoyConfig(allowlist) as any;
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
      const hcm = listener80.filter_chains[0].filters[0].typed_config;
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
    });
  });

  describe('empty allow list', () => {
    const emptyAllowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
      warnings: [],
    };

    it('omits the 443 passthrough chain entirely instead of emitting one with an empty server_names list', () => {
      const config = generateEnvoyConfig(emptyAllowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const hasEmptyMatchChain = listener443.filter_chains.some(
        (fc: any) => fc.filter_chain_match && fc.filter_chain_match.server_names.length === 0,
      );
      expect(hasEmptyMatchChain).toBe(false);
      // Since nothing matches, the default_filter_chain (blackhole) is what runs.
      const fallback = listener443.default_filter_chain;
      const tcp = fallback.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      ).typed_config;
      expect(tcp.cluster).toBe('blackhole');
    });
  });
```

Also update the existing `'tags every path with a CFGM access log to stdout, including response/duration/bytes fields'` test (and any other assertion reading the port-80 access log's literal format string) if it inspects the `http` access log's field list — check its body; if it asserts `.toContain('%BYTES_SENT%')` or similar for the `http` path, that assertion still holds true, since the new format keeps every existing field and only appends `%ROUTE_NAME%` — no change needed there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: FAIL — `skipAllowList` option unused, `blocked` unused, no block-list chains/vhosts emitted, `default_filter_chain` never becomes an open passthrough, empty passthrough chain still emitted with an empty `server_names` array.

- [ ] **Step 3: Update `src/envoyConfig.ts`**

Replace:

```ts
export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
  /**
   * Test-only. `crash-config` sets the admin port out of range so Envoy rejects
   * the bootstrap and exits; `never-ready` moves admin off container port 9901
   * so Envoy stays healthy but the admin probe is refused forever.
   */
  fault?: InjectFault;
  mcpServers?: McpServerUpstream[];
}
```

with:

```ts
export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
  /**
   * Test-only. `crash-config` sets the admin port out of range so Envoy rejects
   * the bootstrap and exits; `never-ready` moves admin off container port 9901
   * so Envoy stays healthy but the admin probe is refused forever.
   */
  fault?: InjectFault;
  mcpServers?: McpServerUpstream[];
  /** When set, hosts matched by neither the allow list nor auth list pass through
   * instead of being denied. Block-list entries are always denied regardless. */
  skipAllowList?: boolean;
}
```

Replace the `DYNAMIC_FORWARD_PROXY_HTTP_CACHE`/`buildWildcardHttp80VirtualHost` block:

```ts
const DYNAMIC_FORWARD_PROXY_HTTP_CACHE = 'dynamic_forward_proxy_cache_config_http';

function buildWildcardHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'http_wildcard',
    domains: hosts,
    routes: [{ match: { prefix: '/' }, route: { cluster: 'dynamic_forward_proxy_cluster_http' } }],
  };
}
```

with:

```ts
const DYNAMIC_FORWARD_PROXY_HTTP_CACHE = 'dynamic_forward_proxy_cache_config_http';

function buildWildcardHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'http_wildcard',
    domains: hosts,
    routes: [
      {
        name: 'matched',
        match: { prefix: '/' },
        route: { cluster: 'dynamic_forward_proxy_cluster_http' },
      },
    ],
  };
}

function buildBlockedHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'blocked',
    domains: hosts,
    routes: [
      {
        name: 'blocked',
        match: { prefix: '/' },
        direct_response: { status: 403, body: { inline_string: 'susentorno: host blocked' } },
      },
    ],
  };
}

/**
 * listener_80 shares one HTTP connection manager (and so one access log config)
 * across every route: matched allow-list hosts, block-list hosts, and the
 * default catch-all. %ROUTE_NAME% is the one Envoy command operator that
 * surfaces which route actually handled the request in that shared log, which
 * is how `run-hosting` tells ALLOW HTTP / BLOCK LIST / BLOCK HTTP / ALLOW OPEN
 * apart on this listener (see src/runHosting/classify.ts).
 */
function http80AccessLog(): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              `CFGM|http|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|` +
              `%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%RESPONSE_CODE%|%RESPONSE_FLAGS%|` +
              `%DURATION%|%BYTES_SENT%|%ROUTE_NAME%\n`,
          },
        },
      },
    },
  ];
}
```

In `buildHttp80Entry`, replace:

```ts
  const virtualHost = {
    name: sanitizeName(host),
    domains: [host],
    routes: [{ match: { prefix: '/' }, route: { cluster: clusterName } }],
  };
```

with:

```ts
  const virtualHost = {
    name: sanitizeName(host),
    domains: [host],
    routes: [{ name: 'matched', match: { prefix: '/' }, route: { cluster: clusterName } }],
  };
```

Replace the top of `generateEnvoyConfig`:

```ts
export function generateEnvoyConfig(
  allowlist: Allowlist,
  options: BuildEnvoyConfigOptions = {},
): Record<string, unknown> {
  const overrides = options.overrides ?? [];
  const adminPortValue =
    options.fault === 'crash-config' ? 70000 : options.fault === 'never-ready' ? 9902 : 9901;
```

with:

```ts
export function generateEnvoyConfig(
  allowlist: Allowlist,
  options: BuildEnvoyConfigOptions = {},
): Record<string, unknown> {
  const overrides = options.overrides ?? [];
  const skipAllowList = options.skipAllowList ?? false;
  const adminPortValue =
    options.fault === 'crash-config' ? 70000 : options.fault === 'never-ready' ? 9902 : 9901;
```

Replace:

```ts
  const hasWildcardHttp80 = http80WildcardHosts.length > 0;

  return {
```

with:

```ts
  const hasWildcardHttp80 = http80WildcardHosts.length > 0;
  // block-list.txt entries are bare hostnames (no port); they apply to both listeners.
  const blockListHosts = allowlist.blocked;
  const hasBlockList = blockListHosts.length > 0;
  // The open (skip-allow-list) 80 catch-all needs the same dynamic-forward-proxy
  // filter/cluster the wildcard allow-list entries already use, even when there
  // are no wildcard allow-list entries at all.
  const needsHttpDynamicForwardProxy = hasWildcardHttp80 || skipAllowList;

  return {
```

Replace the whole `listener_443` filter_chains + default_filter_chain block:

```ts
          filter_chains: [
            ...claudeBuilt.map((b) => b.filterChain),
            ...codexBuilt.map((b) => b.filterChain),
            ...authCandidateBuilt.map((b) => b.filterChain),
            ...githubBuilt.map((b) => b.filterChain),
            ...mcpBuilt.map((b) => b.filterChain),
            {
              filter_chain_match: { server_names: passthroughServerNames },
              filters: [
                {
                  name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                    port_value: 443,
                    dns_cache_config: {
                      name: 'dynamic_forward_proxy_cache_config',
                      dns_lookup_family: 'V4_ONLY',
                    },
                  },
                },
                {
                  name: 'envoy.filters.network.tcp_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                    stat_prefix: 'passthrough_443',
                    cluster: 'dynamic_forward_proxy_cluster',
                    access_log: accessLog('pass'),
                  },
                },
              ],
            },
          ],
          default_filter_chain: {
            filters: [
              {
                name: 'envoy.filters.network.tcp_proxy',
                typed_config: {
                  '@type':
                    'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                  stat_prefix: 'blocked_443',
                  cluster: 'blackhole',
                  access_log: accessLog('deny443'),
                },
              },
            ],
          },
        },
```

with:

```ts
          filter_chains: [
            ...claudeBuilt.map((b) => b.filterChain),
            ...codexBuilt.map((b) => b.filterChain),
            ...authCandidateBuilt.map((b) => b.filterChain),
            ...githubBuilt.map((b) => b.filterChain),
            ...mcpBuilt.map((b) => b.filterChain),
            ...(passthroughServerNames.length > 0
              ? [
                  {
                    filter_chain_match: { server_names: passthroughServerNames },
                    filters: [
                      {
                        name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                          port_value: 443,
                          dns_cache_config: {
                            name: 'dynamic_forward_proxy_cache_config',
                            dns_lookup_family: 'V4_ONLY',
                          },
                        },
                      },
                      {
                        name: 'envoy.filters.network.tcp_proxy',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                          stat_prefix: 'passthrough_443',
                          cluster: 'dynamic_forward_proxy_cluster',
                          access_log: accessLog('pass'),
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(hasBlockList
              ? [
                  {
                    filter_chain_match: { server_names: blockListHosts },
                    filters: [
                      {
                        name: 'envoy.filters.network.tcp_proxy',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                          stat_prefix: 'blocklist_443',
                          cluster: 'blackhole',
                          access_log: accessLog('blocklist'),
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
          default_filter_chain: skipAllowList
            ? {
                filters: [
                  {
                    name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                    typed_config: {
                      '@type':
                        'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                      port_value: 443,
                      dns_cache_config: {
                        name: 'dynamic_forward_proxy_cache_config',
                        dns_lookup_family: 'V4_ONLY',
                      },
                    },
                  },
                  {
                    name: 'envoy.filters.network.tcp_proxy',
                    typed_config: {
                      '@type':
                        'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                      stat_prefix: 'open_443',
                      cluster: 'dynamic_forward_proxy_cluster',
                      access_log: accessLog('passopen'),
                    },
                  },
                ],
              }
            : {
                filters: [
                  {
                    name: 'envoy.filters.network.tcp_proxy',
                    typed_config: {
                      '@type':
                        'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                      stat_prefix: 'blocked_443',
                      cluster: 'blackhole',
                      access_log: accessLog('deny443'),
                    },
                  },
                ],
              },
        },
```

Replace the whole `listener_80` block:

```ts
        {
          name: 'listener_80',
          address: { socket_address: { address: '0.0.0.0', port_value: 80 } },
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: 'passthrough_80',
                    access_log: accessLog('http'),
                    route_config: {
                      name: 'local_route_80',
                      virtual_hosts: [
                        ...http80ExactBuilt.map((b) => b.virtualHost),
                        ...(hasWildcardHttp80
                          ? [buildWildcardHttp80VirtualHost(http80WildcardHosts)]
                          : []),
                        {
                          name: 'default_deny',
                          domains: ['*'],
                          routes: [
                            {
                              match: { prefix: '/' },
                              direct_response: {
                                status: 403,
                                body: { inline_string: 'susentorno: host not allow-listed' },
                              },
                            },
                          ],
                        },
                      ],
                    },
                    http_filters: [
                      ...(hasWildcardHttp80 ? [buildDynamicForwardProxyHttpFilter()] : []),
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
```

with:

```ts
        {
          name: 'listener_80',
          address: { socket_address: { address: '0.0.0.0', port_value: 80 } },
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: 'passthrough_80',
                    access_log: http80AccessLog(),
                    route_config: {
                      name: 'local_route_80',
                      virtual_hosts: [
                        ...http80ExactBuilt.map((b) => b.virtualHost),
                        ...(hasWildcardHttp80
                          ? [buildWildcardHttp80VirtualHost(http80WildcardHosts)]
                          : []),
                        ...(hasBlockList ? [buildBlockedHttp80VirtualHost(blockListHosts)] : []),
                        {
                          name: 'default_deny',
                          domains: ['*'],
                          routes: skipAllowList
                            ? [
                                {
                                  name: 'open',
                                  match: { prefix: '/' },
                                  route: { cluster: 'dynamic_forward_proxy_cluster_http' },
                                },
                              ]
                            : [
                                {
                                  name: 'default-deny',
                                  match: { prefix: '/' },
                                  direct_response: {
                                    status: 403,
                                    body: { inline_string: 'susentorno: host not allow-listed' },
                                  },
                                },
                              ],
                        },
                      ],
                    },
                    http_filters: [
                      ...(needsHttpDynamicForwardProxy
                        ? [buildDynamicForwardProxyHttpFilter()]
                        : []),
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
```

Finally, replace:

```ts
        ...http80ExactBuilt.map((b) => b.cluster),
        ...(hasWildcardHttp80 ? [buildDynamicForwardProxyHttpCluster()] : []),
```

with:

```ts
        ...http80ExactBuilt.map((b) => b.cluster),
        ...(needsHttpDynamicForwardProxy ? [buildDynamicForwardProxyHttpCluster()] : []),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/proxyConfig.test.ts
git commit -m "feat(policy): block-list chains/routes, --skip-allow-list default branch, empty-chain fix"
```

---

## Task 10: `parseLine.ts` — new path ids + `routeName` field

**Files:**

- Modify: `src/runHosting/parseLine.ts`
- Modify: `tests/unit/logLineParsing.test.ts`

**Interfaces:**

- Produces: `PathId` gains `'passopen' | 'blocklist'`; `AccessLine` gains `routeName?: string` (populated only for `pathId === 'http'`). Consumed by Task 11 (`classify.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/logLineParsing.test.ts`, inside the `describe` block:

```ts
  it('parses an 11-field http line into routeName', () => {
    const line = 'CFGM|http|2026-07-06T12:04:31|-|archive.ubuntu.com|via_upstream|200|-|12|34|matched';
    expect(parseLine(line)).toEqual({
      pathId: 'http',
      time: '2026-07-06T12:04:31',
      serverName: '-',
      authority: 'archive.ubuntu.com',
      codeDetails: 'via_upstream',
      responseCode: '200',
      responseFlags: '-',
      duration: '12',
      bytesSent: '34',
      routeName: 'matched',
    });
  });

  it('returns null for a 10-field http line now that it needs a routeName field', () => {
    expect(
      parseLine('CFGM|http|2026-07-06T12:04:31|-|archive.ubuntu.com|via_upstream|200|-|12|34'),
    ).toBeNull();
  });

  it('parses a well-formed passopen line', () => {
    const line = 'CFGM|passopen|2026-07-06T12:04:31|open.example.com|-|-|-|-|-|-';
    expect(parseLine(line)).toEqual({
      pathId: 'passopen',
      time: '2026-07-06T12:04:31',
      serverName: 'open.example.com',
      authority: '-',
      codeDetails: '-',
      responseCode: '-',
      responseFlags: '-',
      duration: '-',
      bytesSent: '-',
    });
  });

  it('parses a well-formed blocklist line', () => {
    const line = 'CFGM|blocklist|2026-07-06T12:04:31|blocked.example.com|-|-|-|-|-|-';
    expect(parseLine(line)?.pathId).toBe('blocklist');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/logLineParsing.test.ts`
Expected: FAIL — `passopen`/`blocklist` aren't in `PATH_IDS` yet, and a 10-field `http` line still parses successfully (needs to become 11-field-only).

- [ ] **Step 3: Update `src/runHosting/parseLine.ts`**

Replace the whole file with:

```ts
export type PathId = 'term' | 'pass' | 'http' | 'deny443' | 'cand' | 'mcp' | 'passopen' | 'blocklist';

/** Header names carried by a `cand` line, in field order; also their display names. */
export const CAND_HEADER_NAMES = [
  'Authorization',
  'Cookie',
  'X-API-Key',
  'X-Auth-Token',
  'Proxy-Authorization',
] as const;

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
  /** Non-`cand` only: the actual HTTP status Envoy returned to the client. */
  responseCode?: string;
  /** Non-`cand` only: Envoy's short failure codes (e.g. `UF`, `UT`), `-` when none apply. */
  responseFlags?: string;
  /** Non-`cand` only: total request duration in milliseconds. */
  duration?: string;
  /** Non-`cand` only: body bytes Envoy sent to the downstream client. */
  bytesSent?: string;
  /** `cand` only: the five truncated header values in CAND_HEADER_NAMES order ('-' when absent). */
  authHeaders?: string[];
  /**
   * `http` only: the name of the Envoy route that handled the request (`matched`,
   * `blocked`, `default-deny`, or `open`) — listener_80 shares one access log
   * across every route, so this is how an `http` line's tag is distinguished.
   */
  routeName?: string;
}

const PATH_IDS = new Set<PathId>([
  'term',
  'pass',
  'http',
  'deny443',
  'cand',
  'mcp',
  'passopen',
  'blocklist',
]);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  const pathId = parts[1] as PathId;
  if (!PATH_IDS.has(pathId)) return null;
  const expectedFields = pathId === 'cand' || pathId === 'http' ? 11 : 10;
  if (parts.length !== expectedFields) return null;
  const [, , time, serverName, authority, codeDetails] = parts;
  if (pathId === 'cand') {
    return {
      pathId,
      time,
      serverName,
      authority,
      codeDetails,
      authHeaders: parts.slice(6),
    };
  }
  const [, , , , , , responseCode, responseFlags, duration, bytesSent, routeName] = parts;
  return {
    pathId,
    time,
    serverName,
    authority,
    codeDetails,
    responseCode,
    responseFlags,
    duration,
    bytesSent,
    ...(pathId === 'http' ? { routeName } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/logLineParsing.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/parseLine.ts tests/unit/logLineParsing.test.ts
git commit -m "feat(policy): parseLine gains passopen/blocklist path ids and http routeName"
```

---

## Task 11: `classify.ts` — `ALLOW OPEN`/`BLOCK LIST` tags, port on every entry

**Files:**

- Modify: `src/runHosting/classify.ts`
- Modify: `tests/unit/logLineClassification.test.ts`

**Interfaces:**

- Consumes: `PathId`, `AccessLine.routeName` from Task 10.
- Produces: `Tag` gains `'ALLOW OPEN' | 'BLOCK LIST'`; `Entry` gains `port: number`. Consumed by Task 12 (`formatOutput.ts`) and Task 14 (`runHostingLoop.ts`'s `onLogLine`, unchanged call site).

- [ ] **Step 1: Write the failing tests**

Replace `tests/unit/logLineClassification.test.ts` in full with:

```ts
import { describe, it, expect } from 'vitest';
import { classify } from '../../src/runHosting/classify';
import type { AccessLine } from '../../src/runHosting/parseLine';

function line(over: Partial<AccessLine>): AccessLine {
  return {
    pathId: 'term',
    time: '2026-07-06T12:00:00',
    serverName: '-',
    authority: '-',
    codeDetails: '-',
    ...over,
  };
}

describe('access-log line classification', () => {
  it("maps the 'term' path to ALLOW CRED with the SNI as domain, port 443", () => {
    expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW CRED', domain: 'api.anthropic.com', port: 443 },
    ]);
  });

  it('maps passthrough to ALLOW PASS', () => {
    expect(classify(line({ pathId: 'pass', serverName: 'pypi.org' }))[0].tag).toBe('ALLOW PASS');
  });

  it('maps deny443 to BLOCK TLS', () => {
    expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' }))[0].tag).toBe(
      'BLOCK TLS',
    );
  });

  it('maps passopen to ALLOW OPEN', () => {
    expect(classify(line({ pathId: 'passopen', serverName: 'unlisted.example.com' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW OPEN', domain: 'unlisted.example.com', port: 443 },
    ]);
  });

  it('maps blocklist to BLOCK LIST', () => {
    expect(classify(line({ pathId: 'blocklist', serverName: 'blocked.example.com' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'BLOCK LIST', domain: 'blocked.example.com', port: 443 },
    ]);
  });

  it('strips a port already present on the domain', () => {
    expect(classify(line({ pathId: 'pass', serverName: 'pypi.org:443' }))[0].domain).toBe(
      'pypi.org',
    );
  });

  it('uses the authority as domain on port 80 and maps route name "matched" to ALLOW HTTP', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'archive.ubuntu.com', routeName: 'matched' })),
    ).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com', port: 80 },
    ]);
  });

  it('maps route name "default-deny" to BLOCK HTTP', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'nope.example.com', routeName: 'default-deny' }))[0]
        .tag,
    ).toBe('BLOCK HTTP');
  });

  it('maps route name "blocked" to BLOCK LIST', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'blocked.example.com', routeName: 'blocked' }))[0]
        .tag,
    ).toBe('BLOCK LIST');
  });

  it('maps route name "open" to ALLOW OPEN', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'unlisted.example.com', routeName: 'open' }))[0]
        .tag,
    ).toBe('ALLOW OPEN');
  });

  it('strips a port already present on the :authority value for an http line', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'archive.ubuntu.com:80', routeName: 'matched' }))[0]
        .domain,
    ).toBe('archive.ubuntu.com');
  });

  it('emits one AUTH CANDIDATE entry per present header, skipping "-"', () => {
    const result = classify(
      line({
        pathId: 'cand',
        serverName: 'partner.example.com',
        authHeaders: ['Bearer abc12', '-', 'sk-ant-key01', '-', '-'],
      }),
    );
    expect(result).toEqual([
      {
        time: '2026-07-06T12:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        port: 443,
        protocol: 'https',
        header: 'Authorization',
        value: 'Bearer abc12',
      },
      {
        time: '2026-07-06T12:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        port: 443,
        protocol: 'https',
        header: 'X-API-Key',
        value: 'sk-ant-key01',
      },
    ]);
  });

  it('emits no entries for a cand line with all headers absent', () => {
    expect(
      classify(
        line({
          pathId: 'cand',
          serverName: 'partner.example.com',
          authHeaders: ['-', '-', '-', '-', '-'],
        }),
      ),
    ).toEqual([]);
  });

  it('classifies an mcp pathId as ALLOW MCP', () => {
    expect(classify(line({ pathId: 'mcp', serverName: 'filesystem.internal' }))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW MCP', domain: 'filesystem.internal', port: 443 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/logLineClassification.test.ts`
Expected: FAIL — no `port` field yet, `passopen`/`blocklist`/route-name-based `http` classification unimplemented.

- [ ] **Step 3: Update `src/runHosting/classify.ts`**

Replace the whole file with:

```ts
import type { AccessLine, PathId } from './parseLine';
import { CAND_HEADER_NAMES } from './parseLine';

export type Tag =
  | 'ALLOW CRED'
  | 'ALLOW PASS'
  | 'ALLOW HTTP'
  | 'ALLOW MCP'
  | 'ALLOW OPEN'
  | 'BLOCK TLS'
  | 'BLOCK HTTP'
  | 'BLOCK LIST'
  | 'AUTH CANDIDATE';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
  port: number;
  protocol?: string;
  header?: string;
  value?: string;
}

/** Every 443-listener path id maps 1:1 to a tag: each is its own filter chain. */
const TAG_BY_443_PATH_ID: Partial<Record<PathId, Tag>> = {
  term: 'ALLOW CRED',
  pass: 'ALLOW PASS',
  mcp: 'ALLOW MCP',
  deny443: 'BLOCK TLS',
  passopen: 'ALLOW OPEN',
  blocklist: 'BLOCK LIST',
};

/** listener_80 shares one access log across routes, so `http` lines are keyed by route name instead. */
const TAG_BY_HTTP_ROUTE_NAME: Record<string, Tag> = {
  matched: 'ALLOW HTTP',
  blocked: 'BLOCK LIST',
  'default-deny': 'BLOCK HTTP',
  open: 'ALLOW OPEN',
};

/** Strips a trailing `:port` from a raw SNI/authority value, if present. */
function stripPort(host: string): string {
  const idx = host.lastIndexOf(':');
  return idx === -1 ? host : host.slice(0, idx);
}

export function classify(line: AccessLine): Entry[] {
  const rawDomain = line.serverName !== '-' ? line.serverName : line.authority;
  const domain = stripPort(rawDomain);

  if (line.pathId === 'cand') {
    const values = line.authHeaders ?? [];
    const entries: Entry[] = [];
    CAND_HEADER_NAMES.forEach((header, i) => {
      const value = values[i];
      if (value === undefined || value === '-') return;
      // protocol is hardcoded 'https' since auth-candidate only supports :443.
      entries.push({
        time: line.time,
        tag: 'AUTH CANDIDATE',
        domain,
        port: 443,
        protocol: 'https',
        header,
        value,
      });
    });
    return entries;
  }

  if (line.pathId === 'http') {
    const tag = TAG_BY_HTTP_ROUTE_NAME[line.routeName ?? ''];
    if (!tag) return [];
    return [{ time: line.time, tag, domain, port: 80 }];
  }

  const tag = TAG_BY_443_PATH_ID[line.pathId];
  if (!tag) return [];
  return [{ time: line.time, tag, domain, port: 443 }];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/logLineClassification.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/classify.ts tests/unit/logLineClassification.test.ts
git commit -m "feat(policy): classify.ts adds ALLOW OPEN/BLOCK LIST tags and per-entry port"
```

---

## Task 12: `formatOutput.ts` — print `domain:port`

**Files:**

- Modify: `src/runHosting/formatOutput.ts`
- Modify: `tests/unit/outputFormatting.test.ts`

**Interfaces:**

- Consumes: `Entry.port` from Task 11.

- [ ] **Step 1: Write the failing tests**

Replace `tests/unit/outputFormatting.test.ts` in full with:

```ts
import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../src/runHosting/formatOutput';

describe('access-log output formatting', () => {
  it('formats an entry as time  TAG  domain:port', () => {
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'BLOCK TLS',
        domain: 'nope.example.com',
        port: 443,
      }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com:443');
  });

  it('formats a port-80 entry with :80', () => {
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'ALLOW HTTP',
        domain: 'archive.ubuntu.com',
        port: 80,
      }),
    ).toBe('12:04:31  ALLOW HTTP  archive.ubuntu.com:80');
  });

  it('formats an AUTH CANDIDATE entry with domain:port, protocol, and header=value', () => {
    expect(
      formatOutput({
        time: '2026-07-18T09:00:00',
        tag: 'AUTH CANDIDATE',
        domain: 'partner.example.com',
        port: 443,
        protocol: 'https',
        header: 'Authorization',
        value: 'Bearer abc12',
      }),
    ).toBe('09:00:00  AUTH CANDIDATE  partner.example.com:443  https  Authorization=Bearer abc12');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/outputFormatting.test.ts`
Expected: FAIL — output still a bare domain, no port suffix.

- [ ] **Step 3: Update `src/runHosting/formatOutput.ts`**

Replace the whole file with:

```ts
import type { Entry } from './classify';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(entry: Entry): string {
  if (entry.tag === 'AUTH CANDIDATE') {
    return `${hms(entry.time)}  AUTH CANDIDATE  ${entry.domain}:${entry.port}  ${entry.protocol}  ${entry.header}=${entry.value}`;
  }
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}:${entry.port}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/outputFormatting.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/formatOutput.ts tests/unit/outputFormatting.test.ts
git commit -m "feat(policy): formatOutput prints domain:port on every log line"
```

---

## Task 13: `buildConfig.ts` threads `skipAllowList` through

**Files:**

- Modify: `src/runHosting/buildConfig.ts`
- Modify: `tests/unit/proxyConfigWriting.test.ts`

**Interfaces:**

- Consumes: `BuildEnvoyConfigOptions.skipAllowList` from Task 9; `combinePolicy`/`parseAllowListFile`/`parseAuthListFile` from Task 2; `parseBlockListFile` from Task 1.
- Produces: `writeEnvoyConfig(allowlist, outputPath, overrides, fault?, mcpServers?, skipAllowList?): void` — 6th parameter added. Consumed by Task 15 (`commands/runHosting.ts`).

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/proxyConfigWriting.test.ts` in full with:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { writeEnvoyConfig } from '../../src/runHosting/buildConfig';
import { combinePolicy, parseAllowListFile, parseAuthListFile } from '../../src/allowlist';
import { parseBlockListFile } from '../../src/blockList';

const ALLOW_LIST = ['pypi.org:443', ''].join('\n');
const AUTH_LIST = ['#pragma claude authenticated', 'api.anthropic.com:443', ''].join('\n');

function policy() {
  return combinePolicy(
    parseAllowListFile(ALLOW_LIST),
    parseAuthListFile(AUTH_LIST),
    parseBlockListFile(''),
  );
}

describe('proxy configuration writing', () => {
  it('writes envoy.yaml with upstream overrides applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [
        { sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { clusters: Array<{ name: string; load_assignment: any }> };
      };
      const cluster = config.static_resources.clusters.find(
        (c) => c.name === 'cluster_claude_api_anthropic_com',
      );
      expect(cluster).toBeDefined();
      expect(
        cluster!.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads mcpServers through to the generated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [], undefined, [
        { hostname: 'fs.internal', port: 9999 },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { listeners: Array<{ name: string; filter_chains: any[] }> };
      };
      const listener443 = config.static_resources.listeners.find((l) => l.name === 'listener_443');
      expect(
        listener443!.filter_chains.some((fc: any) =>
          fc.filter_chain_match?.server_names?.includes('fs.internal'),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads skipAllowList through to the generated config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(policy(), outputPath, [], undefined, undefined, true);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { listeners: Array<{ name: string; default_filter_chain: any }> };
      };
      const listener443 = config.static_resources.listeners.find((l) => l.name === 'listener_443');
      const tcp = listener443!.default_filter_chain.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      );
      expect(tcp.typed_config.cluster).toBe('dynamic_forward_proxy_cluster');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfigWriting.test.ts`
Expected: FAIL — `writeEnvoyConfig` doesn't accept a 6th `skipAllowList` argument yet, and `parseAllowlist` no longer exists (this file previously imported it).

- [ ] **Step 3: Update `src/runHosting/buildConfig.ts`**

Replace the whole file with:

```ts
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import {
  generateEnvoyConfig,
  type UpstreamOverride,
  type InjectFault,
  type McpServerUpstream,
} from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist and
 * write it to outputPath. Surfacing `allowlist.warnings` is the caller's job.
 * `fault` is a test-only render mutation; when omitted the output is unchanged.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
  fault?: InjectFault,
  mcpServers?: McpServerUpstream[],
  skipAllowList?: boolean,
): void {
  writeFileSync(
    outputPath,
    stringify(generateEnvoyConfig(allowlist, { overrides, fault, mcpServers, skipAllowList })),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfigWriting.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/buildConfig.ts tests/unit/proxyConfigWriting.test.ts
git commit -m "feat(policy): writeEnvoyConfig threads skipAllowList through"
```

---

## Task 14: `runHostingLoop.ts` reads three policy files instead of one

This is the second-largest task: `RunHostingConfig.allowlistPath` becomes `policyPaths: { allowList, authList, blockList }`, `RunHostingDeps.readAllowlist` is renamed `readPolicyFile` (same signature — it already just reads a path), all three files are watched (any of the three triggers the same restart path), and every "allowlist" identifier/log-message in this file becomes "policy" or a specific file name. `--skip-allow-list` does **not** touch this file at all — it's threaded entirely through `commands/runHosting.ts`'s `buildConfig` closure in Task 15.

**Files:**

- Modify: `src/runHosting/runHostingLoop.ts`
- Modify: `tests/unit/proxyStackSupervisor.test.ts` (full rewrite)

**Interfaces:**

- Consumes: `parseAllowListFile`, `parseAuthListFile`, `combinePolicy` from Task 2; `parseBlockListFile` from Task 1; `resolveMcpAllowlistCollisions` from Task 3 (unchanged call site).
- Produces: `RunHostingConfig.policyPaths: { allowList: string; authList: string; blockList: string }` (replacing `allowlistPath`); `RunHostingDeps.readPolicyFile: (path: string) => string | null` (replacing `readAllowlist`). Consumed by Task 15 (`commands/runHosting.ts`).

- [ ] **Step 1: Write the failing tests (full replacement of `tests/unit/proxyStackSupervisor.test.ts`)**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runHostingLoop,
  type RunHostingConfig,
  type RunHostingDeps,
} from '../../src/runHosting/runHostingLoop';
import type { CredentialChannelConfig } from '../../src/runHosting/credentialChannel';
import type { Credentials, ColorPorts, Color } from '../../src/runHosting/types';

const MIN = 60_000;

const VALID_ALLOW_LIST = ['pypi.org:443', ''].join('\n');
const VALID_AUTH_LIST = ['#pragma claude authenticated', 'api.anthropic.com:443', ''].join('\n');

const INVALID_AUTH_LIST = ['#pragma claude authenticated', '*.bad.example.com:443', ''].join('\n');

const COLLISION_ALLOW_LIST = 'shared.example.com:443\n';
const COLLISION_AUTH_LIST = [
  '#pragma claude authenticated',
  'api.anthropic.com:443',
  'shared.example.com:443',
  '',
].join('\n');

const PASS_LINE = 'envoy-1  | CFGM|pass|2026-07-10T12:00:00|pypi.org|-|-|-|-|-|-';
const CRED_LINE =
  'envoy-1  | CFGM|term|2026-07-10T12:00:01|api.anthropic.com|api.anthropic.com|via_upstream|200|-|10|100';

function claudeChannelConfig(
  creds: { value: Credentials },
  mocks: {
    writeSecret: (token: string, path: string) => void;
    nudgeRefresh: () => Promise<{ ok: boolean; stderr: string }>;
  },
  overrides: Partial<CredentialChannelConfig> = {},
): CredentialChannelConfig {
  return {
    name: 'claude',
    credentialsPath: '/fake/.credentials.json',
    secretPath: '/fake/sds-secret.yaml',
    readCredentials: () => creds.value,
    writeSecret: mocks.writeSecret,
    nudgeRefresh: mocks.nudgeRefresh,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

function baseConfig(channels: CredentialChannelConfig[]): RunHostingConfig {
  return {
    channels,
    policyPaths: {
      allowList: '/fake/allow-list.txt',
      authList: '/fake/auth-list.txt',
      blockList: '/fake/block-list.txt',
    },
    readyTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  };
}

interface PolicyState {
  allowList: { value: string | null };
  authList: { value: string | null };
  blockList: { value: string | null };
}

interface Harness {
  deps: RunHostingDeps;
  creds: { value: Credentials };
  policy: PolicyState;
  channelConfig: CredentialChannelConfig;
  fireCredentials: (path?: string) => void;
  firePolicyChange: () => void;
  fireSigint: () => void;
  fireSigterm: () => void;
  feedLogLine: (raw: string) => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn<(token: string, path: string) => void>>;
    allocatePorts: ReturnType<typeof vi.fn>;
    bringUpColor: ReturnType<typeof vi.fn>;
    waitColorReady: ReturnType<typeof vi.fn>;
    setActiveBackend: ReturnType<typeof vi.fn>;
    drainBackend: ReturnType<typeof vi.fn>;
    stopColor: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn<() => Promise<{ ok: boolean; stderr: string }>>>;
    buildConfig: ReturnType<typeof vi.fn>;
    ensureLeaf: ReturnType<typeof vi.fn>;
    startLogStream: ReturnType<typeof vi.fn>;
    stopLogStream: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    allocateMcpPorts: ReturnType<typeof vi.fn>;
    spawnMcpServer: ReturnType<typeof vi.fn>;
    probeMcpReady: ReturnType<typeof vi.fn>;
    killProcessTree: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  initial: Credentials,
  initialPolicy: { allowList?: string | null; authList?: string | null; blockList?: string | null } = {},
): Harness {
  const creds = { value: initial };
  const policy: PolicyState = {
    allowList: { value: initialPolicy.allowList ?? VALID_ALLOW_LIST },
    authList: { value: initialPolicy.authList ?? VALID_AUTH_LIST },
    blockList: { value: initialPolicy.blockList ?? '' },
  };
  const credentialCbs = new Map<string, () => void>();
  let policyCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  let sigtermCb: (() => void) | null = null;
  let onLine: ((raw: string) => void) | null = null;
  const watchClose = vi.fn();

  let portSeq = 0;
  const nextPorts = (): ColorPorts => {
    portSeq += 1;
    return { httpsPort: 20000 + portSeq, httpPort: 21000 + portSeq, adminPort: 22000 + portSeq };
  };

  const mocks = {
    writeSecret: vi.fn<(token: string, path: string) => void>(),
    allocatePorts: vi.fn(async () => nextPorts()),
    bringUpColor: vi.fn().mockResolvedValue(undefined),
    waitColorReady: vi.fn().mockResolvedValue({ ready: true }),
    setActiveBackend: vi.fn(),
    drainBackend: vi.fn().mockResolvedValue(undefined),
    stopColor: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn(async () => ({ ok: true, stderr: '' })),
    buildConfig: vi.fn(),
    ensureLeaf: vi.fn().mockReturnValue('reused leaf for 1 host(s)'),
    startLogStream: vi.fn((_color: string, cb: (raw: string) => void) => {
      onLine = cb;
    }),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    watchClose,
    log: vi.fn(),
    error: vi.fn(),
    allocateMcpPorts: vi.fn(async (count: number) =>
      Array.from({ length: count }, (_, i) => 30000 + i),
    ),
    spawnMcpServer: vi.fn((_spec: { name: string }, _onLine: (line: string) => void) => ({
      pid: 9000,
      onExit: () => {},
    })),
    probeMcpReady: vi.fn().mockResolvedValue(true),
    killProcessTree: vi.fn().mockResolvedValue(undefined),
  };
  const channelConfig = claudeChannelConfig(creds, mocks);
  const deps: RunHostingDeps = {
    readPolicyFile: (path) => {
      if (path.endsWith('allow-list.txt')) return policy.allowList.value;
      if (path.endsWith('auth-list.txt')) return policy.authList.value;
      if (path.endsWith('block-list.txt')) return policy.blockList.value;
      throw new Error(`unexpected policy path: ${path}`);
    },
    buildConfig: mocks.buildConfig,
    ensureLeaf: mocks.ensureLeaf,
    allocatePorts: mocks.allocatePorts,
    bringUpColor: mocks.bringUpColor,
    waitColorReady: mocks.waitColorReady,
    setActiveBackend: mocks.setActiveBackend,
    drainBackend: mocks.drainBackend,
    stopColor: mocks.stopColor,
    watch: (path, onEvent) => {
      if (
        path.endsWith('allow-list.txt') ||
        path.endsWith('auth-list.txt') ||
        path.endsWith('block-list.txt')
      ) {
        policyCb = onEvent;
      } else {
        credentialCbs.set(path, onEvent);
      }
      return { close: watchClose };
    },
    startLogStream: mocks.startLogStream,
    stopLogStream: mocks.stopLogStream,
    onSigint: (handler) => {
      sigintCb = handler;
    },
    onSigterm: (handler) => {
      sigtermCb = handler;
    },
    log: mocks.log,
    error: mocks.error,
    now: () => Date.now(),
    allocateMcpPorts: mocks.allocateMcpPorts,
    spawnMcpServer: mocks.spawnMcpServer,
    probeMcpReady: mocks.probeMcpReady,
    killProcessTree: mocks.killProcessTree,
  };
  return {
    deps,
    creds,
    policy,
    channelConfig,
    fireCredentials: (path = '/fake/.credentials.json') => credentialCbs.get(path)?.(),
    firePolicyChange: () => policyCb?.(),
    fireSigint: () => sigintCb?.(),
    fireSigterm: () => sigtermCb?.(),
    feedLogLine: (raw) => onLine?.(raw),
    mocks,
  };
}

/** Flush microtasks + zero-delay timers so the multi-await swap chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('proxy stack supervision', () => {
  describe('startup', () => {
    it('builds config, ensures leaf, writes secret, brings up blue, sets backend, logs', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toEqual([
        'api.anthropic.com:443',
      ]);
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
      expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('blue');
      expect(h.mocks.waitColorReady).toHaveBeenCalledTimes(1);
      expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
      expect(h.mocks.startLogStream).toHaveBeenCalledTimes(1);
      expect(h.mocks.startLogStream.mock.calls[0][0]).toBe('blue');
    });

    it('warns but still brings up the proxy on an invalid-syntax auth list', async () => {
      const h = makeHarness(
        { accessToken: 'A', expiresAt: 60 * MIN },
        { authList: INVALID_AUTH_LIST },
      );
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('unsupported wildcard syntax'),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      // Still running (not settled): a later SIGINT would resolve it.
      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
    });

    it('warns and resolves a collision, then brings up the proxy from the resolved config', async () => {
      const h = makeHarness(
        { accessToken: 'A', expiresAt: 60 * MIN },
        { allowList: COLLISION_ALLOW_LIST, authList: COLLISION_AUTH_LIST },
      );
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated",
        ),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toEqual([
        'api.anthropic.com:443',
        'shared.example.com:443',
      ]);
      expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toEqual([]);
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    });

    it('exits 1 when the allow list is unreadable', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, { allowList: null });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('could not read allow list'),
      );
    });

    it('exits 1 when blue never becomes ready on startup', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'timeout' });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('did not become ready on startup'),
      );
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    });

    it('exits 1 with the exit hint when blue exits during startup', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.waitColorReady.mockResolvedValue({ ready: false, reason: 'exited' });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    });

    it('applies a policy change that lands during the startup bring-up', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let release!: () => void;
      h.mocks.bringUpColor.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush(); // startup bring-up in flight; both watchers already armed

      h.policy.allowList.value = VALID_ALLOW_LIST.replace(
        'pypi.org:443',
        'pypi.org:443\nlate.example.com:443',
      );
      h.firePolicyChange();
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // still just the startup one

      release();
      await flush();

      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // startup + coalesced swap
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(2);
      expect(h.mocks.buildConfig.mock.calls[1][0].passthrough).toContain('late.example.com:443');
    });
  });

  describe('inline access logging', () => {
    it('prints each parsed host+handling once and ignores non-CFGM lines', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.log.mockClear();

      h.feedLogLine('[2026-07-10 12:00:00.000][1][info][main] envoy operational line');
      h.feedLogLine(PASS_LINE);
      h.feedLogLine(PASS_LINE);
      h.feedLogLine(CRED_LINE);

      expect(h.mocks.log.mock.calls.map((c) => c[0])).toEqual([
        '12:00:00  ALLOW PASS  pypi.org:443',
        '12:00:01  ALLOW CRED  api.anthropic.com:443',
      ]);
    });
  });

  describe('policy changes', () => {
    it('rebuilds config, reissues leaf, swaps to green, and clears unique tracking', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.feedLogLine(PASS_LINE); // pypi.org now tracked as seen
      h.mocks.buildConfig.mockClear();
      h.mocks.ensureLeaf.mockClear();
      h.mocks.bringUpColor.mockClear();
      h.mocks.log.mockClear();

      h.policy.allowList.value = VALID_ALLOW_LIST.replace(
        'pypi.org:443',
        'pypi.org:443\nexample.org:443',
      );
      h.firePolicyChange();
      await flush();

      expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toContain('example.org:443');
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: restarting proxy — policy changed');
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
      expect(h.mocks.bringUpColor.mock.calls[0][0]).toBe('green');
      expect(h.mocks.stopLogStream).toHaveBeenCalledTimes(1);
      expect(h.mocks.drainBackend).toHaveBeenCalledTimes(1);
      expect(h.mocks.stopColor).toHaveBeenCalledWith('blue');
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: swap complete — now serving green');
      expect(h.mocks.startLogStream).toHaveBeenCalledTimes(2); // startup(blue) + swap(green)
      expect(h.mocks.startLogStream.mock.calls[1][0]).toBe('green');

      // Unique tracking was cleared: the same host+handling prints again.
      h.mocks.log.mockClear();
      h.feedLogLine(PASS_LINE);
      expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org:443');
    });

    it('applies the resolved config on a flawed edit and warns instead of keeping previous', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.buildConfig.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.policy.allowList.value = COLLISION_ALLOW_LIST;
      h.policy.authList.value = COLLISION_AUTH_LIST;
      h.firePolicyChange();
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining("collision: 'shared.example.com:443'"),
      );
      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].claudeAuthenticated).toContain(
        'shared.example.com:443',
      );
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    });

    it('a block-list edit also triggers a restart', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.buildConfig.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.policy.blockList.value = 'blocked.example.com';
      h.firePolicyChange();
      await flush();

      expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
      expect(h.mocks.buildConfig.mock.calls[0][0].blocked).toEqual(['blocked.example.com']);
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    });
  });

  describe('credential changes', () => {
    it('propagates a changed token via a swap, preserving unique tracking', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.feedLogLine(PASS_LINE); // pypi.org tracked as seen
      h.mocks.writeSecret.mockClear();
      h.mocks.bringUpColor.mockClear();
      h.mocks.log.mockClear();

      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();

      expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
      expect(h.mocks.bringUpColor).toHaveBeenCalledWith('green', expect.anything());
      expect(h.mocks.log).toHaveBeenCalledWith(
        'run-hosting: restarting proxy — claude credentials changed',
      );
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: swap complete — now serving green');

      // Unique tracking survived the credential swap.
      h.mocks.log.mockClear();
      h.feedLogLine(PASS_LINE);
      expect(h.mocks.log).not.toHaveBeenCalled();
      h.feedLogLine(CRED_LINE); // a new key still prints (stream is live)
      expect(h.mocks.log).toHaveBeenCalledWith('12:00:01  ALLOW CRED  api.anthropic.com:443');
    });

    it('alternates the active color across successive swaps', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: swap complete — now serving green');

      h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: swap complete — now serving blue');
      expect(h.mocks.stopColor.mock.calls.map((c) => c[0])).toEqual(['blue', 'green']);
    });

    it('does not swap when the token is unchanged', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.bringUpColor.mockClear();

      h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
      h.fireCredentials();
      await flush();

      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('keeps the old color serving (non-fatal) when the new color never becomes ready', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.setActiveBackend.mockClear();

      h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'timeout' }); // the swap's green fails to serve
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('did not become ready — keeping the current proxy'),
      );
      expect(h.mocks.stopColor).toHaveBeenCalledWith('green'); // failed green torn down
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled(); // no flip
      // The loop is still running (not settled): a later SIGINT would resolve it.
      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
    });

    it('keeps the previous proxy and logs the exit hint when a swap color exits during startup', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      h.mocks.waitColorReady.mockResolvedValueOnce({ ready: false, reason: 'exited' });
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('exited during startup'));
      expect(h.mocks.stopColor).toHaveBeenCalledWith('green');
      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false); // non-fatal on a restart
    });

    it('keeps the old color serving when docker fails to bring up the new color', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.setActiveBackend.mockClear();

      h.mocks.bringUpColor.mockRejectedValueOnce(new Error('docker boom'));
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();

      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('could not start the new proxy'),
      );
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
    });
  });

  describe('coalescing', () => {
    it('collapses events during an in-flight swap into exactly one follow-up swap', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.bringUpColor.mockClear();

      let release!: () => void;
      h.mocks.bringUpColor.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      h.firePolicyChange(); // swap 1 begins; its bring-up is blocked
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      h.firePolicyChange(); // two more edits land mid-swap
      h.firePolicyChange();
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // nothing new while in flight

      release();
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // exactly one follow-up
    });

    it('clears unique tracking when both sources changed during an in-flight swap', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      void runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.feedLogLine(PASS_LINE); // tracked
      h.mocks.bringUpColor.mockClear();

      let release!: () => void;
      h.mocks.bringUpColor.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      // BOTH change while the first swap is in flight.
      h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
      h.fireCredentials();
      h.policy.allowList.value = VALID_ALLOW_LIST.replace(
        'pypi.org:443',
        'pypi.org:443\nboth.example.com:443',
      );
      h.firePolicyChange();
      await flush();

      release();
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // one follow-up for both

      // The follow-up included the policy change, so unique was cleared.
      h.mocks.log.mockClear();
      h.feedLogLine(PASS_LINE);
      expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org:443');
    });
  });

  describe('refresh nudging', () => {
    it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
      const channel = claudeChannelConfig(h.creds, h.mocks, { maxAttempts: 3 });
      const exit = runHostingLoop(baseConfig([channel]), h.deps);
      await flush();

      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
      expect(h.mocks.error).toHaveBeenCalledWith(
        expect.stringContaining('token did not refresh after 3 attempts'),
      );
    });

    it('resets the failure counter when a refresh succeeds mid-sequence', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
      const channel = claudeChannelConfig(h.creds, h.mocks, { maxAttempts: 3 });
      const exit = runHostingLoop(baseConfig([channel]), h.deps);
      await flush();
      await vi.advanceTimersByTimeAsync(2 * MIN);

      h.creds.value = { accessToken: 'A', expiresAt: 60 * MIN };
      h.fireCredentials();
      await flush();

      await vi.advanceTimersByTimeAsync(60 * MIN);
      await Promise.resolve();

      let settled = false;
      void exit.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('SIGINT tears everything down once and exits 0; a second SIGINT is a no-op', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.log.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.fireSigint();
      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      const sigintLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGINT'));
      expect(sigintLogs).toHaveLength(1);
      // 1 credential watcher + 3 policy watchers (allow/auth/block) = 4.
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(4);
      expect(h.mocks.stopLogStream).toHaveBeenCalled();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('SIGTERM tears everything down once and exits 0, same as SIGINT', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();
      h.mocks.log.mockClear();
      h.mocks.bringUpColor.mockClear();

      h.fireSigterm();
      h.fireSigterm();
      await flush();

      await expect(exit).resolves.toBe(0);
      const sigtermLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGTERM'));
      expect(sigtermLogs).toHaveLength(1);
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(4);
      expect(h.mocks.stopLogStream).toHaveBeenCalled();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('a SIGINT after a SIGTERM (or vice versa) is a no-op — only the first shutdown signal wins', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush();

      h.fireSigterm();
      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      const stopLogs = h.mocks.log.mock.calls.filter(
        (c) => String(c[0]).includes('SIGTERM') || String(c[0]).includes('SIGINT'),
      );
      expect(stopLogs).toHaveLength(1);
    });

    it('SIGINT while waiting for a color to become ready aborts the wait and exits 0', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.waitColorReady.mockImplementationOnce(
        (_color: Color, _ports: ColorPorts, _timeoutMs: number, signal: AbortSignal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ready: false, reason: 'timeout' }), {
              once: true,
            });
          }),
      );
      const exit = runHostingLoop(baseConfig([h.channelConfig]), h.deps);
      await flush(); // parked in the startup waitColorReady

      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      expect(h.mocks.setActiveBackend).not.toHaveBeenCalled();
    });
  });

  describe('multiple credential channels', () => {
    it('coalesces two dirty channels into one swap, writes both secrets, commits both', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const codexCreds = { value: { accessToken: 'X', expiresAt: 60 * MIN } as Credentials };
      const codexWrite = vi.fn();
      const codexChannel: CredentialChannelConfig = {
        name: 'codex',
        credentialsPath: '/fake/auth.json',
        secretPath: '/fake/codex-secret.yaml',
        readCredentials: () => codexCreds.value,
        writeSecret: codexWrite,
        nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
        refreshWindowMs: 3 * MIN,
        retryIntervalMs: 2 * MIN,
        maxAttempts: 3,
        refreshEnabled: true,
      };
      void runHostingLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
      await flush();
      h.mocks.bringUpColor.mockClear();
      h.mocks.writeSecret.mockClear();
      codexWrite.mockClear();

      // Block the in-flight swap so both credential events land mid-restart — the
      // window where the loop's coalescing guarantee actually applies (a pass's
      // dirty set is captured synchronously, before any awaited step; two watcher
      // callbacks fired back-to-back in the same tick land in *separate* passes
      // unless a restart is already in flight to hold them as pending).
      let release!: () => void;
      h.mocks.bringUpColor.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      h.firePolicyChange(); // swap begins; its bring-up is blocked
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);

      // Both credentials change while the swap is in flight.
      h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
      codexCreds.value = { accessToken: 'Y', expiresAt: 60 * MIN };
      h.fireCredentials('/fake/.credentials.json');
      h.fireCredentials('/fake/auth.json');
      await flush();
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // still just the blocked one

      release();
      await flush();

      // One coalesced follow-up swap serves both credential changes.
      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(2); // blocked swap + one follow-up
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
      expect(codexWrite).toHaveBeenCalledWith('Y', '/fake/codex-secret.yaml');
      expect(h.mocks.log).toHaveBeenCalledWith('run-hosting: swap complete — now serving blue');

      // Both are committed: presenting the same tokens again needs no further swap.
      h.mocks.bringUpColor.mockClear();
      h.fireCredentials('/fake/.credentials.json');
      h.fireCredentials('/fake/auth.json');
      await flush();
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });

    it('one channel exhausting its nudges fatals the whole loop and closes every watcher', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const codexChannel: CredentialChannelConfig = {
        name: 'codex',
        credentialsPath: '/fake/auth.json',
        secretPath: '/fake/codex-secret.yaml',
        readCredentials: () => ({ accessToken: 'X', expiresAt: 1 * MIN }),
        writeSecret: vi.fn(),
        nudgeRefresh: vi.fn().mockResolvedValue({ ok: false, stderr: 'codex boom' }),
        refreshWindowMs: 3 * MIN,
        retryIntervalMs: 2 * MIN,
        maxAttempts: 3,
        refreshEnabled: true,
      };
      const exit = runHostingLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
      await flush();

      // Codex's token is inside the refresh window and every nudge fails -> exhaustion.
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('codex boom'));
      // 2 credential watchers + 3 policy watchers (allow/auth/block) = 5.
      expect(h.mocks.watchClose).toHaveBeenCalledTimes(5);
    });
  });

  describe('host-run MCP servers', () => {
    it('allocates ports, spawns servers, and includes their hostnames in the leaf SANs and envoy config', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      void runHostingLoop(config, h.deps);
      await flush();

      expect(h.mocks.allocateMcpPorts).toHaveBeenCalledWith(1);
      expect(h.mocks.spawnMcpServer).toHaveBeenCalledTimes(1);
      expect(h.mocks.spawnMcpServer.mock.calls[0][0]).toMatchObject({
        name: 'fs',
        hostname: 'fs.internal',
        command: 'run-fs',
        port: 30000,
      });
      expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(
        expect.arrayContaining(['api.anthropic.com', 'fs.internal']),
      );
      expect(h.mocks.buildConfig.mock.calls[0][1]).toEqual([
        { hostname: 'fs.internal', port: 30000 },
      ]);
    });

    it('does not wait for MCP readiness before bringing up Envoy', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let releaseProbe!: (ready: boolean) => void;
      h.mocks.probeMcpReady.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (releaseProbe = resolve)),
      );
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      void runHostingLoop(config, h.deps);
      await flush();

      expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1); // Envoy started despite the pending probe
      expect(h.mocks.setActiveBackend).toHaveBeenCalledTimes(1);
      releaseProbe(true);
      await flush();
    });

    it('a probe timeout fatals the loop, stops both colors, and stops the mcp process', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      h.mocks.probeMcpReady.mockResolvedValueOnce(false);
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runHostingLoop(config, h.deps);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('did not become ready'));
      expect(h.mocks.stopColor).toHaveBeenCalledWith('blue');
      expect(h.mocks.stopColor).toHaveBeenCalledWith('green');
      expect(h.mocks.killProcessTree).toHaveBeenCalledWith(9000, 'SIGTERM');
    });

    it('an mcp server exiting after the proxy is already serving still fatals the whole loop', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let exitCb!: (code: number | null, signal: string | null) => void;
      h.mocks.spawnMcpServer.mockImplementationOnce((_spec: unknown, _onLine: unknown) => ({
        pid: 9001,
        onExit: (cb: (code: number | null, signal: string | null) => void) => (exitCb = cb),
      }));
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runHostingLoop(config, h.deps);
      await flush(); // proxy fully serving, mcp already reported ready

      exitCb(1, null);
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
    });

    it('SIGINT stops any still-running mcp server alongside the normal clean shutdown', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runHostingLoop(config, h.deps);
      await flush();

      h.fireSigint();
      await flush();

      await expect(exit).resolves.toBe(0);
      expect(h.mocks.killProcessTree).toHaveBeenCalledWith(9000, 'SIGTERM');
    });

    it('substitutes {ip} and {port} into the command before spawning', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [
          { name: 'fs', hostname: 'fs.internal', command: 'run-fs --host {ip} --port {port}' },
        ],
      };
      void runHostingLoop(config, h.deps);
      await flush();

      expect(h.mocks.spawnMcpServer.mock.calls[0][0].command).toBe(
        'run-fs --host 127.0.0.1 --port 30000',
      );
    });

    it('a SIGINT racing in while an mcp fatal is stopping the Envoy colors does not win with a clean exit', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let releaseStopColor!: () => void;
      h.mocks.stopColor.mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseStopColor = resolve)),
      );
      let exitCb!: (code: number | null, signal: string | null) => void;
      h.mocks.spawnMcpServer.mockImplementationOnce((_spec: unknown, _onLine: unknown) => ({
        pid: 9002,
        onExit: (cb: (code: number | null, signal: string | null) => void) => (exitCb = cb),
      }));
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runHostingLoop(config, h.deps);
      await flush();

      exitCb(1, null); // mcpFatal begins; its first stopColor call is blocked
      await flush();
      h.fireSigint(); // races in while the mcp-triggered teardown is still in flight
      await flush();
      releaseStopColor();
      await flush();

      // The mcp fatal must win: exit code 1, not the SIGINT's 0.
      await expect(exit).resolves.toBe(1);
      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining("mcp server 'fs' exited"));
    });

    it('does not bring blue up if an mcp fatal lands while waiting on allocatePorts', async () => {
      const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
      let releaseAllocatePorts!: (ports: ColorPorts) => void;
      h.mocks.allocatePorts.mockImplementationOnce(
        () => new Promise<ColorPorts>((resolve) => (releaseAllocatePorts = resolve)),
      );
      h.mocks.probeMcpReady.mockResolvedValueOnce(false); // fires mcpFatal
      const config = {
        ...baseConfig([h.channelConfig]),
        mcpServers: [{ name: 'fs', hostname: 'fs.internal', command: 'run-fs' }],
      };
      const exit = runHostingLoop(config, h.deps);
      await flush(); // mcp probe fails and mcpFatal runs while allocatePorts() is still pending

      expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('did not become ready'));
      releaseAllocatePorts({ httpsPort: 29000, httpPort: 29001, adminPort: 29002 });
      await flush();

      await expect(exit).resolves.toBe(1);
      expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: FAIL — `RunHostingConfig`/`RunHostingDeps` don't have `policyPaths`/`readPolicyFile` yet.

- [ ] **Step 3: Update `src/runHosting/runHostingLoop.ts`**

Replace the import line:

```ts
import { parseAllowlist, terminateTlsHosts, type Allowlist } from '../allowlist';
```

with:

```ts
import {
  parseAllowListFile,
  parseAuthListFile,
  parseBlockListFile,
  combinePolicy,
  terminateTlsHosts,
  type Allowlist,
} from '../allowlist';
```

Replace the `RunHostingConfig` field:

```ts
  allowlistPath: string;
```

with:

```ts
  policyPaths: { allowList: string; authList: string; blockList: string };
```

Replace the `RunHostingDeps` field:

```ts
  /** Raw allowlist file content, or null when unreadable. */
  readAllowlist: (path: string) => string | null;
```

with:

```ts
  /** Raw allow-list/auth-list/block-list file content, or null when unreadable. */
  readPolicyFile: (path: string) => string | null;
```

Inside `runHostingLoop`, replace:

```ts
    let pendingAllowlist = false;
```

with:

```ts
    let pendingPolicy = false;
```

Replace the `readParsedAllowlist`/`applyAllowlist` functions:

```ts
    /** Read+parse the allowlist; null only when the file is unreadable (keep previous config). */
    const readParsedAllowlist = (): Allowlist | null => {
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        deps.error(
          `run-hosting: could not read allowlist at ${config.allowlistPath}, keeping previous config`,
        );
        return null;
      }
      const allowlist = resolveMcpAllowlistCollisions(parseAllowlist(content), mcpServerConfigs);
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);
      return allowlist;
    };

    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(
        `run-hosting: ${deps.ensureLeaf([...terminateTlsHosts(allowlist), ...mcpHostnames])}`,
      );
      deps.buildConfig(allowlist, mcpServersWithPorts);
    };
```

with:

```ts
    /** Read one policy file, erroring with `label` if it's unreadable (keeping previous config). */
    const readPolicyPart = (path: string, label: string): string | null => {
      const content = deps.readPolicyFile(path);
      if (content === null) {
        deps.error(`run-hosting: could not read ${label} at ${path}, keeping previous config`);
      }
      return content;
    };

    /** Read+parse all three policy files; null if any is unreadable (keep previous config). */
    const readParsedPolicy = (): Allowlist | null => {
      const allowListContent = readPolicyPart(config.policyPaths.allowList, 'allow list');
      const authListContent = readPolicyPart(config.policyPaths.authList, 'auth list');
      const blockListContent = readPolicyPart(config.policyPaths.blockList, 'block list');
      if (allowListContent === null || authListContent === null || blockListContent === null) {
        return null;
      }
      const allowlist = resolveMcpAllowlistCollisions(
        combinePolicy(
          parseAllowListFile(allowListContent),
          parseAuthListFile(authListContent),
          parseBlockListFile(blockListContent),
        ),
        mcpServerConfigs,
      );
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);
      return allowlist;
    };

    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyPolicy = (allowlist: Allowlist): void => {
      deps.log(
        `run-hosting: ${deps.ensureLeaf([...terminateTlsHosts(allowlist), ...mcpHostnames])}`,
      );
      deps.buildConfig(allowlist, mcpServersWithPorts);
    };
```

Replace `requestRestart`:

```ts
    const requestRestart = (source: CredentialChannel | 'allowlist'): void => {
      if (settled) return;
      if (source === 'allowlist') pendingAllowlist = true;
      else dirtyChannels.add(source);
      if (!restarting) void drainRestarts();
    };
```

with:

```ts
    const requestRestart = (source: CredentialChannel | 'policy'): void => {
      if (settled) return;
      if (source === 'policy') pendingPolicy = true;
      else dirtyChannels.add(source);
      if (!restarting) void drainRestarts();
    };
```

Inside `drainRestarts`, replace:

```ts
        while (!settled && (dirtyChannels.size > 0 || pendingAllowlist)) {
          const allowlistDirty = pendingAllowlist;
          const channelsThisPass = [...dirtyChannels];
          pendingAllowlist = false;
          dirtyChannels.clear();

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (allowlistDirty) {
            const allowlist = readParsedAllowlist();
            if (allowlist !== null) {
              try {
                applyAllowlist(allowlist);
              } catch (err) {
                fatal(`failed to rebuild the proxy config: ${String(err)}`);
                return;
              }
              restartNeeded = true;
              clearUnique = true; // wholesale reset, per design
              reasons.push('allowlist changed');
            }
          }
```

with:

```ts
        while (!settled && (dirtyChannels.size > 0 || pendingPolicy)) {
          const policyDirty = pendingPolicy;
          const channelsThisPass = [...dirtyChannels];
          pendingPolicy = false;
          dirtyChannels.clear();

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (policyDirty) {
            const allowlist = readParsedPolicy();
            if (allowlist !== null) {
              try {
                applyPolicy(allowlist);
              } catch (err) {
                fatal(`failed to rebuild the proxy config: ${String(err)}`);
                return;
              }
              restartNeeded = true;
              clearUnique = true; // wholesale reset, per design
              reasons.push('policy changed');
            }
          }
```

In `start()`, replace:

```ts
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = resolveMcpAllowlistCollisions(parseAllowlist(content), mcpServerConfigs);
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);

      // Arm all watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      for (const channel of channels) {
        watchers.push(deps.watch(channel.credentialsPath, () => requestRestart(channel)));
      }
      watchers.push(deps.watch(config.allowlistPath, () => requestRestart('allowlist')));
```

with:

```ts
      const allowListContent = deps.readPolicyFile(config.policyPaths.allowList);
      if (allowListContent === null) {
        fatal(`could not read allow list at ${config.policyPaths.allowList}`);
        return;
      }
      const authListContent = deps.readPolicyFile(config.policyPaths.authList);
      if (authListContent === null) {
        fatal(`could not read auth list at ${config.policyPaths.authList}`);
        return;
      }
      const blockListContent = deps.readPolicyFile(config.policyPaths.blockList);
      if (blockListContent === null) {
        fatal(`could not read block list at ${config.policyPaths.blockList}`);
        return;
      }
      const allowlist = resolveMcpAllowlistCollisions(
        combinePolicy(
          parseAllowListFile(allowListContent),
          parseAuthListFile(authListContent),
          parseBlockListFile(blockListContent),
        ),
        mcpServerConfigs,
      );
      for (const warning of allowlist.warnings) deps.error(`run-hosting: ${warning}`);

      // Arm all watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      for (const channel of channels) {
        watchers.push(deps.watch(channel.credentialsPath, () => requestRestart(channel)));
      }
      watchers.push(deps.watch(config.policyPaths.allowList, () => requestRestart('policy')));
      watchers.push(deps.watch(config.policyPaths.authList, () => requestRestart('policy')));
      watchers.push(deps.watch(config.policyPaths.blockList, () => requestRestart('policy')));
```

Still in `start()`, replace:

```ts
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
```

with:

```ts
        try {
          applyPolicy(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
```

Still in `start()`, replace the startup status line:

```ts
      deps.log(
        `run-hosting: watching credentials and allowlist; proxy is serving the current token (${activeColor})`,
      );
```

with:

```ts
      deps.log(
        `run-hosting: watching credentials, allow list, auth list, and block list; proxy is serving the current token (${activeColor})`,
      );
```

Finally, replace the last line of `start()`:

```ts
      if (dirtyChannels.size > 0 || pendingAllowlist) void drainRestarts();
```

with:

```ts
      if (dirtyChannels.size > 0 || pendingPolicy) void drainRestarts();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/proxyStackSupervisor.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/runHostingLoop.ts tests/unit/proxyStackSupervisor.test.ts
git commit -m "feat(policy): runHostingLoop watches and combines allow/auth/block list files"
```

---

## Task 15: `run-hosting --skip-allow-list` CLI flag

**Files:**

- Modify: `src/commands/runHosting.ts`
- Modify: `tests/unit/commands/runHosting.test.ts`

**Interfaces:**

- Consumes: `writeEnvoyConfig`'s 6th `skipAllowList` parameter from Task 13; `EnvPaths.allowList/authList/blockList` from Task 5; `RunHostingConfig.policyPaths`/`RunHostingDeps.readPolicyFile` from Task 14.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/commands/runHosting.test.ts`, inside the `describe` block:

```ts
  it('exposes --skip-allow-list', () => {
    const program = new Command();
    registerRunHosting(program);
    const runHostingCommand = program.commands.find((cmd) => cmd.name() === 'run-hosting');
    expect(runHostingCommand).toBeDefined();
    const flags = runHostingCommand!.options.map((opt) => opt.flags);
    expect(flags.some((f) => f.includes('--skip-allow-list'))).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/commands/runHosting.test.ts`
Expected: FAIL — no `--skip-allow-list` option registered yet.

- [ ] **Step 3: Update `src/commands/runHosting.ts`**

Add the field to `RunHostingOptions`. Replace:

```ts
interface RunHostingOptions {
  credentials: string;
  secret?: string;
  codexCredentials: string;
  codexSecret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  upstreamOverride: UpstreamOverride[];
  injectFault?: InjectFault;
}
```

with:

```ts
interface RunHostingOptions {
  credentials: string;
  secret?: string;
  codexCredentials: string;
  codexSecret?: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  upstreamOverride: UpstreamOverride[];
  injectFault?: InjectFault;
  skipAllowList?: boolean;
}
```

Update the command's user-facing description — replace:

```ts
    .description(
      'Own the Envoy proxy end to end: build envoy.yaml from the allowlist, write the SDS ' +
        'secret, recreate the container, then watch allowlist.txt and credentials.json — ' +
        'rebuilding the config, reissuing the leaf certificate, and restarting the proxy as ' +
        "they change — while streaming the proxy's tagged access log (each host+handling " +
        'once). Foreground process; Ctrl-C to stop (leaves the container running).',
    )
```

with:

```ts
    .description(
      'Own the Envoy proxy end to end: build envoy.yaml from the allow list, auth list, and ' +
        'block list, write the SDS secret, recreate the container, then watch allow-list.txt, ' +
        'auth-list.txt, block-list.txt, and credentials.json — rebuilding the config, reissuing ' +
        "the leaf certificate, and restarting the proxy as they change — while streaming the proxy's " +
        'tagged access log (each host+handling once). Foreground process; Ctrl-C to stop (leaves ' +
        'the container running).',
    )
```

Add the CLI option — replace:

```ts
    .option(
      '--inject-fault <crash-config|never-ready>',
      'render a deliberately broken envoy.yaml to exercise proxy robustness (test use only)',
    )
```

with:

```ts
    .option(
      '--inject-fault <crash-config|never-ready>',
      'render a deliberately broken envoy.yaml to exercise proxy robustness (test use only)',
    )
    .option(
      '--skip-allow-list',
      'do not enforce allow-list.txt; unmatched hosts pass through and log as ALLOW OPEN ' +
        '(block-list.txt is still enforced)',
    )
```

Add the startup banner — replace:

```ts
        const secretPath = options.secret ?? paths.sdsSecret;
```

with:

```ts
        if (options.skipAllowList) {
          console.log(
            'run-hosting: --skip-allow-list is set — hosts not on allow-list.txt will pass through and be logged as such',
          );
        }

        const secretPath = options.secret ?? paths.sdsSecret;
```

Rename the `readAllowlist` dep — replace:

```ts
          readAllowlist: (path) => {
            try {
              return readFileSync(path, 'utf8');
            } catch {
              return null;
            }
          },
```

with:

```ts
          readPolicyFile: (path) => {
            try {
              return readFileSync(path, 'utf8');
            } catch {
              return null;
            }
          },
```

Thread `skipAllowList` into `buildConfig` — replace:

```ts
          buildConfig: (allowlist, mcpServersWithPorts) =>
            writeEnvoyConfig(
              allowlist,
              paths.envoyConfig,
              options.upstreamOverride,
              options.injectFault,
              mcpServersWithPorts,
            ),
```

with:

```ts
          buildConfig: (allowlist, mcpServersWithPorts) =>
            writeEnvoyConfig(
              allowlist,
              paths.envoyConfig,
              options.upstreamOverride,
              options.injectFault,
              mcpServersWithPorts,
              options.skipAllowList,
            ),
```

Switch to three policy paths — replace:

```ts
          const exitCode = await runHostingLoop(
            {
              channels: [claudeChannel, codexChannel],
              allowlistPath: paths.allowlist,
              readyTimeoutMs: 60_000,
              drainTimeoutMs: 30_000,
              mcpServers,
              mcpReadyTimeoutMs: 60_000,
            },
            deps,
          );
```

with:

```ts
          const exitCode = await runHostingLoop(
            {
              channels: [claudeChannel, codexChannel],
              policyPaths: {
                allowList: paths.allowList,
                authList: paths.authList,
                blockList: paths.blockList,
              },
              readyTimeoutMs: 60_000,
              drainTimeoutMs: 30_000,
              mcpServers,
              mcpReadyTimeoutMs: 60_000,
            },
            deps,
          );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/commands/runHosting.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/runHosting.ts tests/unit/commands/runHosting.test.ts
git commit -m "feat(policy): add run-hosting --skip-allow-list"
```

---

## Task 16: `diagnostics.md` + full project build/typecheck/test verification

This is the checkpoint where every earlier task's loose ends (CLI-level tests that depend on `dist/cli.js`, `generate-ca`'s indirect test, and overall type-consistency across the whole `src/` tree) get verified together for the first time.

**Files:**

- Modify: `diagnostics.md`

- [ ] **Step 1: Rewrite `diagnostics.md`**

Replace the file's `## Watching proxy traffic` and `## Maintaining the allow list` sections (and the header description line) — the full new file:

```md
# Diagnostics

Diagnosing issues with an environment or guest setup, and maintaining the allow list, auth list, and block list.

## Verifying an environment

Read-only diagnostic scripts report whether the proxy and a guest are set up correctly. None of them change any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run `.susentorno\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** inside the VM, run `/mnt/vm-shared-linux/verify-config.sh [host-ip]`. Pass `<host-ip>` (from `setup-machine.md`) to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
- **Windows guest:** from the mounted `vm-shared-windows` share, run `.\verify-config.ps1` to discover the host when exactly one IPv4 DNS server is configured, or `.\verify-config.ps1 -HostIp <host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host.

## Watching proxy traffic

`susentorno run-hosting` streams how the proxy handled each host, inline with its own status lines. Each line shows `domain:port` so it can be pasted directly into `allow-list.txt` or `auth-list.txt`. Each host/handling pair is printed once; the tracking resets when an allow-list/auth-list/block-list edit restarts the proxy (so you can immediately see how the edited entries are handled) and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `ALLOW MCP` — :443, routed to a host-run MCP server
- `ALLOW OPEN` — not on the allow list, auth list, or block list; passed through only because `run-hosting` was started with `--skip-allow-list`
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)
- `BLOCK LIST` — denied specifically because the host matched an entry in `block-list.txt` (`--skip-allow-list` does not override this)

## Maintaining the allow list, auth list, and block list

`current-allow-list.txt`, `current-auth-list.txt`, and `current-block-list.txt` (repo root, source controlled) are the default allow list, auth list, and block list that `susentorno init` copies into every new environment. To refresh the allow list and auth list from an upstream network policy file:

```
susentorno import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` and `current-auth-list.txt` in the current directory by default (`--allow-output`/`--auth-output` to override). It never touches `current-block-list.txt` (the upstream policy format has no concept of blocking) or an environment's own `proxy/{allow-list,auth-list,block-list}.txt` (edit those directly for per-environment changes — a running `susentorno run-hosting` picks up an edit to any of the three live). Run it in a checkout of this repository and commit the result. It is a maintenance command — not part of environment setup.

To try enabling some new part of the web without editing `allow-list.txt` up front, run `susentorno run-hosting --skip-allow-list`, use whatever you need to, and watch for `ALLOW OPEN` lines — each one is a `domain:port` you can add to `allow-list.txt` before turning the flag back off.
```

- [ ] **Step 2: Commit the docs change**

```bash
git add diagnostics.md
git commit -m "docs: document allow-list/auth-list/block-list split and --skip-allow-list"
```

- [ ] **Step 3: Rebuild the CLI and run the full unit + CLI suite**

Run: `pnpm typecheck`
Expected: PASS — this is the first point since Task 2 where the whole `src/` tree must typecheck cleanly. If it fails, the error will name a file this plan already touched with a stale `allowlist`/`parseAllowlist`/`allowlistPath` reference that a `grep -rn "parseAllowlist\|formatAllowlist\|readAllowlist\|allowlistPath\|\.allowlist\b" src` will locate; fix and re-run.

Run: `pnpm build`
Expected: PASS — rebuilds `dist/cli.js`, which every `tests/cli/**` test (and `tests/proxy-stack/**` in Task 17) runs against.

Run: `pnpm test:unit`
Expected: PASS — every test under `tests/unit/**`.

Run: `pnpm test:cli`
Expected: PASS — every test under `tests/cli/**`. This exercises, for the first time end-to-end: `susentorno init` writing all three files, `susentorno generate-ca` deriving SANs from `auth-list.txt`, and `susentorno import-sbx-network-policy` writing two files.

(`tests/guest/**` needs a full Hyper-V VM guest environment via `pnpm test:guest` and is out of scope for this checkpoint — it's not part of the project's own combined `pnpm test` script either. `tests/proxy-stack/**` needs Docker and is covered in Task 17.)

- [ ] **Step 4: Fix any failures found, re-running the specific failing test file after each fix**

There are no more source changes planned at this point, so any failure here means an earlier task's Edit was applied slightly differently than written (e.g. a stray leftover `allowlist.txt` reference, or a copy-paste line-ending mismatch) — grep for the exact failing string and correct it in place, re-run just that test file, then re-run `pnpm typecheck && pnpm test:unit && pnpm test:cli` once more to confirm nothing else regressed. Commit any such fix as `fix(policy): <what was wrong>` before moving to Task 17.

---

## Task 17: Docker-based `tests/proxy-stack/` suite — three fixture files, `--skip-allow-list` end-to-end

This is the real-Envoy integration layer. It requires Docker; run it only where Docker is available (the same requirement every other `tests/proxy-stack/*.test.ts` file already has).

**Files:**

- Create: `tests/proxy-stack/fixtures/allow-list.txt` (replaces `tests/proxy-stack/fixtures/allowlist.txt`)
- Create: `tests/proxy-stack/fixtures/auth-list.txt`
- Create: `tests/proxy-stack/fixtures/block-list.txt`
- Delete: `tests/proxy-stack/fixtures/allowlist.txt`
- Modify: `tests/proxyStack.ts`
- Modify: `tests/guest/guest.test.ts`
- Modify: `tests/proxy-stack/stackLifecycle.test.ts`
- Modify: `tests/proxy-stack/stackRobustness.test.ts`
- Modify: `tests/proxy-stack/allowlistEnforcement.test.ts`
- Modify: `tests/proxy-stack/githubInjection.test.ts`
- Modify: `tests/proxy-stack/codexInjection.test.ts`
- Modify: `tests/proxy-stack/mcpServer.test.ts`
- Create: `tests/proxy-stack/skipAllowList.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–16 (this is the full stack, exercised through the real CLI + real Envoy in Docker).
- Produces: `startProxyStack(extraArgs?: string[]): Promise<ProxyStack>` (new optional parameter); `ProxyStack.allowListPath/authListPath/blockListPath` (replacing `allowlistPath`).

- [ ] **Step 1: Split the fixture file**

Create `tests/proxy-stack/fixtures/allow-list.txt`:

```
pypi.org:443
archive.ubuntu.com:80
*.ubuntu.com:80

# Allow-listed from startup but never contacted by any test except the S2c
# cold-cache discrimination probe (tests/guest/guest.test.ts,
# docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt).
# Their whole purpose is to stay un-resolved until that probe hits them once.
files.pythonhosted.org:443
github.com:443
www.google.com:443
```

Create `tests/proxy-stack/fixtures/auth-list.txt`:

```
#pragma claude authenticated
api.anthropic.com:443

#pragma auth candidate
auth-candidate.test:443
```

Create `tests/proxy-stack/fixtures/block-list.txt` (a host used by the new block-list assertions in this task):

```
blocked-by-list.example.com
```

Delete `tests/proxy-stack/fixtures/allowlist.txt`.

- [ ] **Step 2: Update `tests/proxyStack.ts`**

Replace:

```ts
const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowlistFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'allowlist.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const authFixture = join(repoRoot, 'tests', 'fixtures', 'auth.json');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
  proxyProc: ResultPromise;
  /** Every stdout/stderr line run-hosting has produced so far, in order. */
  stdoutLines: string[];
  /** The environment's live allowlist — edit it to trigger a proxy restart. */
  allowlistPath: string;
  /** The mutable credentials file run-hosting watches — rotate it to trigger a restart. */
  credentialsPath: string;
}
```

with:

```ts
const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'allow-list.txt');
const authListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'auth-list.txt');
const blockListFixture = join(repoRoot, 'tests', 'proxy-stack', 'fixtures', 'block-list.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const authFixture = join(repoRoot, 'tests', 'fixtures', 'auth.json');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
  proxyProc: ResultPromise;
  /** Every stdout/stderr line run-hosting has produced so far, in order. */
  stdoutLines: string[];
  /** The environment's live allow list — edit it to trigger a proxy restart. */
  allowListPath: string;
  /** The environment's live auth list. */
  authListPath: string;
  /** The environment's live block list. */
  blockListPath: string;
  /** The mutable credentials file run-hosting watches — rotate it to trigger a restart. */
  credentialsPath: string;
}
```

Replace the `startProxyStack` function:

```ts
export async function startProxyStack(): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // Stage the test allowlist as the environment's own before generate-ca so
  // the leaf SANs derive from it; run-hosting then builds envoy.yaml from it too.
  const allowlistPath = join(proxyDir, 'allowlist.txt');
  copyFileSync(allowlistFixture, allowlistPath);
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // run-hosting owns the SDS secret now: the token in this mutable credentials
  // file becomes the injected `Bearer ${REAL_TOKEN}` header.
  const credentialsPath = join(envRoot, 'run-hosting-credentials.json');
  writeCredentialsFile(credentialsPath, REAL_TOKEN);

  const codexCredentialsPath = join(envRoot, 'run-hosting-auth.json');
  writeCodexAuthFile(
    codexCredentialsPath,
    buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
  );

  const proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: envParent, env: composeEnv, buffer: false, reject: false },
  );

  const stdoutLines: string[] = [];
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      stdoutLines.push(line);
      console.log(`run-hosting| ${line}`);
    });
  }

  // run-hosting builds envoy.yaml, writes the secret, and force-recreates; ready
  // means the whole startup sequence completed.
  await waitForStartupLine(stdoutLines, 'serving the current token', 60000);
  const caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
  return {
    mockUpstream,
    caCertPem,
    proxyDir,
    composeEnv,
    proxyProc,
    stdoutLines,
    allowlistPath,
    credentialsPath,
  };
}
```

with:

```ts
export async function startProxyStack(extraArgs: string[] = []): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  mkdirSync(envParent, { recursive: true });
  await rmEnvRoot(envRoot);
  await execa(
    'node',
    [cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture],
    { cwd: envParent },
  );

  // Stage the test allow list/auth list/block list as the environment's own before
  // generate-ca so the leaf SANs derive from the auth list; run-hosting then builds
  // envoy.yaml from all three too.
  const allowListPath = join(proxyDir, 'allow-list.txt');
  const authListPath = join(proxyDir, 'auth-list.txt');
  const blockListPath = join(proxyDir, 'block-list.txt');
  copyFileSync(allowListFixture, allowListPath);
  copyFileSync(authListFixture, authListPath);
  copyFileSync(blockListFixture, blockListPath);
  await execa('node', [cliPath, 'generate-ca'], { cwd: envParent });

  // run-hosting owns the SDS secret now: the token in this mutable credentials
  // file becomes the injected `Bearer ${REAL_TOKEN}` header.
  const credentialsPath = join(envRoot, 'run-hosting-credentials.json');
  writeCredentialsFile(credentialsPath, REAL_TOKEN);

  const codexCredentialsPath = join(envRoot, 'run-hosting-auth.json');
  writeCodexAuthFile(
    codexCredentialsPath,
    buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
  );

  const proxyProc = execa(
    'node',
    [
      cliPath,
      'run-hosting',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--codex-credentials',
      codexCredentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `auth-candidate.test=host.docker.internal:${mockUpstream.port}`,
      ...extraArgs,
    ],
    { cwd: envParent, env: composeEnv, buffer: false, reject: false },
  );

  const stdoutLines: string[] = [];
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      stdoutLines.push(line);
      console.log(`run-hosting| ${line}`);
    });
  }

  // run-hosting builds envoy.yaml, writes the secret, and force-recreates; ready
  // means the whole startup sequence completed.
  await waitForStartupLine(stdoutLines, 'serving the current token', 60000);
  const caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
  return {
    mockUpstream,
    caCertPem,
    proxyDir,
    composeEnv,
    proxyProc,
    stdoutLines,
    allowListPath,
    authListPath,
    blockListPath,
    credentialsPath,
  };
}
```

- [ ] **Step 3: Update the four existing E2E files that reference the old fixture/path**

In `tests/guest/guest.test.ts`, replace:

```ts
    appendFileSync(stack.allowlistPath, 'example.org:443\n');
```

with:

```ts
    appendFileSync(stack.allowListPath, 'example.org:443\n');
```

In `tests/proxy-stack/stackLifecycle.test.ts`, replace:

```ts
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
```

with:

```ts
const allowListFixture = fileURLToPath(new URL('./fixtures/allow-list.txt', import.meta.url));
const authListFixture = fileURLToPath(new URL('./fixtures/auth-list.txt', import.meta.url));
const blockListFixture = fileURLToPath(new URL('./fixtures/block-list.txt', import.meta.url));
```

and replace:

```ts
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
```

with:

```ts
  copyFileSync(allowListFixture, join(proxyDir, 'allow-list.txt'));
  copyFileSync(authListFixture, join(proxyDir, 'auth-list.txt'));
  copyFileSync(blockListFixture, join(proxyDir, 'block-list.txt'));
```

In `tests/proxy-stack/stackRobustness.test.ts`, replace:

```ts
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
```

with:

```ts
const allowListFixture = fileURLToPath(new URL('./fixtures/allow-list.txt', import.meta.url));
const authListFixture = fileURLToPath(new URL('./fixtures/auth-list.txt', import.meta.url));
const blockListFixture = fileURLToPath(new URL('./fixtures/block-list.txt', import.meta.url));
```

and replace **both** occurrences (this file copies the fixture twice — once per test that needs a fresh environment) of:

```ts
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
```

with:

```ts
  copyFileSync(allowListFixture, join(proxyDir, 'allow-list.txt'));
  copyFileSync(authListFixture, join(proxyDir, 'auth-list.txt'));
  copyFileSync(blockListFixture, join(proxyDir, 'block-list.txt'));
```

This same file has a **third**, unrelated write directly to `allowlist.txt` inside its own test body (not the shared setup) — a collision-resolution regression test that writes its own bespoke pragma content rather than using the fixture. Replace:

```ts
    writeFileSync(
      join(proxyDir, 'allowlist.txt'),
      [
        '#pragma passthrough',
        'shared.example.com:443',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'shared.example.com:443',
        '',
      ].join('\n'),
    );
```

with:

```ts
    writeFileSync(join(proxyDir, 'allow-list.txt'), 'shared.example.com:443\n');
    writeFileSync(
      join(proxyDir, 'auth-list.txt'),
      [
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        'shared.example.com:443',
        '',
      ].join('\n'),
    );
```

(This is the collision-resolution regression test — `shared.example.com:443` now lives in both `allow-list.txt` and `auth-list.txt`'s `claudeAuthenticated` section, still producing the same `collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated` warning the test waits for.)

Three other `tests/proxy-stack/*.test.ts` files stage their own bespoke `allowlist.txt` directly (not through the shared fixture) and need the same kind of split. In `tests/proxy-stack/githubInjection.test.ts`, replace:

```ts
  // Stage an allowlist with both github hosts under the new pragma so generate-ca
  // puts them in the leaf SANs and run-hosting builds the two injection chains.
  writeFileSync(
    join(proxyDir, 'allowlist.txt'),
    ['#pragma github authenticated', 'github.com:443', 'api.github.com:443', ''].join('\n'),
  );
```

with:

```ts
  // Stage an allow list/auth list with both github hosts under the new pragma so
  // generate-ca puts them in the leaf SANs and run-hosting builds the two
  // injection chains.
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(
    join(proxyDir, 'auth-list.txt'),
    ['#pragma github authenticated', 'github.com:443', 'api.github.com:443', ''].join('\n'),
  );
```

In `tests/proxy-stack/codexInjection.test.ts`, replace:

```ts
  writeFileSync(
    join(proxyDir, 'allowlist.txt'),
    [
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
      '#pragma codex authenticated',
      'chatgpt.com:443',
      '',
    ].join('\n'),
  );
```

with:

```ts
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(
    join(proxyDir, 'auth-list.txt'),
    [
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
      '#pragma codex authenticated',
      'chatgpt.com:443',
      '',
    ].join('\n'),
  );
```

In `tests/proxy-stack/mcpServer.test.ts`, replace:

```ts
  writeFileSync(join(proxyDir, 'allowlist.txt'), '');
```

with:

```ts
  writeFileSync(join(proxyDir, 'allow-list.txt'), '');
  writeFileSync(join(proxyDir, 'auth-list.txt'), '');
```

- [ ] **Step 4: Add block-list assertions to `tests/proxy-stack/allowlistEnforcement.test.ts`**

This file uses the shared `startProxyStack()`/`stopProxyStack()` helper and needs no changes to its existing tests (the `'CFGM|http|'`/`'CFGM|deny443|'` marker checks are substring matches, unaffected by the new 11th `routeName` field). Append this new `describe` block, after `describe('proxy stack access logging', ...)`:

```ts
describe('proxy stack block-list enforcement', () => {
  it('closes the connection for a block-listed SNI even though it is not simply "unlisted"', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked-by-list.example.com' },
          () => {
            socket.end();
            reject(
              new Error('expected the connection to be closed, but the TLS handshake succeeded'),
            );
          },
        );
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it('logs a BLOCK LIST line, distinct from BLOCK TLS, for the block-listed host', async () => {
    await new Promise<void>((resolve) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked-by-list.example.com' },
        () => socket.end(),
      );
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });

    const deadline = Date.now() + 10000;
    let logs = '';
    while (Date.now() < deadline) {
      const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy_blue'], {
        cwd: stack.proxyDir,
        env: stack.composeEnv,
      });
      logs = stdout;
      if (logs.includes('CFGM|blocklist|')) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(logs).toMatch(/CFGM\|blocklist\|[^|]*\|blocked-by-list\.example\.com\|/);
  });
});
```

- [ ] **Step 5: Write the new `tests/proxy-stack/skipAllowList.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { request as httpRequest } from 'node:http';
import {
  startProxyStack,
  stopProxyStack,
  HTTPS_PORT,
  HTTP_PORT,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;

beforeAll(async () => {
  stack = await startProxyStack(['--skip-allow-list']);
}, 90000);

afterAll(async () => {
  await stopProxyStack(stack);
}, 30000);

describe('run-hosting --skip-allow-list', () => {
  it('logs the skip-allow-list banner on startup', () => {
    expect(stack.stdoutLines.some((l) => l.includes('--skip-allow-list is set'))).toBe(true);
  });

  it('lets an unlisted TLS SNI through instead of dropping it', async () => {
    const handshakeSucceeded = await new Promise<boolean>((resolve, reject) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'never-allow-listed.example.com' },
        () => {
          socket.end();
          resolve(true);
        },
      );
      socket.on('error', () => resolve(false));
      socket.on('close', () => resolve(false));
      setTimeout(() => reject(new Error('timed out waiting for the handshake')), 10000);
    });
    expect(handshakeSucceeded).toBe(true);
  });

  it('still closes the connection for a block-listed SNI', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tlsConnect(
          { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked-by-list.example.com' },
          () => {
            socket.end();
            reject(
              new Error('expected the connection to be closed, but the TLS handshake succeeded'),
            );
          },
        );
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it('lets an unlisted Host header through on port 80 instead of returning 403', async () => {
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: HTTP_PORT,
          path: '/',
          headers: { host: 'never-allow-listed-http.example.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    // Not 403: the open catch-all proxies it through. It may still fail to
    // actually resolve/connect in this sandboxed test network — that is a
    // connection failure past the proxy's policy layer, not a policy 403.
    expect(statusCode).not.toBe(403);
  });

  it('logs an ALLOW OPEN line for the unlisted TLS host', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'never-allow-listed.example.com' },
        () => socket.end(),
      );
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
      setTimeout(() => reject(new Error('timed out waiting for the handshake')), 10000);
    });

    const found = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 10000;
      const poll = (): void => {
        if (stack.stdoutLines.some((l) => l.includes('ALLOW OPEN'))) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, 250);
      };
      poll();
    });
    expect(found).toBe(true);
  });
});
```

- [ ] **Step 6: Run the Docker-based suite**

Run: `pnpm test:proxy-stack`
Expected: PASS (requires Docker running locally and `dist/cli.js` already built by Task 16). `guest.test.ts` lives under `tests/guest/`, uses the separate `pnpm test:guest` script, and needs a full Hyper-V VM guest environment — run it only if that environment is available; it is not part of this plan's required verification (the project's own combined `pnpm test` script doesn't run it either).

- [ ] **Step 7: Commit**

```bash
git add tests/proxy-stack tests/proxyStack.ts tests/guest/guest.test.ts
git commit -m "test(policy): split proxy-stack fixtures into allow/auth/block lists, add --skip-allow-list e2e"
```

---
