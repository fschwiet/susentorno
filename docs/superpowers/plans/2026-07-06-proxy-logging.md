# Proxy Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator visibility into how the Envoy proxy handled each host (allowed-vs-blocked, SSL-vs-not, credentialed-vs-passthrough) via tagged access logs and a `configamatron proxy-logs` command.

**Architecture:** Envoy writes a machine-parseable `CFGM|…` access-log line to stdout on every traffic path, plus a new catch-all path so blocked `:443` connections finally log. A new CLI command streams `docker compose logs`, parses those lines, maps them to friendly tags, and supports blocked-only / unique / debounce views. All parsing, classification, filtering, dedup, and formatting are pure functions with unit tests; the command is thin wiring.

**Tech Stack:** TypeScript, Node 18+, commander (CLI), execa (subprocess), Envoy v1.31 (file access logger), vitest (unit/e2e/integration), Docker Compose.

## Global Constraints

- Access logs must **never** log the `Authorization` header or any credential — only server name, `:authority`/Host, start time, and response-code details.
- Access-log line contract (emitted by Envoy, consumed by the CLI):
  `CFGM|<path-id>|<START_TIME ISO>|<serverName>|<authority>|<responseCodeDetails>` — six `|`-separated fields, missing values render as `-`.
- `path-id` literals: `term` (:443 terminate), `pass` (:443 passthrough), `http` (:80 HCM), `deny443` (:443 catch-all).
- Friendly tags: `ALLOW CRED`, `ALLOW PASS`, `ALLOW HTTP`, `BLOCK TLS`, `BLOCK HTTP`.
- Follow existing repo conventions: commands live in `src/commands/`, register via a `register<Name>(program)` export wired in `src/cli.ts`, resolve the environment with `requireEnvPathsOrExit`, and talk to Docker with `execa('docker', ['compose', …], { cwd: paths.proxy })` inheriting `process.env`.
- Verification (fail-fast order): `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test:unit` → `pnpm build` → `pnpm test:e2e` → `pnpm test:integration`. Prettier is configured `proseWrap=never`.

## File Structure

- `src/envoyConfig.ts` — MODIFY: add a shared `accessLog(pathId)` helper, attach access logs to all paths, add a `default_filter_chain` catch-all on `listener_443`, add a `blackhole` cluster.
- `src/proxyLogs/parseLine.ts` — CREATE: raw log line → `AccessLine | null`.
- `src/proxyLogs/classify.ts` — CREATE: `AccessLine` → `Entry` (tag + domain + time).
- `src/proxyLogs/entryFilter.ts` — CREATE: `keepEntry(entry, blockedOnly)` predicate.
- `src/proxyLogs/reducer.ts` — CREATE: stateful `Reducer` for all/unique/debounce.
- `src/proxyLogs/formatOutput.ts` — CREATE: `OutputLine` → printable string.
- `src/commands/proxyLogs.ts` — CREATE: the `proxy-logs` command (thin wiring).
- `src/cli.ts` — MODIFY: register the command.
- Tests mirror sources under `tests/unit/proxyLogs/`, plus `tests/e2e/cli.test.ts` (MODIFY) and `tests/integration/proxy.test.ts` (MODIFY).
- `usage.md`, `technical-notes.md` — MODIFY: document the command and the log contract.

---

### Task 1: Envoy access logs + catch-all blocked path

**Files:**
- Modify: `src/envoyConfig.ts`
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**
- Consumes: existing `generateEnvoyConfig(allowlist, options)`.
- Produces: no new exports. The generated config now carries `access_log` blocks whose `inline_string` starts with `CFGM|<path-id>|` on every path, a `listener_443.default_filter_chain` routing to a `blackhole` cluster, and a `blackhole` cluster in `static_resources.clusters`.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/unit/envoyConfig.test.ts` inside the existing `describe('generateEnvoyConfig', …)` block. They reuse the file's existing `allowlist` fixture (`terminate: ['api.anthropic.com:443']`, `passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80']`).

```ts
it('tags every path with a CFGM access log to stdout', () => {
  const config = generateEnvoyConfig(allowlist) as any;
  const listener443 = config.static_resources.listeners.find(
    (l: any) => l.name === 'listener_443',
  );
  const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');

  const termChain = listener443.filter_chains.find((fc: any) =>
    fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
  );
  const termLog = termChain.filters[0].typed_config.access_log[0];
  expect(termLog.name).toBe('envoy.access_loggers.file');
  expect(termLog.typed_config.path).toBe('/dev/stdout');
  expect(termLog.typed_config.log_format.text_format_source.inline_string).toMatch(/^CFGM\|term\|/);

  const passChain = listener443.filter_chains.find((fc: any) =>
    fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
  );
  const passTcp = passChain.filters.find(
    (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
  ).typed_config;
  expect(passTcp.access_log[0].typed_config.log_format.text_format_source.inline_string).toMatch(
    /^CFGM\|pass\|/,
  );

  const httpLog =
    listener80.filter_chains[0].filters[0].typed_config.access_log[0].typed_config.log_format
      .text_format_source.inline_string;
  expect(httpLog).toMatch(/^CFGM\|http\|/);
});

it('adds a default_filter_chain that logs blocked SNI and routes to the blackhole cluster', () => {
  const config = generateEnvoyConfig(allowlist) as any;
  const listener443 = config.static_resources.listeners.find(
    (l: any) => l.name === 'listener_443',
  );

  const fallback = listener443.default_filter_chain;
  expect(fallback).toBeDefined();
  const tcp = fallback.filters.find(
    (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
  ).typed_config;
  expect(tcp.cluster).toBe('blackhole');
  expect(tcp.access_log[0].typed_config.log_format.text_format_source.inline_string).toMatch(
    /^CFGM\|deny443\|/,
  );

  const blackhole = config.static_resources.clusters.find((c: any) => c.name === 'blackhole');
  expect(blackhole).toBeDefined();
  expect(blackhole.load_assignment.endpoints).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit -- envoyConfig`
Expected: FAIL — `access_log` undefined / `default_filter_chain` undefined.

- [ ] **Step 3: Add the `accessLog` helper**

Add near the top of `src/envoyConfig.ts` (after the `toEnvoyWildcard` function):

```ts
function accessLog(pathId: string): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              `CFGM|${pathId}|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|` +
              `%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%\n`,
          },
        },
      },
    },
  ];
}
```

- [ ] **Step 4: Attach the access log to the terminate HCM**

In `buildTerminateEntry`, inside the `http_connection_manager` `typed_config`, add an `access_log` field right after `stat_prefix: \`terminate_${sanitizeName(sniHost)}\`,`:

```ts
          stat_prefix: `terminate_${sanitizeName(sniHost)}`,
          access_log: accessLog('term'),
```

- [ ] **Step 5: Attach the access log to the passthrough tcp_proxy**

In `generateEnvoyConfig`, in the passthrough filter chain's `envoy.filters.network.tcp_proxy` `typed_config`, add `access_log` after `cluster: 'dynamic_forward_proxy_cluster',`:

```ts
                    stat_prefix: 'passthrough_443',
                    cluster: 'dynamic_forward_proxy_cluster',
                    access_log: accessLog('pass'),
```

- [ ] **Step 6: Attach the access log to the port-80 HCM**

In the `listener_80` `http_connection_manager` `typed_config`, add `access_log` after `stat_prefix: 'passthrough_80',`:

```ts
                    stat_prefix: 'passthrough_80',
                    access_log: accessLog('http'),
```

- [ ] **Step 7: Add the catch-all `default_filter_chain` to `listener_443`**

In `generateEnvoyConfig`, on the `listener_443` object, add a `default_filter_chain` sibling to `filter_chains` (place it right after the `filter_chains: [ … ]` array closes):

```ts
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
```

- [ ] **Step 8: Add the `blackhole` cluster**

In `static_resources.clusters`, add this cluster (e.g. right after the `dynamic_forward_proxy_cluster` entry):

```ts
        {
          name: 'blackhole',
          type: 'STATIC',
          load_assignment: { cluster_name: 'blackhole', endpoints: [] },
        },
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test:unit -- envoyConfig`
Expected: PASS (all envoyConfig tests, old and new).

- [ ] **Step 10: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat: tag Envoy access logs and log blocked :443 via catch-all chain"
```

---

### Task 2: `parseLine` — raw log line → AccessLine

**Files:**
- Create: `src/proxyLogs/parseLine.ts`
- Test: `tests/unit/proxyLogs/parseLine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PathId = 'term' | 'pass' | 'http' | 'deny443';
  export interface AccessLine {
    pathId: PathId;
    time: string;        // ISO, e.g. '2026-07-06T12:04:31'
    serverName: string;  // '-' when absent
    authority: string;   // '-' when absent
    codeDetails: string; // '-' when absent
  }
  export function parseLine(raw: string): AccessLine | null;
  ```
- Robustness: finds the `CFGM|` marker anywhere in the line (tolerates a `docker compose logs` `service | ` prefix), so callers need not strip prefixes.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyLogs/parseLine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLine } from '../../../src/proxyLogs/parseLine';

describe('parseLine', () => {
  it('parses a well-formed CFGM line', () => {
    const line = 'CFGM|term|2026-07-06T12:04:31|api.anthropic.com|api.anthropic.com|via_upstream';
    expect(parseLine(line)).toEqual({
      pathId: 'term',
      time: '2026-07-06T12:04:31',
      serverName: 'api.anthropic.com',
      authority: 'api.anthropic.com',
      codeDetails: 'via_upstream',
    });
  });

  it('tolerates a docker compose log prefix before the marker', () => {
    const line = 'envoy-1  | CFGM|deny443|2026-07-06T12:00:00|blocked.example.com|-|-';
    expect(parseLine(line)?.pathId).toBe('deny443');
    expect(parseLine(line)?.serverName).toBe('blocked.example.com');
  });

  it('returns null for Envoy operational lines', () => {
    expect(parseLine('[2026-07-06 12:00:00.000][1][info][main] starting')).toBeNull();
  });

  it('returns null for an unknown path-id', () => {
    expect(parseLine('CFGM|bogus|2026-07-06T12:04:31|-|-|-')).toBeNull();
  });

  it('returns null when the field count is wrong', () => {
    expect(parseLine('CFGM|term|2026-07-06T12:04:31|only-four')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- parseLine`
Expected: FAIL — cannot find module `parseLine`.

- [ ] **Step 3: Write the implementation**

Create `src/proxyLogs/parseLine.ts`:

```ts
export type PathId = 'term' | 'pass' | 'http' | 'deny443';

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
}

const PATH_IDS = new Set<PathId>(['term', 'pass', 'http', 'deny443']);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  if (parts.length !== 6) return null;
  const [, pathId, time, serverName, authority, codeDetails] = parts;
  if (!PATH_IDS.has(pathId as PathId)) return null;
  return {
    pathId: pathId as PathId,
    time,
    serverName,
    authority,
    codeDetails,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- parseLine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxyLogs/parseLine.ts tests/unit/proxyLogs/parseLine.test.ts
git commit -m "feat: parse CFGM proxy access-log lines"
```

---

### Task 3: `classify` — AccessLine → tagged Entry

**Files:**
- Create: `src/proxyLogs/classify.ts`
- Test: `tests/unit/proxyLogs/classify.test.ts`

**Interfaces:**
- Consumes: `AccessLine`, `PathId` from `./parseLine`.
- Produces:
  ```ts
  export type Tag = 'ALLOW CRED' | 'ALLOW PASS' | 'ALLOW HTTP' | 'BLOCK TLS' | 'BLOCK HTTP';
  export interface Entry { time: string; tag: Tag; domain: string; }
  export function classify(line: AccessLine): Entry;
  ```
- Rules: `term`→`ALLOW CRED`, `pass`→`ALLOW PASS`, `deny443`→`BLOCK TLS`; `http`→`BLOCK HTTP` when `codeDetails === 'direct_response'` else `ALLOW HTTP`. Domain is `serverName` unless it is `'-'`, in which case `authority`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyLogs/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classify } from '../../../src/proxyLogs/classify';
import type { AccessLine } from '../../../src/proxyLogs/parseLine';

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

describe('classify', () => {
  it('maps terminate to ALLOW CRED with the SNI as domain', () => {
    expect(classify(line({ pathId: 'term', serverName: 'api.anthropic.com' }))).toEqual({
      time: '2026-07-06T12:00:00',
      tag: 'ALLOW CRED',
      domain: 'api.anthropic.com',
    });
  });

  it('maps passthrough to ALLOW PASS', () => {
    expect(classify(line({ pathId: 'pass', serverName: 'pypi.org' })).tag).toBe('ALLOW PASS');
  });

  it('maps deny443 to BLOCK TLS', () => {
    expect(classify(line({ pathId: 'deny443', serverName: 'nope.example.com' })).tag).toBe(
      'BLOCK TLS',
    );
  });

  it('uses the authority as domain on port 80 and maps via_upstream to ALLOW HTTP', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'archive.ubuntu.com', codeDetails: 'via_upstream' })),
    ).toEqual({ time: '2026-07-06T12:00:00', tag: 'ALLOW HTTP', domain: 'archive.ubuntu.com' });
  });

  it('maps a port-80 direct_response to BLOCK HTTP', () => {
    expect(
      classify(line({ pathId: 'http', authority: 'nope.example.com', codeDetails: 'direct_response' }))
        .tag,
    ).toBe('BLOCK HTTP');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- classify`
Expected: FAIL — cannot find module `classify`.

- [ ] **Step 3: Write the implementation**

Create `src/proxyLogs/classify.ts`:

```ts
import type { AccessLine } from './parseLine';

export type Tag = 'ALLOW CRED' | 'ALLOW PASS' | 'ALLOW HTTP' | 'BLOCK TLS' | 'BLOCK HTTP';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
}

export function classify(line: AccessLine): Entry {
  const domain = line.serverName !== '-' ? line.serverName : line.authority;
  let tag: Tag;
  switch (line.pathId) {
    case 'term':
      tag = 'ALLOW CRED';
      break;
    case 'pass':
      tag = 'ALLOW PASS';
      break;
    case 'deny443':
      tag = 'BLOCK TLS';
      break;
    case 'http':
      tag = line.codeDetails === 'direct_response' ? 'BLOCK HTTP' : 'ALLOW HTTP';
      break;
  }
  return { time: line.time, tag, domain };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- classify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxyLogs/classify.ts tests/unit/proxyLogs/classify.test.ts
git commit -m "feat: classify access lines into friendly tags"
```

---

### Task 4: `keepEntry` — blocked-only filter

**Files:**
- Create: `src/proxyLogs/entryFilter.ts`
- Test: `tests/unit/proxyLogs/entryFilter.test.ts`

**Interfaces:**
- Consumes: `Entry` from `./classify`.
- Produces: `export function keepEntry(entry: Entry, blockedOnly: boolean): boolean;` — when `blockedOnly` is false, keep everything; when true, keep only `BLOCK TLS` / `BLOCK HTTP`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyLogs/entryFilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { keepEntry } from '../../../src/proxyLogs/entryFilter';
import type { Entry } from '../../../src/proxyLogs/classify';

const allow: Entry = { time: 't', tag: 'ALLOW PASS', domain: 'a' };
const block: Entry = { time: 't', tag: 'BLOCK TLS', domain: 'b' };

describe('keepEntry', () => {
  it('keeps everything when blockedOnly is false', () => {
    expect(keepEntry(allow, false)).toBe(true);
    expect(keepEntry(block, false)).toBe(true);
  });

  it('keeps only BLOCK entries when blockedOnly is true', () => {
    expect(keepEntry(allow, true)).toBe(false);
    expect(keepEntry(block, true)).toBe(true);
    expect(keepEntry({ time: 't', tag: 'BLOCK HTTP', domain: 'c' }, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- entryFilter`
Expected: FAIL — cannot find module `entryFilter`.

- [ ] **Step 3: Write the implementation**

Create `src/proxyLogs/entryFilter.ts`:

```ts
import type { Entry } from './classify';

export function keepEntry(entry: Entry, blockedOnly: boolean): boolean {
  if (!blockedOnly) return true;
  return entry.tag === 'BLOCK TLS' || entry.tag === 'BLOCK HTTP';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- entryFilter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxyLogs/entryFilter.ts tests/unit/proxyLogs/entryFilter.test.ts
git commit -m "feat: blocked-only entry filter"
```

---

### Task 5: `Reducer` — all / unique / debounce dedup

**Files:**
- Create: `src/proxyLogs/reducer.ts`
- Test: `tests/unit/proxyLogs/reducer.test.ts`

**Interfaces:**
- Consumes: `Entry`, `Tag` from `./classify`.
- Produces:
  ```ts
  export type ReduceMode =
    | { kind: 'all' }
    | { kind: 'unique' }
    | { kind: 'debounce'; windowMs: number };
  export interface OutputLine {
    time: string;
    tag: Tag;
    domain: string;
    count?: number; // debounce reprints only: suppressed since last print
    since?: string; // debounce reprints only: ISO time of the last print
  }
  export class Reducer {
    constructor(mode: ReduceMode);
    push(entry: Entry): OutputLine[]; // 0 or 1 line
  }
  ```
- Dedup key is `(tag, domain)`. `all` emits every entry as a plain line. `unique` emits only the first occurrence of each key. `debounce` emits the first occurrence, suppresses repeats until `windowMs` has elapsed since the last printed line for that key, then reprints with `count` = number suppressed since the last print and `since` = the last printed line's time. Elapsed time is computed from the parsed `entry.time` (`Date.parse`), not wall-clock.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyLogs/reducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Reducer } from '../../../src/proxyLogs/reducer';
import type { Entry } from '../../../src/proxyLogs/classify';

function e(time: string, domain = 'github.com', tag: Entry['tag'] = 'ALLOW PASS'): Entry {
  return { time: `2026-07-06T${time}`, tag, domain };
}

describe('Reducer', () => {
  it('all mode emits every entry as a plain line', () => {
    const r = new Reducer({ kind: 'all' });
    expect(r.push(e('12:00:00'))).toEqual([
      { time: '2026-07-06T12:00:00', tag: 'ALLOW PASS', domain: 'github.com' },
    ]);
    expect(r.push(e('12:00:01'))).toHaveLength(1);
  });

  it('unique mode emits the first occurrence of each key only', () => {
    const r = new Reducer({ kind: 'unique' });
    expect(r.push(e('12:00:00'))).toHaveLength(1);
    expect(r.push(e('12:00:05'))).toEqual([]);
    // different tag for the same domain is a different key
    expect(r.push(e('12:00:06', 'github.com', 'BLOCK TLS'))).toHaveLength(1);
  });

  it('debounce mode suppresses within the window and reprints with a count', () => {
    const r = new Reducer({ kind: 'debounce', windowMs: 30_000 });
    expect(r.push(e('12:00:00'))).toHaveLength(1); // first print
    expect(r.push(e('12:00:10'))).toEqual([]); // +10s suppressed
    expect(r.push(e('12:00:20'))).toEqual([]); // +20s suppressed
    const out = r.push(e('12:00:31')); // +31s -> reprint
    expect(out).toEqual([
      {
        time: '2026-07-06T12:00:31',
        tag: 'ALLOW PASS',
        domain: 'github.com',
        count: 2,
        since: '2026-07-06T12:00:00',
      },
    ]);
    // window resets from the reprint
    expect(r.push(e('12:00:40'))).toEqual([]);
  });

  it('debounce tracks each key independently', () => {
    const r = new Reducer({ kind: 'debounce', windowMs: 30_000 });
    expect(r.push(e('12:00:00', 'a'))).toHaveLength(1);
    expect(r.push(e('12:00:01', 'b'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- reducer`
Expected: FAIL — cannot find module `reducer`.

- [ ] **Step 3: Write the implementation**

Create `src/proxyLogs/reducer.ts`:

```ts
import type { Entry, Tag } from './classify';

export type ReduceMode =
  | { kind: 'all' }
  | { kind: 'unique' }
  | { kind: 'debounce'; windowMs: number };

export interface OutputLine {
  time: string;
  tag: Tag;
  domain: string;
  count?: number;
  since?: string;
}

interface KeyState {
  lastPrintedMs: number;
  lastPrintedTime: string;
  suppressed: number;
}

function keyOf(entry: Entry): string {
  return `${entry.tag} ${entry.domain}`;
}

function plain(entry: Entry): OutputLine {
  return { time: entry.time, tag: entry.tag, domain: entry.domain };
}

export class Reducer {
  private readonly seen = new Map<string, KeyState>();

  constructor(private readonly mode: ReduceMode) {}

  push(entry: Entry): OutputLine[] {
    if (this.mode.kind === 'all') return [plain(entry)];

    const key = keyOf(entry);
    const nowMs = Date.parse(entry.time);
    const state = this.seen.get(key);

    if (!state) {
      this.seen.set(key, {
        lastPrintedMs: nowMs,
        lastPrintedTime: entry.time,
        suppressed: 0,
      });
      return [plain(entry)];
    }

    if (this.mode.kind === 'unique') return [];

    if (nowMs - state.lastPrintedMs >= this.mode.windowMs) {
      const out: OutputLine = {
        time: entry.time,
        tag: entry.tag,
        domain: entry.domain,
        count: state.suppressed,
        since: state.lastPrintedTime,
      };
      state.lastPrintedMs = nowMs;
      state.lastPrintedTime = entry.time;
      state.suppressed = 0;
      return [out];
    }

    state.suppressed += 1;
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- reducer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxyLogs/reducer.ts tests/unit/proxyLogs/reducer.test.ts
git commit -m "feat: dedup/debounce reducer for proxy-logs"
```

---

### Task 6: `formatOutput` — OutputLine → printable string

**Files:**
- Create: `src/proxyLogs/formatOutput.ts`
- Test: `tests/unit/proxyLogs/formatOutput.test.ts`

**Interfaces:**
- Consumes: `OutputLine` from `./reducer`.
- Produces: `export function formatOutput(line: OutputLine): string;` — prints `HH:MM:SS  TAG  domain`, appending `  (xN since HH:MM:SS)` when `count` is present. Time-of-day is the `HH:MM:SS` slice of the ISO string (chars 11–19), so no timezone reparsing occurs.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxyLogs/formatOutput.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/proxyLogs/formatOutput';

describe('formatOutput', () => {
  it('formats a plain line as time  TAG  domain', () => {
    expect(
      formatOutput({ time: '2026-07-06T12:04:31', tag: 'BLOCK TLS', domain: 'nope.example.com' }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com');
  });

  it('appends the collapsed count and since-time for a debounce reprint', () => {
    expect(
      formatOutput({
        time: '2026-07-06T12:04:31',
        tag: 'ALLOW PASS',
        domain: 'github.com',
        count: 47,
        since: '2026-07-06T12:04:01',
      }),
    ).toBe('12:04:31  ALLOW PASS  github.com  (x47 since 12:04:01)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- formatOutput`
Expected: FAIL — cannot find module `formatOutput`.

- [ ] **Step 3: Write the implementation**

Create `src/proxyLogs/formatOutput.ts`:

```ts
import type { OutputLine } from './reducer';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(line: OutputLine): string {
  const base = `${hms(line.time)}  ${line.tag}  ${line.domain}`;
  if (line.count !== undefined && line.since !== undefined) {
    return `${base}  (x${line.count} since ${hms(line.since)})`;
  }
  return base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- formatOutput`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxyLogs/formatOutput.ts tests/unit/proxyLogs/formatOutput.test.ts
git commit -m "feat: format proxy-logs output lines"
```

---

### Task 7: `proxy-logs` command + CLI registration

**Files:**
- Create: `src/commands/proxyLogs.ts`
- Modify: `src/cli.ts`
- Test: `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `parseLine`, `classify`, `keepEntry`, `Reducer`, `ReduceMode`, `formatOutput` from `../proxyLogs/*`; `requireEnvPathsOrExit` from `../envPaths`.
- Produces: `export function registerProxyLogs(program: Command): void;`
- Behavior: default follows and shows all tagged lines. `--no-follow` prints history and exits. `--blocked` shows only BLOCK. `--unique` and `--debounce <seconds>` are mutually exclusive (error → exit 1). `--debounce` requires a positive number (error → exit 1). Reads `docker compose logs [--follow] <service>` in `paths.proxy` inheriting `process.env`. SIGINT kills the child and exits 0.

- [ ] **Step 1: Write the failing e2e tests**

Add to `tests/e2e/cli.test.ts`, inside the top-level `describe('configamatron CLI', …)` block:

```ts
it('lists proxy-logs with its flags in help output', async () => {
  const { stdout, exitCode } = await execa('node', [cliPath, 'proxy-logs', '--help']);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('--blocked');
  expect(stdout).toContain('--unique');
  expect(stdout).toContain('--debounce');
  expect(stdout).toContain('--no-follow');
});

it('proxy-logs exits 1 without an environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
  try {
    const { exitCode, stderr } = await execa('node', [cliPath, 'proxy-logs'], {
      cwd: dir,
      reject: false,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("run 'configamatron init' first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('proxy-logs rejects --unique together with --debounce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
  try {
    await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
    const { exitCode, stderr } = await execa(
      'node',
      [cliPath, 'proxy-logs', '--unique', '--debounce', '30'],
      { cwd: dir, reject: false },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('mutually exclusive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Build and run the e2e tests to verify they fail**

Run: `pnpm build && pnpm test:e2e -- cli`
Expected: FAIL — `proxy-logs` is not a known command (help exits non-zero; missing-env assertion unmet).

- [ ] **Step 3: Write the command**

Create `src/commands/proxyLogs.ts`:

```ts
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { execa } from 'execa';
import { requireEnvPathsOrExit } from '../envPaths';
import { parseLine } from '../proxyLogs/parseLine';
import { classify } from '../proxyLogs/classify';
import { keepEntry } from '../proxyLogs/entryFilter';
import { Reducer, type ReduceMode } from '../proxyLogs/reducer';
import { formatOutput } from '../proxyLogs/formatOutput';

interface ProxyLogsOptions {
  service: string;
  follow: boolean;
  blocked: boolean;
  unique: boolean;
  debounce?: string;
}

export function registerProxyLogs(program: Command): void {
  program
    .command('proxy-logs')
    .description(
      "Stream the proxy's tagged access log — how each host was handled " +
        '(ALLOW CRED / ALLOW PASS / ALLOW HTTP / BLOCK TLS / BLOCK HTTP). ' +
        'Foreground process; Ctrl-C to stop.',
    )
    .option('--service <name>', 'docker compose service to read logs from', 'envoy')
    .option('--no-follow', 'print recent history and exit instead of streaming')
    .option('--blocked', 'show only BLOCK lines')
    .option('--unique', 'show each host/handling once for the session')
    .option('--debounce <seconds>', 'collapse repeats of a host/handling within N seconds')
    .action(async (options: ProxyLogsOptions) => {
      const paths = requireEnvPathsOrExit('proxy-logs');
      if (!paths) return;

      if (options.unique && options.debounce !== undefined) {
        console.error('proxy-logs: --unique and --debounce are mutually exclusive');
        process.exitCode = 1;
        return;
      }

      let mode: ReduceMode;
      if (options.unique) {
        mode = { kind: 'unique' };
      } else if (options.debounce !== undefined) {
        const seconds = Number(options.debounce);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          console.error('proxy-logs: --debounce requires a positive number of seconds');
          process.exitCode = 1;
          return;
        }
        mode = { kind: 'debounce', windowMs: seconds * 1000 };
      } else {
        mode = { kind: 'all' };
      }

      const reducer = new Reducer(mode);
      const args = ['compose', 'logs', ...(options.follow ? ['--follow'] : []), options.service];
      const child = execa('docker', args, { cwd: paths.proxy, buffer: false });

      const onSigint = (): void => {
        child.kill('SIGINT');
      };
      process.on('SIGINT', onSigint);

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (raw) => {
          const access = parseLine(raw);
          if (!access) return;
          const entry = classify(access);
          if (!keepEntry(entry, options.blocked)) return;
          for (const out of reducer.push(entry)) {
            console.log(formatOutput(out));
          }
        });
      }

      try {
        await child;
      } catch {
        // Expected when the user Ctrl-C's (we kill the child) or docker exits non-zero.
      } finally {
        process.off('SIGINT', onSigint);
      }
    });
}
```

- [ ] **Step 4: Register the command in `src/cli.ts`**

Add the import alongside the other command imports:

```ts
import { registerProxyLogs } from './commands/proxyLogs';
```

And register it after `registerRunProxy(program);`:

```ts
registerProxyLogs(program);
```

- [ ] **Step 5: Build and run the e2e tests to verify they pass**

Run: `pnpm build && pnpm test:e2e -- cli`
Expected: PASS (new proxy-logs tests plus the existing suite).

- [ ] **Step 6: Commit**

```bash
git add src/commands/proxyLogs.ts src/cli.ts tests/e2e/cli.test.ts
git commit -m "feat: add configamatron proxy-logs command"
```

---

### Task 8: Integration test — Envoy emits CFGM lines

**Files:**
- Modify: `tests/integration/proxy.test.ts`

**Interfaces:**
- Consumes: the running stack from the existing `beforeAll` (mock upstream, `proxyDir`, ports `HTTPS_PORT`/`HTTP_PORT`/`ADMIN_PORT`, `caCertPem`, `requestThroughTerminate`).
- Produces: no exports; asserts each `path-id` marker appears in `docker compose logs`.

- [ ] **Step 1: Write the failing test**

Add a `describe` block at the end of `tests/integration/proxy.test.ts` (after the existing `describe('Envoy sandbox proxy stack', …)` block). It exercises one request per path, then polls the container logs until every marker appears (access logs flush on connection close, so allow a few retries):

```ts
describe('Envoy access logging', () => {
  async function readEnvoyLogs(): Promise<string> {
    const { stdout } = await execa('docker', ['compose', 'logs', '--no-color', 'envoy'], {
      cwd: proxyDir,
      env: {
        ...process.env,
        ENVOY_HTTPS_PORT: String(HTTPS_PORT),
        ENVOY_HTTP_PORT: String(HTTP_PORT),
        ENVOY_ADMIN_PORT: String(ADMIN_PORT),
      },
    });
    return stdout;
  }

  it('emits a CFGM line for terminate, passthrough, port-80, and blocked SNI', async () => {
    // terminate (ALLOW CRED)
    await requestThroughTerminate(PLACEHOLDER_AUTH);

    // passthrough (ALLOW PASS)
    await new Promise<void>((resolve) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'pypi.org', path: '/simple/', headers: { host: 'pypi.org' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // port-80 allowed (ALLOW HTTP)
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: HTTP_PORT, path: '/', headers: { host: 'archive.ubuntu.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });

    // blocked SNI (BLOCK TLS)
    await new Promise<void>((resolve) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port: HTTPS_PORT, servername: 'blocked.example.com' },
        () => socket.end(),
      );
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });

    const markers = ['CFGM|term|', 'CFGM|pass|', 'CFGM|http|', 'CFGM|deny443|'];
    const deadline = Date.now() + 10000;
    let logs = '';
    // Access logs flush on connection close; poll until all markers are present.
    while (Date.now() < deadline) {
      logs = await readEnvoyLogs();
      if (markers.every((m) => logs.includes(m))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const marker of markers) {
      expect(logs).toContain(marker);
    }
    expect(logs).toContain('CFGM|deny443|2026'.slice(0, 12)); // deny443 line present
    expect(logs).toMatch(/CFGM\|deny443\|[^|]*\|blocked\.example\.com\|/);
  });
});
```

- [ ] **Step 2: Build and run the integration test to verify it fails against an un-updated container**

Run: `pnpm build && pnpm test:integration`
Expected: This test FAILS if run against a stack built before Task 1 (no CFGM lines). When run after Task 1's config change it should PASS — the `beforeAll` rebuilds `envoy.yaml` from the current `dist/cli.js`, so ensure `pnpm build` ran first. If it fails, inspect with `docker compose logs envoy` in the env's proxy dir.

- [ ] **Step 3: Run the full integration suite to verify it passes**

Run: `pnpm build && pnpm test:integration`
Expected: PASS (new test plus the existing stack tests). Docker must be running.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/proxy.test.ts
git commit -m "test: assert Envoy emits CFGM access lines for every path"
```

---

### Task 9: Documentation

**Files:**
- Modify: `usage.md`
- Modify: `technical-notes.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a "Watching proxy traffic" section to `usage.md`**

Add this after the "Proxy setup" section (before "VM setup"):

```markdown
## Watching proxy traffic

`configamatron proxy-logs` (run from the environment directory, while the proxy is up) streams how the proxy handled each host:

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)

Flags:

- `--blocked` — only show blocked hosts.
- `--unique` — show each host/handling once for the session.
- `--debounce <seconds>` — collapse repeats of a host/handling within a window; the reprint notes how many were collapsed.
- `--no-follow` — print recent history and exit instead of streaming.

Existing environments created before this feature need `configamatron build-envoy-config` re-run and the proxy restarted (`configamatron run-proxy`) to start emitting access logs.
```

- [ ] **Step 2: Document the log contract in `technical-notes.md`**

Add this subsection under "How the proxy works":

```markdown
### Access logging

Every Envoy path writes a machine-parseable access-log line to the container's stdout:
`CFGM|<path-id>|<start-time>|<server-name>|<authority>|<response-code-details>`, where `path-id` is `term`, `pass`, `http`, or `deny443`. Blocked `:443` connections are caught by `listener_443`'s `default_filter_chain`, which routes to the endpoint-less `blackhole` cluster (dropping the connection) after logging the rejected SNI as `deny443`. The `proxy-logs` command parses these lines and maps them to friendly tags; port-80 allow-vs-block is disambiguated by response-code details (`direct_response` = the default-deny 403). The access-log format never includes the `Authorization` header, so injected tokens never reach the logs.
```

- [ ] **Step 3: Verify formatting**

Run: `pnpm format:check`
Expected: PASS (prettier is `proseWrap=never`; if it complains, run `pnpm format` and re-check).

- [ ] **Step 4: Commit**

```bash
git add usage.md technical-notes.md
git commit -m "docs: document proxy-logs and the CFGM access-log contract"
```

---

### Task 10: Full verification pipeline

**Files:** none (verification only).

- [ ] **Step 1: Run the whole pipeline**

Run: `pnpm test`
Expected: PASS through format:check → lint → typecheck → test:unit → build → test:e2e → test:integration. Docker must be running for the integration stage.

- [ ] **Step 2: Fix and re-run if anything fails**

Address failures at the earliest failing stage, then re-run `pnpm test`. No commit needed unless fixes were made (commit those with a descriptive message).

---

## Self-Review

**Spec coverage:**
- Tag taxonomy (5 tags) → Task 3 `classify` + Task 1 path-ids. ✓
- Catch-all `:443` filter chain → Task 1 `default_filter_chain` + `blackhole`. ✓
- Access log on every path, stdout, structured `CFGM|` prefix → Task 1. ✓
- Credential safety (no Authorization logged) → Task 1 format string (server name / authority / time / code-details only); noted in docs Task 9. ✓
- `RESPONSE_CODE_DETAILS` disambiguates port-80 allow vs block → Task 1 format + Task 3 classify. ✓
- Command data source (`docker compose logs` in `paths.proxy`, env inherited) → Task 7. ✓
- Pipeline stages parse/classify/filter/reduce/format → Tasks 2–6. ✓
- Flags (default follow-all, `--blocked`, `--unique`, `--debounce <seconds>`, `--no-follow`, mutual exclusion, SIGINT→exit 0) → Task 7. ✓
- Dedup key `(domain, TAG)`, debounce count/since from parsed START_TIME → Task 5. ✓
- Tests: unit (Tasks 2–6), envoyConfig unit (Task 1), integration (Task 8), e2e missing-env (Task 7). ✓
- Docs in usage.md + technical-notes.md, rollout note → Task 9. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows complete code. ✓

**Type consistency:** `AccessLine`/`PathId` (Task 2) consumed by `classify` (Task 3); `Entry`/`Tag` (Task 3) consumed by `keepEntry` (Task 4), `Reducer` (Task 5); `OutputLine` (Task 5) consumed by `formatOutput` (Task 6); all consumed by the command (Task 7). Names (`parseLine`, `classify`, `keepEntry`, `Reducer.push`, `formatOutput`, `registerProxyLogs`) match across producer and consumer tasks. ✓
