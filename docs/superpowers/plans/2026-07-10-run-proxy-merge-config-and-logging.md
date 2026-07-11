# Merge config generation and logging into `run-proxy` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-10-run-proxy-merge-config-and-logging-design.md`

**Goal:** `run-proxy` becomes the single command that builds the Envoy config from the allowlist, keeps the Claude credential fresh, watches `allowlist.txt` (reissuing the leaf certificate when terminate hosts change), and streams the proxy's tagged access log inline — while `build-envoy-config` and `proxy-logs` are deleted.

**Architecture:** `runProxyLoop` stays a pure dependency-injected state machine, extended with a second watcher (allowlist), a serialized restart pipeline with per-source dirty flags for coalescing, and an inline log pipeline (`parseLine` → `classify` → unique dedup → `formatOutput`). Shared helpers are extracted so the CLI, `generate-ca`, and unit tests call the same code: `src/leaf.ts` (leaf reissue) and `src/runProxy/buildConfig.ts` (envoy.yaml writer). The integration/VM harnesses stop calling `build-envoy-config` + `docker compose up` and instead launch `run-proxy` as a background process whose stdout they capture and assert on.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), commander, execa, `watcher` package, vitest, Docker Compose, node-forge (existing `src/ca.ts`).

## Global Constraints

- Node >= 18, pnpm. Build with `pnpm build` (tsup → `dist/cli.js`); e2e/integration/vm tests run against `dist/cli.js`, so **build before running them**.
- Test commands: `pnpm test:unit`, `pnpm test:e2e`, `pnpm test:integration` (needs Docker), `pnpm test:vm` (needs WSL2 harness; slow), full gate `pnpm test` (format check + lint + typecheck + unit + build + e2e + integration).
- Run `pnpm format` before each commit (prettier check is part of `pnpm test`).
- Commit directly to `main` (user preference — no feature branches). Non-trivial commits get detailed, narrative commit messages (what/why/evidence).
- Exact user-visible strings (VM tests and unit tests grep for these; the dash is an em dash `—`):
  - `run-proxy: restarting proxy — allowlist changed`
  - `run-proxy: restarting proxy — credentials changed`
  - Invalid allowlist edit while running: `run-proxy: allowlist has unsupported wildcard syntax, keeping previous config:` followed by `  - <entry>` lines
  - Invalid allowlist at startup (fatal): `run-proxy: unsupported wildcard syntax in <allowlistPath>:` followed by `  - <entry>` lines
  - Missing CA: `run-proxy: proxy CA not found in <caDir> — run 'configamatron generate-ca' first`
  - SIGINT: `run-proxy: SIGINT received, stopping (container left running)` — printed at most once per process
- Log output line format is exactly `HH:MM:SS  TAG  domain` (two spaces between fields). Logging is unconditional and always unique per `tag + domain`.
- Logging/allowlist behavior per spec: unique tracking is **cleared wholesale** on an allowlist-triggered restart, **preserved** across a credential-triggered restart; when both changed during one in-flight restart, the follow-up restart clears (allowlist wins).

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/commands/proxyLogs.ts` | delete (Task 1) | — |
| `src/runProxy/parseLine.ts` | moved from `src/proxyLogs/` (Task 2) | CFGM access-log line parser (unchanged) |
| `src/runProxy/classify.ts` | moved from `src/proxyLogs/` (Task 2) | path-id → ALLOW/BLOCK tag (unchanged) |
| `src/runProxy/killProcessTree.ts` | moved from `src/proxyLogs/` (Task 2) | cross-platform tree kill (unchanged) |
| `src/runProxy/formatOutput.ts` | rewritten (Task 2) | `Entry` → `HH:MM:SS  TAG  domain` (debounce branch dropped) |
| `src/runProxy/uniqueTracker.ts` | new (Task 2) | replaces `Reducer`'s unique mode; adds `clear()` |
| `src/proxyLogs/reducer.ts`, `src/proxyLogs/entryFilter.ts` | delete (Task 2) | — |
| `src/leaf.ts` | new (Task 3) | `ensureLeaf` + `sameHosts` extracted from `generateCa.ts`, shared by `generate-ca` and `run-proxy` |
| `src/commands/generateCa.ts` | modify (Task 3) | imports `ensureLeaf` from `../leaf` |
| `src/runProxy/buildConfig.ts` | new (Task 4) | `writeEnvoyConfig(allowlist, outputPath, overrides)` — render + write envoy.yaml |
| `src/runProxy/watchFile.ts` | renamed from `watchCredentials.ts` (Task 5) | generic parent-dir/basename file watcher |
| `src/runProxy/logStream.ts` | new (Task 5) | `docker compose logs --follow` child + line callback + tree-kill stop |
| `src/runProxy/runProxyLoop.ts` | rewritten (Task 6) | two watchers, serialized coalescing restarts, inline logging, SIGINT fix |
| `src/commands/runProxy.ts` | rewritten (Task 7) | new prereq checks, `--upstream-override`, wires new deps |
| `tests/proxyStack.ts` | rewritten (Task 7) | drives the stack through a background `run-proxy`, captures stdout |
| `tests/integration/runProxy.test.ts` | modify (Task 7) | drop `build-envoy-config` step, stage allowlist, tree-kill teardown |
| `src/commands/buildEnvoyConfig.ts` | delete (Task 8) | — |
| `src/cli.ts`, `src/commands/init.ts` | modify (Tasks 1/8) | deregister commands, renumber next-steps |
| `tests/vm/vm.test.ts` | modify (Task 9) | S2b describe: inline-logging assertions across both restart kinds |
| `usage.md`, `technical-notes.md` | modify (Task 10) | new single-command workflow |

---

### Task 1: Delete the `proxy-logs` command

Nothing depends on `src/commands/proxyLogs.ts` except `src/cli.ts` and three e2e tests. Removing it first unblocks relocating `src/proxyLogs/` (Task 2) without breaking typecheck.

**Files:**
- Delete: `src/commands/proxyLogs.ts`
- Modify: `src/cli.ts`
- Modify: `tests/e2e/cli.test.ts` (remove 3 tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `src/cli.ts` no longer imports/registers `registerProxyLogs`. `src/proxyLogs/*` modules become referenced only by their own unit tests.

- [ ] **Step 1: Delete the command file and deregister it**

```powershell
git rm src/commands/proxyLogs.ts
```

In `src/cli.ts`, remove these two lines:

```ts
import { registerProxyLogs } from './commands/proxyLogs';
```

```ts
registerProxyLogs(program);
```

- [ ] **Step 2: Remove the three proxy-logs e2e tests**

In `tests/e2e/cli.test.ts`, delete these three complete `it(...)` blocks (they sit at the end of the `describe('write-github-config', ...)` block, lines ~258–295):

- `it('lists proxy-logs with its flags in help output', ...)`
- `it('proxy-logs exits 1 without an environment', ...)`
- `it('proxy-logs rejects --unique together with --debounce', ...)`

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all PASS (unit tests for `src/proxyLogs/*` still exist and still pass — the library modules remain until Task 2).

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "refactor: remove the proxy-logs command (logging moves into run-proxy)"
```

---

### Task 2: Relocate the log pipeline under `src/runProxy/`

Move the kept pieces (`parseLine`, `classify`, `killProcessTree`), simplify `formatOutput` to the unique-only world (no debounce counts), and replace `Reducer` with a `UniqueTracker` that supports `clear()`. Delete `reducer.ts` and `entryFilter.ts`.

**Files:**
- Move (unchanged content): `src/proxyLogs/parseLine.ts` → `src/runProxy/parseLine.ts`; `src/proxyLogs/classify.ts` → `src/runProxy/classify.ts`; `src/proxyLogs/killProcessTree.ts` → `src/runProxy/killProcessTree.ts`
- Create: `src/runProxy/formatOutput.ts` (rewritten), `src/runProxy/uniqueTracker.ts`
- Delete: `src/proxyLogs/reducer.ts`, `src/proxyLogs/entryFilter.ts`, `src/proxyLogs/formatOutput.ts` (whole `src/proxyLogs/` directory ends up empty)
- Move tests: `tests/unit/proxyLogs/parseLine.test.ts`, `classify.test.ts`, `killProcessTree.test.ts` → `tests/unit/runProxy/` (import path fix only)
- Create: `tests/unit/runProxy/uniqueTracker.test.ts`, rewrite `tests/unit/runProxy/formatOutput.test.ts`
- Delete: `tests/unit/proxyLogs/reducer.test.ts`, `tests/unit/proxyLogs/entryFilter.test.ts` (whole `tests/unit/proxyLogs/` directory ends up empty)

**Interfaces:**
- Consumes: `Entry`/`Tag` from `classify.ts`, `AccessLine` from `parseLine.ts` (both unchanged).
- Produces (used by Tasks 5–7):
  - `parseLine(raw: string): AccessLine | null` at `src/runProxy/parseLine.ts`
  - `classify(line: AccessLine): Entry` at `src/runProxy/classify.ts`
  - `formatOutput(entry: Entry): string` at `src/runProxy/formatOutput.ts` — **signature change** (takes `Entry`, no `OutputLine`)
  - `class UniqueTracker { shouldPrint(entry: Entry): boolean; clear(): void }` at `src/runProxy/uniqueTracker.ts`
  - `killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void>` at `src/runProxy/killProcessTree.ts`

- [ ] **Step 1: Write the failing tests for the new modules**

Create `tests/unit/runProxy/uniqueTracker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { UniqueTracker } from '../../../src/runProxy/uniqueTracker';
import type { Entry } from '../../../src/runProxy/classify';

function e(domain: string, tag: Entry['tag'] = 'ALLOW PASS'): Entry {
  return { time: '2026-07-10T12:00:00', tag, domain };
}

describe('UniqueTracker', () => {
  it('prints the first occurrence of each tag+domain only', () => {
    const t = new UniqueTracker();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
    expect(t.shouldPrint(e('github.com'))).toBe(false);
    // different tag for the same domain is a different key
    expect(t.shouldPrint(e('github.com', 'BLOCK TLS'))).toBe(true);
    // different domain is a different key
    expect(t.shouldPrint(e('pypi.org'))).toBe(true);
  });

  it('clear() forgets everything so previously-seen keys print again', () => {
    const t = new UniqueTracker();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
    t.clear();
    expect(t.shouldPrint(e('github.com'))).toBe(true);
  });
});
```

Replace the entire content of `tests/unit/proxyLogs/formatOutput.test.ts` by creating `tests/unit/runProxy/formatOutput.test.ts` (the debounce-reprint case is dropped along with debounce mode):

```ts
import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../../src/runProxy/formatOutput';

describe('formatOutput', () => {
  it('formats an entry as time  TAG  domain', () => {
    expect(
      formatOutput({ time: '2026-07-06T12:04:31', tag: 'BLOCK TLS', domain: 'nope.example.com' }),
    ).toBe('12:04:31  BLOCK TLS  nope.example.com');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm vitest run tests/unit/runProxy/uniqueTracker.test.ts tests/unit/runProxy/formatOutput.test.ts`
Expected: FAIL — `Cannot find module '../../../src/runProxy/uniqueTracker'` (and formatOutput).

- [ ] **Step 3: Move the unchanged modules and write the new ones**

```powershell
git mv src/proxyLogs/parseLine.ts src/runProxy/parseLine.ts
git mv src/proxyLogs/classify.ts src/runProxy/classify.ts
git mv src/proxyLogs/killProcessTree.ts src/runProxy/killProcessTree.ts
git rm src/proxyLogs/reducer.ts src/proxyLogs/entryFilter.ts src/proxyLogs/formatOutput.ts
```

(`classify.ts` imports `./parseLine` relatively, so it needs no edit.)

Create `src/runProxy/uniqueTracker.ts`:

```ts
import type { Entry } from './classify';

/**
 * Tracks which host+handling pairs have already been printed. Replaces the old
 * proxy-logs Reducer: logging is always-unique now, so all that remains is a
 * seen-set — plus clear(), because an allowlist-triggered restart resets
 * tracking wholesale while a credential-triggered restart preserves it.
 */
export class UniqueTracker {
  private readonly seen = new Set<string>();

  /** True the first time a given tag+domain is seen (and records it). */
  shouldPrint(entry: Entry): boolean {
    const key = `${entry.tag} ${entry.domain}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}
```

Create `src/runProxy/formatOutput.ts`:

```ts
import type { Entry } from './classify';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(entry: Entry): string {
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}`;
}
```

- [ ] **Step 4: Move the surviving tests and delete the dead ones**

```powershell
git mv tests/unit/proxyLogs/parseLine.test.ts tests/unit/runProxy/parseLine.test.ts
git mv tests/unit/proxyLogs/classify.test.ts tests/unit/runProxy/classify.test.ts
git mv tests/unit/proxyLogs/killProcessTree.test.ts tests/unit/runProxy/killProcessTree.test.ts
git rm tests/unit/proxyLogs/reducer.test.ts tests/unit/proxyLogs/entryFilter.test.ts tests/unit/proxyLogs/formatOutput.test.ts
```

Fix the import paths in the three moved test files (`tests/unit/proxyLogs/` and `tests/unit/runProxy/` are at the same depth, so only the directory name changes):

- `parseLine.test.ts`: `'../../../src/proxyLogs/parseLine'` → `'../../../src/runProxy/parseLine'`
- `classify.test.ts`: `'../../../src/proxyLogs/classify'` → `'../../../src/runProxy/classify'` and `'../../../src/proxyLogs/parseLine'` → `'../../../src/runProxy/parseLine'`
- `killProcessTree.test.ts`: `'../../../src/proxyLogs/killProcessTree'` → `'../../../src/runProxy/killProcessTree'` (the `../../fixtures/processTree/parent.mjs` fixture path stays the same)

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS. `src/proxyLogs/` and `tests/unit/proxyLogs/` no longer exist (git-removed; confirm no stray files with `git status`).

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "refactor: relocate log pipeline to src/runProxy, replace Reducer with UniqueTracker"
```

---

### Task 3: Shared leaf issuance — `src/leaf.ts`

Extract `ensureLeaf` (and its `sameHosts` helper) from `src/commands/generateCa.ts` into a shared module so `run-proxy` can reissue the leaf when terminate hosts change. `generate-ca` keeps identical behavior.

**Files:**
- Create: `src/leaf.ts`
- Modify: `src/commands/generateCa.ts`
- Test: `tests/unit/leaf.test.ts`

**Interfaces:**
- Consumes: `generateLeaf`, `validateCaPair`, `isSignedBy`, `certSans` from `src/ca.ts`; `EnvPaths` from `src/envPaths.ts` (all existing, unchanged).
- Produces: `ensureLeaf(paths: EnvPaths, caCertPem: string, caKeyPem: string, sans: string[]): string` — ensures `paths.caLeafCert`/`paths.caLeafKey` hold a valid leaf for `sans` signed by the given root; reuses a still-valid leaf; returns a human-readable status (`'issued leaf for N host(s)'` / `'reused leaf for N host(s)'` / `'no terminate hosts in the allowlist, skipped leaf'`). Task 7's command wiring calls this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/leaf.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLeaf } from '../../src/leaf';
import { generateRootCa, certSans, isSignedBy } from '../../src/ca';
import { envPaths, type EnvPaths } from '../../src/envPaths';

let dir: string;
let paths: EnvPaths;
let caCertPem: string;
let caKeyPem: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'leaf-test-'));
  paths = envPaths(dir);
  mkdirSync(paths.caDir, { recursive: true });
  const root = generateRootCa();
  caCertPem = root.caCertPem;
  caKeyPem = root.caKeyPem;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureLeaf', () => {
  it('skips when there are no terminate hosts', () => {
    expect(ensureLeaf(paths, caCertPem, caKeyPem, [])).toContain('skipped leaf');
  });

  it('issues a leaf signed by the root with the requested SANs', () => {
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['api.anthropic.com']);
    expect(status).toContain('issued leaf for 1 host(s)');
    const leafPem = readFileSync(paths.caLeafCert, 'utf8');
    expect(isSignedBy(leafPem, caCertPem)).toBe(true);
    expect(certSans(leafPem)).toEqual(['api.anthropic.com']);
  });

  it('reuses a valid leaf when the SAN set is unchanged (order-insensitive)', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'b.example.com']);
    const before = readFileSync(paths.caLeafCert, 'utf8');
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['b.example.com', 'a.example.com']);
    expect(status).toContain('reused leaf for 2 host(s)');
    expect(readFileSync(paths.caLeafCert, 'utf8')).toBe(before);
  });

  it('reissues when the SAN set changes', () => {
    ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com']);
    const status = ensureLeaf(paths, caCertPem, caKeyPem, ['a.example.com', 'new.example.com']);
    expect(status).toContain('issued leaf for 2 host(s)');
    expect(certSans(readFileSync(paths.caLeafCert, 'utf8')).sort()).toEqual([
      'a.example.com',
      'new.example.com',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/leaf.test.ts`
Expected: FAIL — `Cannot find module '../../src/leaf'`.

- [ ] **Step 3: Create `src/leaf.ts` (moved verbatim from `generateCa.ts`, plus exports)**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EnvPaths } from './envPaths';
import { generateLeaf, validateCaPair, isSignedBy, certSans } from './ca';

function sameHosts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, i) => value === sb[i]);
}

/** Ensure a valid leaf for `sans` exists, signed by the given root. Returns a status word. */
export function ensureLeaf(
  paths: EnvPaths,
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): string {
  if (sans.length === 0) return 'no terminate hosts in the allowlist, skipped leaf';

  const leafValid =
    existsSync(paths.caLeafCert) &&
    existsSync(paths.caLeafKey) &&
    (() => {
      const leafCertPem = readFileSync(paths.caLeafCert, 'utf8');
      const leafKeyPem = readFileSync(paths.caLeafKey, 'utf8');
      return (
        validateCaPair(leafCertPem, leafKeyPem) &&
        isSignedBy(leafCertPem, caCertPem) &&
        sameHosts(certSans(leafCertPem), sans)
      );
    })();

  if (leafValid) return `reused leaf for ${sans.length} host(s)`;

  const { leafCertPem, leafKeyPem } = generateLeaf(caCertPem, caKeyPem, sans);
  writeFileSync(paths.caLeafCert, leafCertPem);
  writeFileSync(paths.caLeafKey, leafKeyPem);
  return `issued leaf for ${sans.length} host(s)`;
}
```

- [ ] **Step 4: Point `generateCa.ts` at the shared module**

In `src/commands/generateCa.ts`:
1. Delete the local `sameHosts` and `ensureLeaf` function definitions (lines ~7–42).
2. Add the import and trim the now-unneeded `src/ca.ts` imports:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit, type EnvPaths } from '../envPaths';
import { parseAllowlist, terminateTlsHosts } from '../allowlist';
import { generateRootCa, validateCaPair } from '../ca';
import { ensureLeaf } from '../leaf';
```

(`deriveSans` stays in `generateCa.ts` unchanged; the command body is otherwise untouched.)

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: PASS, including the existing `tests/e2e/generateCa.test.ts` (behavior unchanged).

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "refactor: extract ensureLeaf into src/leaf.ts for reuse by run-proxy"
```

---

### Task 4: Shared config writer — `src/runProxy/buildConfig.ts`

Extract the render-and-write step of `build-envoy-config` so `run-proxy` (and tests) can build `envoy.yaml` from an already-parsed allowlist. Allowlist reading/validation stays with the caller (`runProxyLoop` handles invalid entries differently at startup vs. on change).

**Files:**
- Create: `src/runProxy/buildConfig.ts`
- Test: `tests/unit/runProxy/buildConfig.test.ts`

**Interfaces:**
- Consumes: `generateEnvoyConfig(allowlist, { overrides })` and `UpstreamOverride` from `src/envoyConfig.ts`; `Allowlist` from `src/allowlist.ts`; `stringify` from `yaml`.
- Produces: `writeEnvoyConfig(allowlist: Allowlist, outputPath: string, overrides: UpstreamOverride[]): void` — Task 7's command wiring calls this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/buildConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { writeEnvoyConfig } from '../../../src/runProxy/buildConfig';
import { parseAllowlist } from '../../../src/allowlist';

const ALLOWLIST = ['# passthrough', 'pypi.org:443', '', '# terminate', 'api.anthropic.com:443', ''].join('\n');

describe('writeEnvoyConfig', () => {
  it('writes envoy.yaml with upstream overrides applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildconfig-'));
    const outputPath = join(dir, 'envoy.yaml');
    try {
      writeEnvoyConfig(parseAllowlist(ALLOWLIST), outputPath, [
        { sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' },
      ]);

      const config = parse(readFileSync(outputPath, 'utf8')) as {
        static_resources: { clusters: Array<{ name: string; load_assignment: any }> };
      };
      const cluster = config.static_resources.clusters.find(
        (c) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(cluster).toBeDefined();
      expect(
        cluster!.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/runProxy/buildConfig.test.ts`
Expected: FAIL — `Cannot find module '../../../src/runProxy/buildConfig'`.

- [ ] **Step 3: Create `src/runProxy/buildConfig.ts`**

```ts
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { generateEnvoyConfig, type UpstreamOverride } from '../envoyConfig';
import type { Allowlist } from '../allowlist';

/**
 * Render envoy.yaml for an already-parsed (and already-validated) allowlist
 * and write it to outputPath. Validation of `allowlist.invalid` is the
 * caller's job: run-proxy treats invalid entries as fatal at startup but as
 * keep-previous-config on a live edit.
 */
export function writeEnvoyConfig(
  allowlist: Allowlist,
  outputPath: string,
  overrides: UpstreamOverride[],
): void {
  writeFileSync(outputPath, stringify(generateEnvoyConfig(allowlist, { overrides })));
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/unit/runProxy/buildConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: shared writeEnvoyConfig helper under src/runProxy"
```

---

### Task 5: Generic file watcher + log-follow child

Rename `watchCredentials` to a generic `watchFile` (it already watches parent-dir + basename; only the name and doc comment are credential-specific), and add `logStream.ts`, the `docker compose logs --follow` child manager.

**Files:**
- Rename: `src/runProxy/watchCredentials.ts` → `src/runProxy/watchFile.ts`
- Create: `src/runProxy/logStream.ts`
- Modify: `src/commands/runProxy.ts` (import rename only — the full rewrite happens in Task 7)

**Interfaces:**
- Consumes: `watcher` package (existing dependency); `killProcessTree` from Task 2; `execa`.
- Produces (used by Tasks 6–7):
  - `watchFile(filePath: string, onEvent: () => void): { close: () => void }`
  - `interface LogStreamHandle { stop: () => Promise<void> }`
  - `startLogStream(serviceName: string, composeDir: string, onLine: (raw: string) => void): LogStreamHandle`

No unit test for `logStream.ts`: it is a thin wrapper whose only behavior is spawning `docker`, and `killProcessTree` (its risky part) already has a real-process unit test. Its end-to-end behavior — including re-attach after recreate — is covered by the VM assertions in Task 9.

- [ ] **Step 1: Rename the watcher**

```powershell
git mv src/runProxy/watchCredentials.ts src/runProxy/watchFile.ts
```

Replace the file's content (generalized name + doc; the mechanics are identical):

```ts
import Watcher from 'watcher';
import { basename, dirname } from 'node:path';

/**
 * Watch a single file for changes. Watches the parent directory
 * non-recursively and filters to the target basename, because editors and
 * Claude Code rewrite files via atomic rename (new inode) — the case where raw
 * fs.watch silently goes dead on Windows. The `watcher` package handles
 * rename/replace and debouncing cross-platform. Used for both credentials.json
 * and allowlist.txt.
 */
export function watchFile(filePath: string, onEvent: () => void): { close: () => void } {
  const dir = dirname(filePath);
  const target = basename(filePath);

  const watcher = new Watcher(dir, {
    recursive: false,
    ignoreInitial: true,
    debounce: 200,
    renameDetection: true,
  });

  watcher.on('all', (_event: string, targetPath: string) => {
    if (basename(targetPath) === target) {
      onEvent();
    }
  });

  return { close: () => watcher.close() };
}
```

In `src/commands/runProxy.ts`, update the import and the deps wiring (two mechanical edits; the file is otherwise rewritten in Task 7):

- `import { watchCredentials } from '../runProxy/watchCredentials';` → `import { watchFile } from '../runProxy/watchFile';`
- `watch: watchCredentials,` → `watch: watchFile,`

- [ ] **Step 2: Create `src/runProxy/logStream.ts`**

```ts
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { killProcessTree } from './killProcessTree';

export interface LogStreamHandle {
  stop: () => Promise<void>;
}

/**
 * Follow the proxy container's log via `docker compose logs --follow` and feed
 * every raw line to onLine. run-proxy starts a fresh follow right after each
 * force-recreate — a follow attached to the previous container dies with it —
 * so no --tail/--since handling is needed: a fresh container's history is
 * empty and the follow sees every line from its birth.
 */
export function startLogStream(
  serviceName: string,
  composeDir: string,
  onLine: (raw: string) => void,
): LogStreamHandle {
  const child = execa('docker', ['compose', 'logs', '--follow', serviceName], {
    cwd: composeDir,
    buffer: false,
    detached: process.platform !== 'win32',
  });

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', onLine);
  }

  // Swallow the rejection produced by killing the child (or docker exiting
  // non-zero); stop() awaits this so the pipe is fully closed before returning.
  const finished = child.catch(() => {});

  return {
    stop: async () => {
      if (child.pid !== undefined) {
        await killProcessTree(child.pid, 'SIGINT');
      } else {
        child.kill('SIGINT');
      }
      await finished;
    },
  };
}
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat: generic watchFile and docker-logs follow child for run-proxy"
```

---

### Task 6: Rework `runProxyLoop` — allowlist watch, serialized restarts, inline logging, SIGINT fix

The core task. `runProxyLoop` gains: an allowlist watcher armed at startup (before the first recreate), a serialized restart pipeline with per-source dirty flags (coalescing bursts into single follow-up restarts), config build + leaf reissue on allowlist changes (invalid edits keep the previous config), inline log-line processing with a `UniqueTracker` (cleared on allowlist restarts, preserved on credential restarts), and a shutdown path that tears down every handle and ignores a second SIGINT.

**Files:**
- Rewrite: `src/runProxy/runProxyLoop.ts`
- Rewrite: `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**
- Consumes: `parseAllowlist`, `terminateTlsHosts`, `Allowlist` from `src/allowlist.ts`; `parseLine`, `classify`, `formatOutput`, `UniqueTracker` from Task 2; `planNextActions` and `types.ts` (unchanged).
- Produces (Task 7 wires these):

```ts
export interface RunProxyConfig {
  credentialsPath: string;
  allowlistPath: string; // NEW
  secretPath: string;
  serviceName: string;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface RunProxyDeps {
  readCredentials: (path: string) => Credentials | null;
  readAllowlist: (path: string) => string | null; // NEW: raw content, null when unreadable
  writeSecret: (token: string, path: string) => void;
  buildConfig: (allowlist: Allowlist) => void; // NEW: render+write envoy.yaml (overrides baked in by caller)
  ensureLeaf: (sans: string[]) => string; // NEW: reissue leaf if needed, returns status line
  recreateContainer: (serviceName: string) => Promise<void>;
  nudgeRefresh: () => Promise<NudgeResult>;
  watch: (path: string, onEvent: () => void) => { close: () => void }; // used for BOTH files
  startLogStream: (onLine: (raw: string) => void) => void; // NEW
  stopLogStream: () => Promise<void>; // NEW: resolves when the child is gone; no-op when none
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}
```

- [ ] **Step 1: Rewrite the test file (failing tests first)**

Replace the entire content of `tests/unit/runProxy/runProxyLoop.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runProxyLoop,
  type RunProxyConfig,
  type RunProxyDeps,
} from '../../../src/runProxy/runProxyLoop';
import type { Credentials } from '../../../src/runProxy/types';

const MIN = 60_000;

const VALID_ALLOWLIST = [
  '# passthrough',
  'pypi.org:443',
  '',
  '# terminate',
  'api.anthropic.com:443',
  '',
].join('\n');

const INVALID_ALLOWLIST = ['# terminate', '*.bad.example.com:443', ''].join('\n');

const PASS_LINE = 'envoy-1  | CFGM|pass|2026-07-10T12:00:00|pypi.org|-|-';
const CRED_LINE =
  'envoy-1  | CFGM|term|2026-07-10T12:00:01|api.anthropic.com|api.anthropic.com|via_upstream';

function baseConfig(overrides: Partial<RunProxyConfig> = {}): RunProxyConfig {
  return {
    credentialsPath: '/fake/.credentials.json',
    allowlistPath: '/fake/allowlist.txt',
    secretPath: '/fake/sds-secret.yaml',
    serviceName: 'envoy',
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

interface Harness {
  deps: RunProxyDeps;
  creds: { value: Credentials };
  allowlist: { value: string | null };
  fireCredentials: () => void;
  fireAllowlist: () => void;
  fireSigint: () => void;
  feedLogLine: (raw: string) => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn>;
    recreateContainer: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn>;
    buildConfig: ReturnType<typeof vi.fn>;
    ensureLeaf: ReturnType<typeof vi.fn>;
    startLogStream: ReturnType<typeof vi.fn>;
    stopLogStream: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(initial: Credentials, initialAllowlist: string | null = VALID_ALLOWLIST): Harness {
  const creds = { value: initial };
  const allowlist = { value: initialAllowlist };
  let credentialsCb: (() => void) | null = null;
  let allowlistCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  let onLine: ((raw: string) => void) | null = null;
  const watchClose = vi.fn();
  const mocks = {
    writeSecret: vi.fn(),
    recreateContainer: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    buildConfig: vi.fn(),
    ensureLeaf: vi.fn().mockReturnValue('reused leaf for 1 host(s)'),
    startLogStream: vi.fn((cb: (raw: string) => void) => {
      onLine = cb;
    }),
    stopLogStream: vi.fn().mockResolvedValue(undefined),
    watchClose,
    log: vi.fn(),
    error: vi.fn(),
  };
  const deps: RunProxyDeps = {
    readCredentials: () => creds.value,
    readAllowlist: () => allowlist.value,
    writeSecret: mocks.writeSecret,
    buildConfig: mocks.buildConfig,
    ensureLeaf: mocks.ensureLeaf,
    recreateContainer: mocks.recreateContainer,
    nudgeRefresh: mocks.nudgeRefresh,
    watch: (path, onEvent) => {
      if (path.endsWith('.credentials.json')) credentialsCb = onEvent;
      else allowlistCb = onEvent;
      return { close: watchClose };
    },
    startLogStream: mocks.startLogStream,
    stopLogStream: mocks.stopLogStream,
    onSigint: (handler) => {
      sigintCb = handler;
    },
    log: mocks.log,
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    allowlist,
    fireCredentials: () => credentialsCb?.(),
    fireAllowlist: () => allowlistCb?.(),
    fireSigint: () => sigintCb?.(),
    feedLogLine: (raw) => onLine?.(raw),
    mocks,
  };
}

/** Flush pending microtasks + zero-delay timers so async startup/handlers settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProxyLoop startup', () => {
  it('builds config, ensures leaf, writes secret, recreates, starts the log stream', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].terminate).toEqual(['api.anthropic.com:443']);
    expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(1);
  });

  it('exits 1 on an invalid allowlist without touching docker', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, INVALID_ALLOWLIST);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('unsupported wildcard syntax'),
    );
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('*.bad.example.com:443'));
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });

  it('exits 1 when the allowlist is unreadable', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN }, null);
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('could not read allowlist'));
  });

  it('applies an allowlist change that lands during the startup recreate right after start', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    let release!: () => void;
    h.mocks.recreateContainer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    void runProxyLoop(baseConfig(), h.deps);
    await flush(); // startup recreate in flight; both watchers already armed

    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nlate.example.com:443',
    );
    h.fireAllowlist();
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1); // still just the startup one

    release();
    await flush();

    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // startup + coalesced follow-up
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(2);
    expect(h.mocks.buildConfig.mock.calls[1][0].passthrough).toContain('late.example.com:443');
  });
});

describe('runProxyLoop inline logging', () => {
  it('prints each parsed host+handling once and ignores non-CFGM lines', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();

    h.feedLogLine('[2026-07-10 12:00:00.000][1][info][main] envoy operational line');
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(PASS_LINE);
    h.feedLogLine(CRED_LINE);

    expect(h.mocks.log.mock.calls.map((c) => c[0])).toEqual([
      '12:00:00  ALLOW PASS  pypi.org',
      '12:00:01  ALLOW CRED  api.anthropic.com',
    ]);
  });
});

describe('runProxyLoop allowlist changes', () => {
  it('rebuilds config, reissues leaf, restarts, and clears unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org now tracked as seen
    h.mocks.buildConfig.mockClear();
    h.mocks.ensureLeaf.mockClear();
    h.mocks.recreateContainer.mockClear();
    h.mocks.log.mockClear();

    h.allowlist.value = VALID_ALLOWLIST.replace(
      'pypi.org:443',
      'pypi.org:443\nexample.org:443',
    );
    h.fireAllowlist();
    await flush();

    expect(h.mocks.ensureLeaf).toHaveBeenCalledWith(['api.anthropic.com']);
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.buildConfig.mock.calls[0][0].passthrough).toContain('example.org:443');
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — allowlist changed');
    expect(h.mocks.stopLogStream).toHaveBeenCalledTimes(1);
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
    expect(h.mocks.startLogStream).toHaveBeenCalledTimes(2); // startup + after restart

    // Unique tracking was cleared: the same host+handling prints again.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });

  it('keeps the previous config on an invalid edit and stays live for the fix', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.buildConfig.mockClear();
    h.mocks.recreateContainer.mockClear();

    h.allowlist.value = INVALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();

    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'allowlist has unsupported wildcard syntax, keeping previous config',
      ),
    );
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('*.bad.example.com:443'));
    expect(h.mocks.buildConfig).not.toHaveBeenCalled();
    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();

    // The watcher stayed live: fixing the file triggers a fresh attempt.
    h.allowlist.value = VALID_ALLOWLIST;
    h.fireAllowlist();
    await flush();
    expect(h.mocks.buildConfig).toHaveBeenCalledTimes(1);
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
  });
});

describe('runProxyLoop credential changes', () => {
  it('propagates a changed token: writeSecret + restart, preserving unique tracking', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // pypi.org tracked as seen
    h.mocks.writeSecret.mockClear();
    h.mocks.recreateContainer.mockClear();
    h.mocks.log.mockClear();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
    expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — credentials changed');

    // Unique tracking survived the credential restart.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).not.toHaveBeenCalled();
    h.feedLogLine(CRED_LINE); // a new key still prints (stream is live)
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:01  ALLOW CRED  api.anthropic.com');
  });

  it('does not restart when the token is unchanged', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
    h.fireCredentials();
    await flush();

    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });

  it('retries a docker failure once during a restart, then exits non-zero', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.recreateContainer.mockRejectedValue(new Error('docker boom'));
    h.mocks.recreateContainer.mockClear();
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // initial + one retry
    await expect(exit).resolves.toBe(1);
  });
});

describe('runProxyLoop coalescing', () => {
  it('collapses events during an in-flight restart into exactly one follow-up restart', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    let release!: () => void;
    h.mocks.recreateContainer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    h.fireAllowlist(); // restart 1 begins; its recreate is blocked
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);

    h.fireAllowlist(); // two more edits land mid-restart
    h.fireAllowlist();
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1); // nothing new while in flight

    release();
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // exactly one follow-up
  });

  it('clears unique tracking when both sources changed during an in-flight restart', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.feedLogLine(PASS_LINE); // tracked
    h.mocks.recreateContainer.mockClear();

    // A credentials-only restart starts (unique would be preserved by itself)…
    let release!: () => void;
    h.mocks.recreateContainer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);

    // …and BOTH change while it is in flight.
    h.creds.value = { accessToken: 'C', expiresAt: 60 * MIN };
    h.fireCredentials();
    h.allowlist.value = VALID_ALLOWLIST.replace('pypi.org:443', 'pypi.org:443\nboth.example.com:443');
    h.fireAllowlist();
    await flush();

    release();
    await flush();
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // one follow-up for both

    // The follow-up included the allowlist change, so unique was cleared.
    h.mocks.log.mockClear();
    h.feedLogLine(PASS_LINE);
    expect(h.mocks.log).toHaveBeenCalledWith('12:00:00  ALLOW PASS  pypi.org');
  });
});

describe('runProxyLoop refresh nudging', () => {
  it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
    // expiresAt within the refresh window so the nudge fires immediately at startup.
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush(); // startup arms nudge at now -> fires -> doNudge #1

    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #1 -> doNudge #2
    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #2 -> doNudge #3
    await vi.advanceTimersByTimeAsync(2 * MIN); // deadline -> fail #3 -> exit

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
    expect(h.mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('token did not refresh after 3 attempts'),
    );
  });

  it('resets the failure counter when a refresh succeeds mid-sequence', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush(); // doNudge #1
    await vi.advanceTimersByTimeAsync(2 * MIN); // fail #1 -> doNudge #2

    // Simulate the refresh landing: expiresAt advances far out.
    h.creds.value = { accessToken: 'A', expiresAt: 60 * MIN };
    h.fireCredentials();
    await flush();

    // Two more no-advance intervals would have exited if the counter had not reset.
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

describe('runProxyLoop shutdown', () => {
  it('SIGINT tears everything down once and exits 0; a second SIGINT is a no-op', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.log.mockClear();
    h.mocks.recreateContainer.mockClear();

    h.fireSigint();
    h.fireSigint();
    await flush();

    await expect(exit).resolves.toBe(0);
    const sigintLogs = h.mocks.log.mock.calls.filter((c) => String(c[0]).includes('SIGINT'));
    expect(sigintLogs).toHaveLength(1);
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(2); // credentials + allowlist watchers
    expect(h.mocks.stopLogStream).toHaveBeenCalled();
    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: FAIL — TypeScript/type errors and missing deps (`readAllowlist`, `buildConfig`, … are not part of `RunProxyDeps` yet).

- [ ] **Step 3: Rewrite `src/runProxy/runProxyLoop.ts`**

Replace the entire file content with:

```ts
import { planNextActions } from './planNextActions';
import { parseAllowlist, terminateTlsHosts, type Allowlist } from '../allowlist';
import { parseLine } from './parseLine';
import { classify } from './classify';
import { formatOutput } from './formatOutput';
import { UniqueTracker } from './uniqueTracker';
import type { Credentials, NudgeResult, RefreshState } from './types';

export interface RunProxyConfig {
  credentialsPath: string;
  allowlistPath: string;
  secretPath: string;
  serviceName: string;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface RunProxyDeps {
  readCredentials: (path: string) => Credentials | null;
  /** Raw allowlist file content, or null when unreadable. */
  readAllowlist: (path: string) => string | null;
  writeSecret: (token: string, path: string) => void;
  /** Render and write envoy.yaml (upstream overrides are baked in by the caller). */
  buildConfig: (allowlist: Allowlist) => void;
  /** Ensure the leaf covers `sans` (reissue if needed); returns a status line. */
  ensureLeaf: (sans: string[]) => string;
  recreateContainer: (serviceName: string) => Promise<void>;
  nudgeRefresh: () => Promise<NudgeResult>;
  /** File watcher; used for both the credentials file and the allowlist. */
  watch: (path: string, onEvent: () => void) => { close: () => void };
  startLogStream: (onLine: (raw: string) => void) => void;
  /** Resolves once the current log-follow child is fully gone; no-op when none. */
  stopLogStream: () => Promise<void>;
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}

/**
 * Long-running orchestrator. Owns the proxy end to end: builds envoy.yaml from
 * the allowlist, keeps the SDS secret fresh, watches both files, restarts the
 * container on changes (serialized, coalescing bursts), and streams the tagged
 * access log inline (each host+handling once). Resolves with a process exit
 * code: 0 on SIGINT (container left running), 1 on any fatal error.
 */
export function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let lastAppliedToken: string | null = null;
    let lastSeenExpiresAt: number | null = null;
    let lastNudgeAt: number | null = null;
    let lastNudgeStderr: string | null = null;
    let awaitingOutcome = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let credentialsWatcher: { close: () => void } | null = null;
    let allowlistWatcher: { close: () => void } | null = null;
    let settled = false;
    let restarting = false;
    let pendingCredentials = false;
    let pendingAllowlist = false;
    let sigintSeen = false;
    const unique = new UniqueTracker();

    const planConfig = {
      refreshWindowMs: config.refreshWindowMs,
      retryIntervalMs: config.retryIntervalMs,
    };

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    /**
     * Tear down every long-lived handle, then resolve. `settled` flips
     * synchronously so no callback can act after shutdown begins; the log
     * child is stopped asynchronously before resolving so it cannot outlive us.
     */
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      credentialsWatcher?.close();
      allowlistWatcher?.close();
      void deps.stopLogStream().then(() => resolve(code));
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      shutdown(1);
    };

    const refreshState = (): RefreshState => ({
      enabled: config.refreshEnabled,
      awaitingOutcome,
      lastNudgeAt,
    });

    const armTimer = (nudgeAt: number | null): void => {
      clearTimer();
      if (nudgeAt === null) return;
      const delay = Math.max(0, nudgeAt - deps.now());
      timer = setTimeout(() => {
        void onTimer();
      }, delay);
    };

    const recreateWithOneRetry = async (): Promise<boolean> => {
      try {
        await deps.recreateContainer(config.serviceName);
        return true;
      } catch {
        try {
          await deps.recreateContainer(config.serviceName);
          return true;
        } catch {
          return false;
        }
      }
    };

    const handleFailedAttempt = (): void => {
      clearTimer();
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.maxAttempts) {
        fatal(lastNudgeStderr ?? `token did not refresh after ${config.maxAttempts} attempts`);
        return;
      }
      void doNudge();
    };

    const doNudge = async (): Promise<void> => {
      awaitingOutcome = true;
      lastNudgeAt = deps.now();
      // Arm the outcome deadline: retryInterval from now.
      armTimer(lastNudgeAt + config.retryIntervalMs);
      const result = await deps.nudgeRefresh();
      if (settled || !awaitingOutcome) return;
      if (result.ok) {
        lastNudgeStderr = null;
      } else {
        lastNudgeStderr = result.stderr;
        handleFailedAttempt();
      }
    };

    const onTimer = async (): Promise<void> => {
      if (settled) return;
      if (awaitingOutcome) {
        // Outcome deadline reached with no observed advance -> failed attempt.
        handleFailedAttempt();
      } else {
        await doNudge();
      }
    };

    const onLogLine = (raw: string): void => {
      if (settled) return;
      const access = parseLine(raw);
      if (!access) return;
      const entry = classify(access);
      if (!unique.shouldPrint(entry)) return;
      deps.log(formatOutput(entry));
    };

    /** Read+parse the allowlist; null (with a logged reason) when unreadable or invalid. */
    const readValidAllowlist = (): Allowlist | null => {
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        deps.error(
          `run-proxy: could not read allowlist at ${config.allowlistPath}, keeping previous config`,
        );
        return null;
      }
      const allowlist = parseAllowlist(content);
      if (allowlist.invalid.length > 0) {
        deps.error(
          'run-proxy: allowlist has unsupported wildcard syntax, keeping previous config:\n' +
            allowlist.invalid.map((entry) => `  - ${entry}`).join('\n'),
        );
        return null;
      }
      return allowlist;
    };

    /** Reissue the leaf if the terminate hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(`run-proxy: ${deps.ensureLeaf(terminateTlsHosts(allowlist))}`);
      deps.buildConfig(allowlist);
    };

    const requestRestart = (source: 'credentials' | 'allowlist'): void => {
      if (settled) return;
      if (source === 'credentials') pendingCredentials = true;
      else pendingAllowlist = true;
      if (!restarting) void drainRestarts();
    };

    /**
     * Serialized restart pipeline: at most one force-recreate runs at a time.
     * Events landing mid-restart only set pending flags; the while loop then
     * collapses any burst into a single follow-up restart that re-reads both
     * files fresh, so the final state always reflects the latest files.
     */
    const drainRestarts = async (): Promise<void> => {
      restarting = true;
      try {
        while (!settled && (pendingCredentials || pendingAllowlist)) {
          const credentialsDirty = pendingCredentials;
          const allowlistDirty = pendingAllowlist;
          pendingCredentials = false;
          pendingAllowlist = false;

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (allowlistDirty) {
            const allowlist = readValidAllowlist();
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

          let latestCreds: Credentials | null = null;
          let tokenToApply: string | null = null;
          if (credentialsDirty) {
            latestCreds = deps.readCredentials(config.credentialsPath);
            if (latestCreds === null) {
              deps.error('run-proxy: skipped credentials event (unreadable or partial write)');
            } else {
              const advanced =
                lastSeenExpiresAt !== null && latestCreds.expiresAt > lastSeenExpiresAt;
              const plan = planNextActions({
                creds: latestCreds,
                lastAppliedToken,
                now: deps.now(),
                config: planConfig,
                refresh: refreshState(),
              });
              if (plan.propagate) {
                deps.writeSecret(latestCreds.accessToken, config.secretPath);
                tokenToApply = latestCreds.accessToken;
                restartNeeded = true;
                reasons.push('credentials changed');
              }
              if (advanced) {
                // Refresh landed: reset failure tracking and stop awaiting an outcome.
                consecutiveFailures = 0;
                awaitingOutcome = false;
              }
              lastSeenExpiresAt = latestCreds.expiresAt;
            }
          }

          if (restartNeeded) {
            deps.log(`run-proxy: restarting proxy — ${reasons.join(', ')}`);
            await deps.stopLogStream();
            const ok = await recreateWithOneRetry();
            if (settled) return;
            if (!ok) {
              fatal('docker failed to recreate the container');
              return;
            }
            if (tokenToApply !== null) lastAppliedToken = tokenToApply;
            if (clearUnique) unique.clear();
            deps.startLogStream(onLogLine);
          }

          if (latestCreds !== null && !settled) {
            const nextPlan = planNextActions({
              creds: latestCreds,
              lastAppliedToken,
              now: deps.now(),
              config: planConfig,
              refresh: refreshState(),
            });
            armTimer(nextPlan.nudgeAt);
          }
        }
      } finally {
        restarting = false;
      }
    };

    const onSigintOnce = (): void => {
      // Guard the handler itself: a second Ctrl-C prints nothing and does nothing.
      if (sigintSeen || settled) return;
      sigintSeen = true;
      deps.log('run-proxy: SIGINT received, stopping (container left running)');
      shutdown(0);
    };

    const start = async (): Promise<void> => {
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        fatal(`could not read credentials at ${config.credentialsPath}`);
        return;
      }

      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = parseAllowlist(content);
      if (allowlist.invalid.length > 0) {
        fatal(
          `unsupported wildcard syntax in ${config.allowlistPath}:\n` +
            allowlist.invalid.map((entry) => `  - ${entry}`).join('\n'),
        );
        return;
      }

      // Arm both watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      credentialsWatcher = deps.watch(config.credentialsPath, () =>
        requestRestart('credentials'),
      );
      allowlistWatcher = deps.watch(config.allowlistPath, () => requestRestart('allowlist'));
      deps.onSigint(onSigintOnce);

      restarting = true; // hold watcher events as pending until the startup recreate is done
      try {
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
        deps.writeSecret(creds.accessToken, config.secretPath);
        try {
          await deps.recreateContainer(config.serviceName);
        } catch {
          fatal('docker failed to recreate the container on startup');
          return;
        }
        if (settled) return;
        lastAppliedToken = creds.accessToken;
        lastSeenExpiresAt = creds.expiresAt;
        deps.startLogStream(onLogLine);
      } finally {
        restarting = false;
      }

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(plan.nudgeAt);
      deps.log('run-proxy: watching credentials and allowlist; proxy is serving the current token');

      // Apply anything that landed during the startup recreate.
      if (pendingCredentials || pendingAllowlist) void drainRestarts();
    };

    void start();
  });
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: all PASS. (`src/commands/runProxy.ts` will not compile against the new `RunProxyDeps` yet — that is Task 7 — so run only this test file, not `pnpm typecheck`.)

- [ ] **Step 5: Commit**

```powershell
git add src/runProxy/runProxyLoop.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat: runProxyLoop owns config build, allowlist watch, inline logging, and serialized coalescing restarts

- Second watcher on allowlist.txt, armed before the startup recreate so
  mid-startup edits coalesce instead of being dropped.
- Serialized restart pipeline with per-source dirty flags; a burst of edits
  collapses into one follow-up restart that re-reads both files.
- Invalid allowlist edits keep the previous config and log the offenders;
  the watcher stays live so fixing the file retriggers.
- Inline log pipeline (parseLine -> classify -> UniqueTracker -> formatOutput),
  cleared on allowlist restarts, preserved on credential restarts.
- SIGINT handler guarded against double-fire; shutdown tears down watchers,
  timer, and the log-follow child before resolving.

Note: src/commands/runProxy.ts does not compile against the new deps until
the next commit rewires it."
```

---

### Task 7: Rewrite the `run-proxy` command and migrate the test harnesses

Wire the new loop deps in `src/commands/runProxy.ts` (new prereq checks, `--upstream-override`), then convert `tests/proxyStack.ts` and `tests/integration/runProxy.test.ts` to drive the stack through a background `run-proxy` process whose stdout is captured. This must be one task: the new command reads the **environment's** `allowlist.txt` (not an arbitrary path), so the harnesses must stage their fixture allowlist and pass `--upstream-override` in the same change or the integration suite breaks.

**Files:**
- Rewrite: `src/commands/runProxy.ts`
- Rewrite: `tests/proxyStack.ts`
- Modify: `tests/integration/runProxy.test.ts`
- Modify: `tests/e2e/cli.test.ts` (run-proxy tests)

**Interfaces:**
- Consumes: `runProxyLoop`/`RunProxyDeps`/`RunProxyConfig` (Task 6), `writeEnvoyConfig` (Task 4), `ensureLeaf` (Task 3), `watchFile`, `startLogStream`, `LogStreamHandle` (Task 5), `killProcessTree` (Task 2), existing `readCredentials`/`writeSecret`/`recreateContainer`/`nudgeRefresh`/forwarder.
- Produces (Task 9 consumes these from `tests/proxyStack.ts`):
  - `interface ProxyStack { mockUpstream; caCertPem; proxyDir; composeEnv; proxyProc: ResultPromise; stdoutLines: string[]; allowlistPath: string; credentialsPath: string }`
  - `startProxyStack(): Promise<ProxyStack>` / `stopProxyStack(stack): Promise<void>`
  - `waitForAdminReady(timeoutMs: number): Promise<void>`
  - `waitForProxyLine(stack, needle: string, timeoutMs: number, fromIndex?: number): Promise<number>`
  - `countProxyLines(stack, needle: string): number`
  - `writeStackCredentials(stack, token: string): void`
  - Constants: `HTTPS_PORT`, `HTTP_PORT`, `ADMIN_PORT`, `PLACEHOLDER_AUTH`, `REAL_TOKEN = 'sandbox-test-real-token-12345'`, `REAL_AUTH = 'Bearer ' + REAL_TOKEN` (REAL_AUTH's value is unchanged — `tests/integration/proxy.test.ts` keeps passing untouched).

- [ ] **Step 1: Update the run-proxy e2e tests (failing first)**

In `tests/e2e/cli.test.ts`:

Replace the body expectations of `it('lists run-proxy with its flags in help output', ...)`:

```ts
  it('lists run-proxy with its flags in help output', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, 'run-proxy', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--credentials');
    expect(stdout).toContain('--no-refresh');
    expect(stdout).toContain('--service');
    expect(stdout).toContain('--upstream-override');
  });
```

Replace `it('run-proxy names the missing prerequisite command', ...)` (the missing prerequisite is now `generate-ca`, since run-proxy builds the config itself):

```ts
  it('run-proxy names the missing prerequisite command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa('node', [cliPath, 'run-proxy'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron generate-ca' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

Add a new test right after it (uses the existing `tests/fixtures/invalid-allowlist.txt`; `copyFileSync` is already imported? No — add `copyFileSync` to the `node:fs` import at the top of the file):

```ts
  it('run-proxy exits 1 on an allowlist with unsupported wildcard syntax', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(
      new URL('../fixtures/invalid-allowlist.txt', import.meta.url),
    );
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
      copyFileSync(fixturePath, join(dir, '.configamatron', 'proxy', 'allowlist.txt'));
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'run-proxy', '--no-refresh', '--no-forward'],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('crl*.digicert.com:80');
      expect(existsSync(join(dir, '.configamatron', 'proxy', 'envoy.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the e2e tests to verify the changed ones fail**

Run: `pnpm build` — expected to **fail typecheck/build**? No: tsup does not typecheck; the build succeeds but `src/commands/runProxy.ts` still passes the old dep shape, so `pnpm typecheck` fails. That is expected mid-task. Run `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts` only if the build succeeds; otherwise proceed to Step 3 (the failing typecheck is the red state).

- [ ] **Step 3: Rewrite `src/commands/runProxy.ts`**

Replace the entire file content with:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runProxy/readCredentials';
import { writeSecret } from '../runProxy/writeSecret';
import { recreateContainer } from '../runProxy/recreateContainer';
import { nudgeRefresh } from '../runProxy/nudgeRefresh';
import { watchFile } from '../runProxy/watchFile';
import { runProxyLoop, type RunProxyDeps } from '../runProxy/runProxyLoop';
import { writeEnvoyConfig } from '../runProxy/buildConfig';
import { startLogStream, type LogStreamHandle } from '../runProxy/logStream';
import { ensureLeaf } from '../leaf';
import { requireEnvPathsOrExit } from '../envPaths';
import type { UpstreamOverride } from '../envoyConfig';
import {
  planForwarder,
  resolveForwardListenAddress,
  startForwarder,
  type ForwarderHandle,
} from '../runProxy/forwarder';

interface RunProxyOptions {
  credentials: string;
  secret?: string;
  service: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
  forward: boolean;
  forwardListen?: string;
  forwardPorts?: string;
  upstreamOverride: UpstreamOverride[];
}

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

export function registerRunProxy(program: Command): void {
  program
    .command('run-proxy')
    .description(
      'Own the Envoy proxy end to end: build envoy.yaml from the allowlist, write the SDS ' +
        'secret, recreate the container, then watch allowlist.txt and credentials.json — ' +
        'rebuilding the config, reissuing the leaf certificate, and restarting the proxy as ' +
        "they change — while streaming the proxy's tagged access log (each host+handling " +
        'once). Foreground process; Ctrl-C to stop (leaves the container running).',
    )
    .option(
      '--credentials <path>',
      'Claude credentials file to watch',
      join(homedir(), '.claude', '.credentials.json'),
    )
    .option(
      '--secret <path>',
      'SDS secret output path (default: .configamatron/proxy/secrets/sds-secret.yaml)',
    )
    .option('--service <name>', 'docker compose service to recreate', 'envoy')
    .option('--refresh-window <minutes>', 'nudge this many minutes before expiry', '3')
    .option('--retry-interval <minutes>', 'wait this many minutes for a nudge to take', '2')
    .option('--max-attempts <n>', 'consecutive failed refreshes before exiting', '3')
    .option('--no-refresh', 'watch and propagate only; never nudge the CLI to refresh')
    .option('--no-forward', 'do not forward the VMware host-only interface to loopback')
    .option(
      '--forward-listen <ip>',
      'IP to forward from (default: the VMware host-only adapter IP)',
    )
    .option(
      '--forward-ports <http,https>',
      'ports to forward (default: ENVOY_HTTP_PORT,ENVOY_HTTPS_PORT or 80,443)',
    )
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a terminate cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .action(async (options: RunProxyOptions) => {
      const paths = requireEnvPathsOrExit('run-proxy');
      if (!paths) return;
      // run-proxy reissues the leaf itself but never the root: the root must
      // already exist (and be trusted in the guest) via generate-ca.
      if (!existsSync(paths.caCert) || !existsSync(paths.caKey)) {
        console.error(
          `run-proxy: proxy CA not found in ${paths.caDir} — run 'configamatron generate-ca' first`,
        );
        process.exitCode = 1;
        return;
      }
      const secretPath = options.secret ?? paths.sdsSecret;

      let logHandle: LogStreamHandle | null = null;
      const deps: RunProxyDeps = {
        readCredentials,
        readAllowlist: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return null;
          }
        },
        writeSecret,
        buildConfig: (allowlist) =>
          writeEnvoyConfig(allowlist, paths.envoyConfig, options.upstreamOverride),
        ensureLeaf: (sans) =>
          ensureLeaf(
            paths,
            readFileSync(paths.caCert, 'utf8'),
            readFileSync(paths.caKey, 'utf8'),
            sans,
          ),
        recreateContainer: (serviceName) => recreateContainer(serviceName, paths.proxy),
        nudgeRefresh,
        watch: watchFile,
        startLogStream: (onLine) => {
          logHandle = startLogStream(options.service, paths.proxy, onLine);
        },
        stopLogStream: async () => {
          const handle = logHandle;
          logHandle = null;
          await handle?.stop();
        },
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      const [httpPort, httpsPort] = options.forwardPorts
        ? options.forwardPorts.split(',').map((p) => Number(p.trim()))
        : [Number(process.env.ENVOY_HTTP_PORT ?? 80), Number(process.env.ENVOY_HTTPS_PORT ?? 443)];

      let forwarder: ForwarderHandle | null = null;
      const plan = planForwarder(
        {
          noForward: !options.forward,
          forwardListen: options.forwardListen,
          httpPort,
          httpsPort,
        },
        () => resolveForwardListenAddress(),
      );
      if (plan.kind === 'error') {
        console.error(`run-proxy: ${plan.message}`);
        process.exitCode = 1;
        return;
      }
      if (plan.kind === 'start') {
        try {
          forwarder = await startForwarder({
            listenAddress: plan.listenAddress,
            rules: plan.rules,
          });
          console.log(
            `run-proxy: forwarding ${plan.listenAddress}:${httpPort}/${httpsPort} -> 127.0.0.1`,
          );
        } catch (err) {
          console.error(
            `run-proxy: failed to start forwarder on ${plan.listenAddress}: ${String(err)}`,
          );
          process.exitCode = 1;
          return;
        }
      }

      try {
        const exitCode = await runProxyLoop(
          {
            credentialsPath: options.credentials,
            allowlistPath: paths.allowlist,
            secretPath,
            serviceName: options.service,
            refreshWindowMs: Number(options.refreshWindow) * 60_000,
            retryIntervalMs: Number(options.retryInterval) * 60_000,
            maxAttempts: Number(options.maxAttempts),
            refreshEnabled: options.refresh,
          },
          deps,
        );
        process.exitCode = exitCode;
      } finally {
        await forwarder?.close();
      }
    });
}
```

- [ ] **Step 4: Rewrite `tests/proxyStack.ts`**

Replace the entire file content with:

```ts
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './integration/mockUpstream';
import { killProcessTree } from '../src/runProxy/killProcessTree';

export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const ADMIN_PORT = 19901;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
export const REAL_TOKEN = 'sandbox-test-real-token-12345';
export const REAL_AUTH = `Bearer ${REAL_TOKEN}`;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowlistFixture = join(repoRoot, 'tests', 'integration', 'fixtures', 'allowlist.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const envRoot = join(repoRoot, '.configamatron');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
  proxyProc: ResultPromise;
  /** Every stdout/stderr line run-proxy has produced so far, in order. */
  stdoutLines: string[];
  /** The environment's live allowlist — edit it to trigger a proxy restart. */
  allowlistPath: string;
  /** The mutable credentials file run-proxy watches — rotate it to trigger a restart. */
  credentialsPath: string;
}

export async function waitForAdminReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: ADMIN_PORT, path: '/ready', timeout: 1000 },
          (res) =>
            res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`)),
        );
        req.on('error', reject);
        req.end();
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Envoy admin endpoint never became ready');
}

function writeCredentialsFile(path: string, token: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

export function writeStackCredentials(stack: ProxyStack, token: string): void {
  writeCredentialsFile(stack.credentialsPath, token);
}

export function countProxyLines(stack: ProxyStack, needle: string): number {
  return stack.stdoutLines.filter((line) => line.includes(needle)).length;
}

/**
 * Wait until run-proxy prints a line containing `needle` at index >= fromIndex.
 * Returns the matching index; capture `stack.stdoutLines.length` before an
 * action to assert on output the action caused.
 */
export async function waitForProxyLine(
  stack: ProxyStack,
  needle: string,
  timeoutMs: number,
  fromIndex = 0,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = fromIndex; i < stack.stdoutLines.length; i++) {
      if (stack.stdoutLines[i].includes(needle)) return i;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for run-proxy output containing '${needle}'\n` +
          `--- run-proxy output ---\n${stack.stdoutLines.join('\n')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startProxyStack(): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
    ENVOY_ADMIN_PORT: String(ADMIN_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });

  // Stage the test allowlist as the environment's own before generate-ca so
  // the leaf SANs derive from it; run-proxy then builds envoy.yaml from it too.
  const allowlistPath = join(proxyDir, 'allowlist.txt');
  copyFileSync(allowlistFixture, allowlistPath);
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

  // run-proxy owns the SDS secret now: the token in this mutable credentials
  // file becomes the injected `Bearer ${REAL_TOKEN}` header.
  const credentialsPath = join(envRoot, 'run-proxy-credentials.json');
  writeCredentialsFile(credentialsPath, REAL_TOKEN);

  const proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot, env: composeEnv, buffer: false, reject: false },
  );

  const stdoutLines: string[] = [];
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      stdoutLines.push(line);
      console.log(`run-proxy| ${line}`);
    });
  }

  // run-proxy builds envoy.yaml, writes the secret, and force-recreates; ready
  // means the whole startup sequence completed.
  await waitForAdminReady(60000);
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

export async function stopProxyStack(stack: ProxyStack): Promise<void> {
  // Kill the whole tree: run-proxy's docker-logs child holds a stdout pipe
  // that would otherwise keep `await proxyProc` hanging on Windows.
  if (stack.proxyProc.pid !== undefined) {
    await killProcessTree(stack.proxyProc.pid, 'SIGINT');
  }
  try {
    await stack.proxyProc;
  } catch {
    // killed above / non-zero exit is expected
  }
  await execa('docker', ['compose', 'down'], { cwd: stack.proxyDir });
  await stopMockUpstream(stack.mockUpstream);
}
```

- [ ] **Step 5: Update `tests/integration/runProxy.test.ts`**

Four changes:

1. Update the `node:fs` import to include `copyFileSync`, and add the tree-kill import:

```ts
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
```

2. In `beforeAll`, replace the `generate-ca` + `build-envoy-config` block (keep the `init` call):

```ts
  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  // Stage the test allowlist as the environment's own; run-proxy builds
  // envoy.yaml from it on startup.
  copyFileSync(allowlistFixture, join(proxyDir, 'allowlist.txt'));
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
```

3. Still in `beforeAll`, add the upstream override to the run-proxy spawn:

```ts
  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );
```

4. In `afterAll`, replace `proxyProc?.kill('SIGINT');` with a tree kill (the docker-logs child would otherwise survive on Windows and hang the await):

```ts
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
```

- [ ] **Step 6: Typecheck, unit, build, e2e**

Run: `pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all PASS (including the Step-1 e2e tests that were failing).

- [ ] **Step 7: Integration tests (Docker must be running)**

Run: `pnpm test:integration`
Expected: all PASS — `tests/integration/proxy.test.ts` unchanged (REAL_AUTH value identical), `tests/integration/runProxy.test.ts` exercising credential rotation through the new pipeline.

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "feat: run-proxy builds the config, watches the allowlist, and streams logs inline

The command drops its envoy.yaml/leaf existence checks (it builds and
reissues them itself; only generate-ca's root CA remains a prerequisite),
gains build-envoy-config's --upstream-override flag, and wires the new
loop deps (readAllowlist, buildConfig, ensureLeaf, start/stopLogStream).

Test harnesses now drive the stack through run-proxy itself: proxyStack
stages the fixture allowlist into the environment, launches run-proxy as
a background process, and captures its stdout for assertions (the VM
suite builds on this next). Teardown kills the process tree because the
docker-logs child holds a stdout pipe that would hang awaits on Windows."
```

---

### Task 8: Delete `build-envoy-config` and finish CLI cleanup

Everything that used `build-envoy-config` now goes through `run-proxy`; delete the command, its registration, its e2e tests, and fix `init`'s next-steps text.

**Files:**
- Delete: `src/commands/buildEnvoyConfig.ts`
- Modify: `src/cli.ts`, `src/commands/init.ts`
- Modify: `tests/e2e/cli.test.ts` (remove 3 tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: final `src/cli.ts` registration list: `init`, `generate-ca`, `import-sbx-network-policy`, `write-github-config`, `run-proxy`.

- [ ] **Step 1: Delete the command and deregister it**

```powershell
git rm src/commands/buildEnvoyConfig.ts
```

`src/cli.ts` becomes:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerInit } from './commands/init';
import { registerGenerateCa } from './commands/generateCa';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';
import { registerRunProxy } from './commands/runProxy';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerInit(program);
registerGenerateCa(program);
registerImportSbxNetworkPolicy(program);
registerWriteGithubConfig(program);
registerRunProxy(program);

await program.parseAsync();
```

- [ ] **Step 2: Renumber init's next steps**

In `src/commands/init.ts`, replace the next-steps `console.log` block with:

```ts
      console.log(`init: created ${ENV_DIR_NAME}. Next steps:`);
      console.log('  1. configamatron generate-ca');
      console.log('  2. configamatron write-github-config');
      console.log('  3. configamatron run-proxy');
      console.log(
        `  (Windows) admin PowerShell: powershell -File ${ENV_DIR_NAME}/proxy/host-allow-vm-inbound.ps1`,
      );
      console.log(`  Then share ${ENV_DIR_NAME}/vm-shared into the VM — see usage.md`);
```

(`tests/e2e/init.test.ts` only asserts the output contains `generate-ca`, so it keeps passing.)

- [ ] **Step 3: Remove the three build-envoy-config e2e tests**

In `tests/e2e/cli.test.ts`, delete these complete `it(...)` blocks:

- `it('generates envoy.yaml into the environment by default with build-envoy-config', ...)`
- `it('build-envoy-config rejects an allowlist with unsupported wildcard syntax', ...)`
- `it('build-envoy-config exits 1 without an environment', ...)`

Keep `tests/fixtures/invalid-allowlist.txt` (Task 7's run-proxy test uses it) and `tests/fixtures/sample-allowlist.txt` if still referenced — check with `pnpm vitest run --config vitest.e2e.config.ts`; if `sample-allowlist.txt` is now unreferenced (`grep -r "sample-allowlist" tests/ src/`), delete it too.

- [ ] **Step 4: Full gate**

Run: `pnpm test`
Expected: all PASS (format, lint, typecheck, unit, build, e2e, integration). Also confirm no dangling references:

Run: `grep -rn "build-envoy-config\|proxyLogs\|proxy-logs" src/ tests/ templates/`
Expected: no matches in `src/` or `templates/`; no matches in `tests/` (docs/plans may still mention them — those are historical and stay).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: remove build-envoy-config — run-proxy owns config generation end to end"
```

---

### Task 9: VM test coverage for inline logging across both restart kinds

Assert against the captured `run-proxy` stdout: guest traffic produces tagged lines; an allowlist edit restarts the proxy, re-attaches the follow (the exact case the old `proxy-logs` broke on), and resets unique tracking; a credential rotation restarts and preserves unique tracking.

**Files:**
- Modify: `tests/vm/vm.test.ts`

**Interfaces:**
- Consumes (from Task 7's `tests/proxyStack.ts`): `waitForAdminReady`, `waitForProxyLine`, `countProxyLines`, `writeStackCredentials`, `stack.stdoutLines`, `stack.allowlistPath`.

- [ ] **Step 1: Add the new describe block**

In `tests/vm/vm.test.ts`:

1. Add `appendFileSync` to the `node:fs` import: `import { appendFileSync, mkdirSync } from 'node:fs';`
2. Extend the `../proxyStack` import:

```ts
import {
  startProxyStack,
  stopProxyStack,
  waitForAdminReady,
  waitForProxyLine,
  countProxyLines,
  writeStackCredentials,
  HTTP_PORT,
  HTTPS_PORT,
  PLACEHOLDER_AUTH,
  type ProxyStack,
} from '../proxyStack';
```

3. Insert this describe **between** `describe('S2: switch to host-only and reboot', ...)` and `describe('S3: fresh setup with no default route', ...)` (describe blocks in one file run in order; S2's traffic must already have happened, and S3's second guest must not run first):

```ts
describe('S2b: run-proxy inline logging', () => {
  it('streamed unique tagged lines for the traffic S2 generated', async () => {
    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 30_000);
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 30_000);
    await waitForProxyLine(stack, 'ALLOW HTTP  archive.ubuntu.com', 30_000);
    await waitForProxyLine(stack, 'BLOCK HTTP  blocked.example.com', 30_000);
  });

  it('an allowlist edit restarts the proxy, re-attaches the follow, and resets unique tracking', async () => {
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');
    expect(pypiBefore).toBeGreaterThan(0);
    const mark = stack.stdoutLines.length;

    // The staged fixture ends with the '# terminate' section, so appending
    // adds a terminate host — the terminate-host set changes and the
    // leaf-reissue path runs too, not just the config rebuild.
    appendFileSync(stack.allowlistPath, 'example.org:443\n');

    await waitForProxyLine(stack, 'restarting proxy — allowlist changed', 120_000, mark);
    await waitForAdminReady(60_000);

    await guest('g1', `curl -s -o /dev/null --max-time 30 https://pypi.org/simple/`);

    // The same host+handling prints again only because unique tracking was
    // cleared — and the line only reaches us because the follow re-attached
    // to the freshly recreated container.
    await waitForProxyLine(stack, 'ALLOW PASS  pypi.org', 60_000, mark);
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore + 1);
  }, 300_000);

  it('a credential rotation restarts the proxy and preserves unique tracking', async () => {
    const mark = stack.stdoutLines.length;
    writeStackCredentials(stack, 'rotated-vm-test-token');

    await waitForProxyLine(stack, 'restarting proxy — credentials changed', 120_000, mark);
    await waitForAdminReady(60_000);
    const pypiBefore = countProxyLines(stack, 'ALLOW PASS  pypi.org');

    // pypi.org was re-logged after the allowlist restart above, so it is in
    // the preserved unique map: this request must NOT produce a new line.
    await guest('g1', `curl -s -o /dev/null --max-time 30 https://pypi.org/simple/`);
    // api.anthropic.com has NOT been logged since that allowlist reset, so it
    // does print — proving the follow re-attached after this restart too.
    await guest(
      'g1',
      `curl -s -o /dev/null --max-time 30 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );

    await waitForProxyLine(stack, 'ALLOW CRED  api.anthropic.com', 60_000, mark);
    // Envoy logs in request order: the api.anthropic.com line arriving means
    // any pypi line would already be here. It is not: unique was preserved.
    expect(countProxyLines(stack, 'ALLOW PASS  pypi.org')).toBe(pypiBefore);
  }, 300_000);
});
```

- [ ] **Step 2: Run the VM suite**

Run: `pnpm test:vm`
Expected: all PASS, including the three new S2b tests, and S3 still passing afterwards (S3's guest traffic is unaffected by the rotated token — it never hits the terminate host). This is slow (guest boot + reboot; budget 20–40 min). On failure, diagnostics land in `test-results/vm/<timestamp>/` and the `run-proxy| `-prefixed console output shows what the proxy printed.

- [ ] **Step 3: Commit**

```powershell
git add tests/vm/vm.test.ts
git commit -m "test(vm): assert run-proxy inline logging across allowlist and credential restarts

Covers the exact failure the old proxy-logs viewer had: the follow dying
silently when run-proxy force-recreates the container. Asserts tagged
lines for guest traffic, re-attach + unique reset after an allowlist
edit (which also exercises the live leaf reissue: the appended host
lands in the terminate section), and re-attach + unique preservation
after a credential rotation."
```

---

### Task 10: Docs rewrite and manual shutdown smoke test

**Files:**
- Modify: `usage.md`, `technical-notes.md`
- Verify: `README.md` (expected: no references to the removed commands)

**Interfaces:** none (documentation).

- [ ] **Step 1: Rewrite the usage.md workflow**

In `usage.md`, replace the numbered "Proxy setup" list (steps 1–6) with:

```markdown
1. `configamatron init` — creates `.configamatron/` scaffolding needed to manage the environment. Do not commit to source control, includes credentials that the isolating proxy may inject.
2. `configamatron generate-ca` — writes the root certificate authority the proxy's https certificates chain to. Run once per environment; `run-proxy` reissues the per-host leaf certificate automatically as the allow list changes.
3. `configamatron write-github-config` — prompts for a GitHub fine-grained personal access token and writes `vm-shared/github-config.txt` (username/email come from your global git config). Create the token at https://github.com/settings/personal-access-tokens/new, scoped to the repositories the agent should use, with read/write permission to 'Contents'.
4. `configamatron run-proxy` — builds `proxy/envoy.yaml` from `proxy/allowlist.txt` and launches the proxy in a docker container with the latest Claude credentials. While it runs it watches both files: editing the allow list takes effect live (config rebuilt, leaf certificate reissued if the terminate hosts changed, proxy restarted), and credential rotations propagate automatically. It also streams the proxy's access log inline (see "Watching proxy traffic" below) and forwards the VMware host-only interface's `:80`/`:443` to Envoy on loopback, so it must stay running for the VM to reach the proxy (Envoy is published on `127.0.0.1` only). Pass `--no-forward` to disable forwarding, or `--forward-listen <ip>` to override the bind address.
5. **Windows hosts only:** in an **Administrator** PowerShell, run `powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1`. This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter, and _prints the host IP you need to use in VM-side setup_.
```

(Keep the `-AdapterAlias` sub-bullet that follows.)

Replace the "Watching proxy traffic" section body with:

```markdown
### Watching proxy traffic

`configamatron run-proxy` streams how the proxy handled each host, inline with its own status lines. Each host/handling pair is printed once; the tracking resets when an allow-list edit restarts the proxy (so you can immediately see how the edited entries are handled) and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)
```

- [ ] **Step 2: Update technical-notes.md**

Three edits:

1. Line ~13 (allow-list maintenance), replace the closing parenthetical: `(edit that file directly for per-environment changes and re-run `configamatron build-envoy-config`)` → `(edit that file directly for per-environment changes — a running `configamatron run-proxy` picks the edit up live)`.
2. Line ~24 ("How the proxy works"), replace the final sentence (`` `run-proxy` owns the secret lifecycle: ... ``) with: `` `run-proxy` owns the proxy end to end: it builds `envoy.yaml` from the allowlist, writes the SDS secret from the host credential, and force-recreates the container whenever the token rotates or the allowlist changes (reissuing the leaf certificate when the terminate-host set changes — the root CA from `generate-ca` is never touched).``
3. Line ~34 ("Access logging"), replace `The `proxy-logs` command parses these lines and maps them to friendly tags;` with `` `run-proxy` parses these lines and maps them to friendly tags in its inline log stream (each host+handling printed once);``

- [ ] **Step 3: Verify README and remaining references**

Run: `grep -n "build-envoy-config\|proxy-logs" README.md usage.md technical-notes.md`
Expected: no matches (README.md had none before this change; specs/plans under `docs/superpowers/` are historical and are intentionally left alone).

- [ ] **Step 4: Manual shutdown smoke test (spec §4: confirm the process actually exits)**

In a real environment directory (any folder with a set-up `.configamatron`, e.g. the one the user normally uses — or create a throwaway with `init` + `generate-ca` and Docker running):

1. Run `node <repo>/dist/cli.js run-proxy --no-refresh` (or `configamatron run-proxy` if globally installed).
2. Wait for `run-proxy: watching credentials and allowlist; proxy is serving the current token` and at least one log line.
3. Press Ctrl-C **once**: expect exactly one `run-proxy: SIGINT received, stopping (container left running)` line and the process returning to the shell prompt on its own (no hang, no need for a second Ctrl-C).
4. Confirm the container is still running: `docker ps` shows the envoy container.

If the process does not exit (a stray active handle), the sanctioned fallback per spec is an explicit `process.exit(code)` after cleanup in `src/commands/runProxy.ts` — add it only if this smoke test proves it necessary, and note which handle forced it in the commit message. This step requires an interactive terminal; if executing as an agent without one, flag this step for the human partner instead of skipping silently.

- [ ] **Step 5: Full gate and commit**

Run: `pnpm test`
Expected: PASS (docs changes shouldn't break anything, but prettier checks markdown).

```powershell
git add -A
git commit -m "docs: single-command proxy workflow — run-proxy builds config, watches allowlist, logs inline"
```

---

## Self-Review

**Spec coverage:**
- §1 command surface & lifecycle: removed commands (Tasks 1, 8), `--upstream-override` moved (Task 7), startup sequence incl. early watcher arming (Task 6 `start()`, unit-tested), prerequisites reduced to `init` + `generate-ca` (Task 7 checks + e2e).
- §2 allowlist watching / leaf reissue / invalid handling / restart logs / unique clearing: Task 6 (`readValidAllowlist`, `applyAllowlist`, drain pipeline) with unit tests; leaf reissue shared from `generate-ca` (Task 3); live reissue exercised end-to-end in the VM allowlist test (appended host lands in the terminate section).
- §3 inline logging: pipeline relocated (Task 2), `UniqueTracker` unique-only (Task 2), follow re-attach per restart (Task 6 stop→recreate→start; VM Task 9), no `--tail` needed (documented in `logStream.ts`), `killProcessTree` teardown (Tasks 5–7).
- §4 SIGINT fix & concurrency: guarded handler, full teardown, `settled`-first shutdown, serialized restarts with dirty flags, both-changed clears unique (Task 6 + tests); empirical exit check (Task 10 Step 4 with the spec's sanctioned `process.exit` fallback).
- §5 testing: all six listed unit cases present in Task 6's test file; VM approach A via background `run-proxy` with captured stdout (Tasks 7, 9) covering log lines, allowlist restart + continued output + unique reset, credential restart + unique preservation.
- §6 migration/docs/cleanup: harnesses (Task 7), dead code deletion incl. reducer modes/`entryFilter`/`keepEntry` (Tasks 1, 2, 8), `usage.md`/`technical-notes.md`/README check (Task 10), `init` next-steps renumbered (Task 8).

**Type consistency:** `RunProxyDeps` names (`readAllowlist`, `buildConfig`, `ensureLeaf`, `startLogStream`, `stopLogStream`, `watch`) match between Task 6's interface, its test harness, and Task 7's wiring. `ensureLeaf(paths, caCertPem, caKeyPem, sans): string` matches Task 3's export and Task 7's closure. `writeEnvoyConfig(allowlist, outputPath, overrides)` matches Tasks 4 and 7. `LogStreamHandle.stop(): Promise<void>` matches Tasks 5 and 7. `ProxyStack` fields consumed in Task 9 (`stdoutLines`, `allowlistPath`) are produced in Task 7. `formatOutput(entry: Entry)` is consistent across Tasks 2, 6.

**Known intermediate states:** after Task 6's commit, `pnpm typecheck` fails until Task 7 rewires the command (called out in the commit message); Task 7 restores green across unit/e2e/integration before Task 8 deletes the old command.
