# `run-proxy` Credential Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `configamatron run-proxy` foreground command that owns the Envoy proxy lifecycle — writes the SDS secret, recreates the container so Envoy reads the current Claude token, watches `~/.claude/.credentials.json` to propagate token changes, and nudges the `claude` CLI to refresh the token before it expires.

**Architecture:** A pure decision core (`planNextActions`) computes what to do (propagate? when to nudge?) with no I/O, driven by two event sources — a file watcher (propagation) and a single self-rescheduling `setTimeout` (refresh). Thin, injectable adapters (`readCredentials`, `writeSecret`, `recreateContainer`, `nudgeRefresh`, `watchCredentials`) do the side effects. An orchestrator (`runProxyLoop`) wires them together and holds the state machine.

**Tech Stack:** TypeScript (ESM, strict), commander (CLI), execa (subprocess), the [`watcher`](https://www.npmjs.com/package/watcher) npm package (cross-platform FS watching), vitest (unit + integration), tsup (build).

## Global Constraints

- **Runtime:** Node.js `>=18`, ESM (`"type": "module"`). Use `node:`-prefixed built-in imports.
- **Package manager:** pnpm. Add deps with `pnpm add`.
- **TypeScript:** `strict: true`, `moduleResolution: bundler`, `noEmit` for typecheck. No `any` in `src/**` (allowed in `tests/**`).
- **Verification pipeline (fail-fast order):** `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test:unit` → `pnpm build` → `pnpm test:e2e` → `pnpm test:integration`. Run `pnpm format` before committing to satisfy `format:check`.
- **CLI identity:** program name `configamatron`; new command name `run-proxy`.
- **Secret format (verbatim, must match the existing `envoy/secrets/sds-secret.yaml` fixture):**
  ```yaml
  resources:
    - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
      name: sandbox_bearer_token
      generic_secret:
        secret:
          inline_string: "Bearer <token>"
  ```
- **Default flag values (from the spec):** `refreshWindow` 3 min, `retryInterval` 2 min, `maxAttempts` 3, credentials path `~/.claude/.credentials.json`, secret path `envoy/secrets/sds-secret.yaml`, service name `envoy`, refresh enabled by default.
- **Commit style:** frequent, one per task step where indicated. This repo uses `feat:`/`chore:`/`docs:`/`test:` prefixes loosely; keep messages descriptive.

---

## File Structure

- `src/runProxy/types.ts` — shared types (`Credentials`, `RefreshState`, `PlanConfig`, `PlanInput`, `PlanResult`, `NudgeResult`).
- `src/runProxy/planNextActions.ts` — pure decision core.
- `src/runProxy/readCredentials.ts` — read/parse `.credentials.json` → `Credentials | null`.
- `src/runProxy/writeSecret.ts` — `formatSecret` (pure) + `writeSecret` (writes `sds-secret.yaml`).
- `src/runProxy/recreateContainer.ts` — `docker compose up -d --force-recreate <service>`.
- `src/runProxy/nudgeRefresh.ts` — `claude -p <prompt> --model haiku`.
- `src/runProxy/watchCredentials.ts` — `watcher`-backed file watch, filtered to the credentials file.
- `src/runProxy/runProxyLoop.ts` — orchestrator + `RunProxyConfig`/`RunProxyDeps` types.
- `src/commands/runProxy.ts` — `registerRunProxy(program)`; flags, real adapters, calls the orchestrator.
- `src/cli.ts` — register `run-proxy` (modify).
- `package.json` — add `watcher`; move `execa` to `dependencies` (modify).
- `tests/unit/runProxy/*.test.ts` — unit tests for the pure core, adapters, and orchestrator.
- `tests/integration/runProxy.test.ts` — docker-harness integration test.
- `scripts/host-session-hook.sh` — **delete**.
- `envoy-proxy.md`, `README.md` — docs update (modify).

---

## Task 1: Shared types + `planNextActions` pure core

**Files:**
- Create: `src/runProxy/types.ts`
- Create: `src/runProxy/planNextActions.ts`
- Test: `tests/unit/runProxy/planNextActions.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface Credentials { accessToken: string; expiresAt: number }` (`expiresAt` is epoch ms).
  - `interface RefreshState { enabled: boolean; awaitingOutcome: boolean; lastNudgeAt: number | null }`
  - `interface PlanConfig { refreshWindowMs: number; retryIntervalMs: number }`
  - `interface PlanInput { creds: Credentials; lastAppliedToken: string | null; now: number; config: PlanConfig; refresh: RefreshState }`
  - `interface PlanResult { propagate: boolean; nudgeAt: number | null }`
  - `interface NudgeResult { ok: boolean; stderr: string }`
  - `function planNextActions(input: PlanInput): PlanResult`

- [ ] **Step 1: Write the shared types file**

Create `src/runProxy/types.ts`:

```typescript
export interface Credentials {
  /** OAuth access token injected into the VM's requests. */
  accessToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface RefreshState {
  /** False when the user passed --no-refresh: never nudge. */
  enabled: boolean;
  /** True between firing a nudge and observing its outcome. */
  awaitingOutcome: boolean;
  /** When the most recent nudge fired, epoch ms; null before the first nudge. */
  lastNudgeAt: number | null;
}

export interface PlanConfig {
  refreshWindowMs: number;
  retryIntervalMs: number;
}

export interface PlanInput {
  creds: Credentials;
  lastAppliedToken: string | null;
  now: number;
  config: PlanConfig;
  refresh: RefreshState;
}

export interface PlanResult {
  /** Envoy must be updated: the credential differs from what we last applied. */
  propagate: boolean;
  /** Absolute time (epoch ms) to arm the nudge timer, or null when refresh is disabled. */
  nudgeAt: number | null;
}

export interface NudgeResult {
  /** True when the `claude` process exited 0. Does NOT mean the token refreshed. */
  ok: boolean;
  /** Captured stderr when the process errored; empty string otherwise. */
  stderr: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/runProxy/planNextActions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { planNextActions } from '../../../src/runProxy/planNextActions';
import type { PlanInput } from '../../../src/runProxy/types';

const MIN = 60_000;

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    creds: { accessToken: 'token-A', expiresAt: 1_000_000 },
    lastAppliedToken: 'token-A',
    now: 0,
    config: { refreshWindowMs: 3 * MIN, retryIntervalMs: 2 * MIN },
    refresh: { enabled: true, awaitingOutcome: false, lastNudgeAt: null },
    ...overrides,
  };
}

describe('planNextActions', () => {
  it('does not propagate when the token is unchanged', () => {
    expect(planNextActions(input()).propagate).toBe(false);
  });

  it('propagates when the token differs from the last applied one', () => {
    const result = planNextActions(
      input({ creds: { accessToken: 'token-B', expiresAt: 1_000_000 }, lastAppliedToken: 'token-A' }),
    );
    expect(result.propagate).toBe(true);
  });

  it('arms the nudge at expiresAt - refreshWindow when expiry is far out', () => {
    const result = planNextActions(
      input({ now: 0, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(10 * MIN - 3 * MIN);
  });

  it('arms the nudge at now when expiry is already within the refresh window', () => {
    const result = planNextActions(
      input({ now: 8 * MIN, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(8 * MIN);
  });

  it('arms the nudge at now when the token is already expired', () => {
    const result = planNextActions(
      input({ now: 20 * MIN, creds: { accessToken: 'token-A', expiresAt: 10 * MIN } }),
    );
    expect(result.nudgeAt).toBe(20 * MIN);
  });

  it('arms the retry deadline when a nudge is awaiting an outcome', () => {
    const result = planNextActions(
      input({
        now: 5 * MIN,
        refresh: { enabled: true, awaitingOutcome: true, lastNudgeAt: 4 * MIN },
      }),
    );
    expect(result.nudgeAt).toBe(4 * MIN + 2 * MIN);
  });

  it('returns nudgeAt null when refresh is disabled', () => {
    const result = planNextActions(
      input({ refresh: { enabled: false, awaitingOutcome: false, lastNudgeAt: null } }),
    );
    expect(result.nudgeAt).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/planNextActions.test.ts`
Expected: FAIL — cannot resolve `../../../src/runProxy/planNextActions`.

- [ ] **Step 4: Write the implementation**

Create `src/runProxy/planNextActions.ts`:

```typescript
import type { PlanInput, PlanResult } from './types';

/**
 * Pure decision core. No I/O — all timing is derived from `now`, `creds.expiresAt`,
 * and `refresh`, so it is exhaustively unit-testable.
 */
export function planNextActions({
  creds,
  lastAppliedToken,
  now,
  config,
  refresh,
}: PlanInput): PlanResult {
  const propagate = creds.accessToken !== lastAppliedToken;

  if (!refresh.enabled) {
    return { propagate, nudgeAt: null };
  }

  // A nudge is in flight and its outcome hasn't been observed: the timer's job is
  // the retry/outcome deadline, retryInterval after the nudge fired.
  if (refresh.awaitingOutcome && refresh.lastNudgeAt !== null) {
    return { propagate, nudgeAt: refresh.lastNudgeAt + config.retryIntervalMs };
  }

  // Normal case: nudge refreshWindow before expiry, or immediately if that point
  // is already past (within-window or expired).
  const target = creds.expiresAt - config.refreshWindowMs;
  return { propagate, nudgeAt: target <= now ? now : target };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/planNextActions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/types.ts src/runProxy/planNextActions.ts tests/unit/runProxy/planNextActions.test.ts
git commit -m "feat: add planNextActions pure decision core for run-proxy"
```

---

## Task 2: `readCredentials` adapter

**Files:**
- Create: `src/runProxy/readCredentials.ts`
- Test: `tests/unit/runProxy/readCredentials.test.ts`

**Interfaces:**
- Consumes: `Credentials` from `src/runProxy/types.ts`.
- Produces: `function readCredentials(path: string): Credentials | null` — returns `null` on missing file, parse failure, or a partial/mid-write read, so the caller can skip the event and wait for the next.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/readCredentials.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCredentials } from '../../../src/runProxy/readCredentials';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-proxy-creds-'));
  path = join(dir, '.credentials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCredentials', () => {
  it('parses accessToken and expiresAt from claudeAiOauth', () => {
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-xyz', expiresAt: 1_700_000_000_000 } }),
    );
    expect(readCredentials(path)).toEqual({ accessToken: 'sk-ant-oat01-xyz', expiresAt: 1_700_000_000_000 });
  });

  it('returns null when the file does not exist', () => {
    expect(readCredentials(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on a partial / truncated mid-write read', () => {
    writeFileSync(path, '{"claudeAiOauth": {"accessToken": "sk-ant');
    expect(readCredentials(path)).toBeNull();
  });

  it('returns null when required fields are missing or the wrong type', () => {
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    expect(readCredentials(path)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/readCredentials.test.ts`
Expected: FAIL — cannot resolve `readCredentials`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/readCredentials.ts`:

```typescript
import { readFileSync } from 'node:fs';
import type { Credentials } from './types';

/**
 * Read and parse the Claude credentials file. Returns null on any failure
 * (missing file, invalid JSON from a partial mid-write read, or missing/wrong
 * fields) so the caller can skip the event and wait for the next write.
 */
export function readCredentials(path: string): Credentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;

  if (!oauth || typeof oauth.accessToken !== 'string' || typeof oauth.expiresAt !== 'number') {
    return null;
  }

  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/readCredentials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/readCredentials.ts tests/unit/runProxy/readCredentials.test.ts
git commit -m "feat: add readCredentials adapter for run-proxy"
```

---

## Task 3: `writeSecret` adapter (ports `host-session-hook.sh`)

**Files:**
- Create: `src/runProxy/writeSecret.ts`
- Test: `tests/unit/runProxy/writeSecret.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `function formatSecret(token: string): string` — pure; returns the SDS YAML with a trailing newline.
  - `function writeSecret(token: string, path: string): void` — `mkdir -p` the parent dir, then write `formatSecret(token)`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/writeSecret.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatSecret } from '../../../src/runProxy/writeSecret';

describe('formatSecret', () => {
  it('emits the SDS secret structure with a Bearer-prefixed inline_string', () => {
    expect(formatSecret('sk-ant-oat01-xyz')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: sandbox_bearer_token',
        '    generic_secret:',
        '      secret:',
        '        inline_string: "Bearer sk-ant-oat01-xyz"',
        '',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/writeSecret.test.ts`
Expected: FAIL — cannot resolve `formatSecret`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/writeSecret.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render the Envoy file-based SDS secret. Structure must match the committed
 * `envoy/secrets/sds-secret.yaml`. This is `scripts/host-session-hook.sh`'s
 * heredoc body ported to TypeScript.
 */
export function formatSecret(token: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: sandbox_bearer_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}

export function writeSecret(token: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/writeSecret.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Sanity-check against the committed fixture**

Run: `pnpm exec vitest run tests/unit/runProxy/writeSecret.test.ts` and confirm the expected block matches lines 1-6 of `envoy/secrets/sds-secret.yaml` (same indentation and `@type`). It does.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/writeSecret.ts tests/unit/runProxy/writeSecret.test.ts
git commit -m "feat: add writeSecret adapter porting host-session-hook.sh"
```

---

## Task 4: Side-effecting adapters + dependencies (`recreateContainer`, `nudgeRefresh`, `watchCredentials`)

These three are thin subprocess/FS wrappers with no independent behavior worth a unit test — they are exercised by the orchestrator's mocks (Task 5) and the integration test (Task 7). The task's testable deliverable is a clean `pnpm typecheck` + `pnpm build`.

**Files:**
- Modify: `package.json` (add `watcher`, move `execa` to `dependencies`)
- Create: `src/runProxy/recreateContainer.ts`
- Create: `src/runProxy/nudgeRefresh.ts`
- Create: `src/runProxy/watchCredentials.ts`

**Interfaces:**
- Consumes: `NudgeResult` from `src/runProxy/types.ts`.
- Produces:
  - `function recreateContainer(serviceName: string): Promise<void>` — runs `docker compose up -d --force-recreate <serviceName>`, inheriting `process.env` and cwd; rejects on non-zero exit.
  - `function nudgeRefresh(): Promise<NudgeResult>` — runs `claude -p <prompt> --model haiku`; resolves `{ ok: true, stderr: '' }` on success, `{ ok: false, stderr }` on any process error.
  - `function watchCredentials(credentialsPath: string, onEvent: () => void): { close: () => void }` — watches the parent dir non-recursively, calls `onEvent` whenever the credentials file is added/changed/renamed.

- [ ] **Step 1: Add the `watcher` dependency and promote `execa`**

Run:
```bash
pnpm add watcher
pnpm add execa
```
`pnpm add execa` moves it from `devDependencies` into `dependencies` (it is now used at runtime, not just in tests). Confirm `package.json` `dependencies` afterward contains `commander`, `configamatron` (the `link:` self-ref), `execa`, `watcher`, and `yaml`, and that `execa` is no longer under `devDependencies`.

- [ ] **Step 2: Write `recreateContainer`**

Create `src/runProxy/recreateContainer.ts`:

```typescript
import { execa } from 'execa';

/**
 * Recreate the Envoy container so it re-reads the on-disk SDS secret.
 * `--force-recreate` is required: writing the secret does not change the compose
 * config, so a plain `up -d` would leave a running container untouched with its
 * stale in-memory token. Idempotent across absent/running/stopped/dead states.
 * Inherits process.env (so ENVOY_* port overrides flow through) and cwd.
 */
export async function recreateContainer(serviceName: string): Promise<void> {
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', serviceName]);
}
```

- [ ] **Step 3: Write `nudgeRefresh`**

Create `src/runProxy/nudgeRefresh.ts`:

```typescript
import { execa } from 'execa';
import type { NudgeResult } from './types';

/** Minimal prompt whose only purpose is to make the CLI perform a token refresh. */
const NUDGE_PROMPT = 'Reply with the single word: ok';

/**
 * Nudge the official `claude` CLI to refresh the OAuth token. We never touch the
 * refresh token ourselves — the CLI stays the sole authority over credentials.json.
 * Success here means the process exited 0; whether the token actually advanced is
 * determined by the watcher observing a new expiresAt.
 */
export async function nudgeRefresh(): Promise<NudgeResult> {
  try {
    await execa('claude', ['-p', NUDGE_PROMPT, '--model', 'haiku']);
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return { ok: false, stderr };
  }
}
```

- [ ] **Step 4: Write `watchCredentials`**

Create `src/runProxy/watchCredentials.ts`:

```typescript
import Watcher from 'watcher';
import { basename, dirname } from 'node:path';

/**
 * Watch the credentials file for changes. Watches the parent directory
 * non-recursively and filters to the target basename, because Claude Code
 * rewrites credentials.json via atomic rename (new inode) — the case where raw
 * fs.watch silently goes dead on Windows. The `watcher` package handles
 * rename/replace and debouncing cross-platform.
 */
export function watchCredentials(
  credentialsPath: string,
  onEvent: () => void,
): { close: () => void } {
  const dir = dirname(credentialsPath);
  const target = basename(credentialsPath);

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

- [ ] **Step 5: Typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: both succeed. If `watcher`'s types make the `.on('all', ...)` listener signature complain, adjust the listener parameter types to match the package's exported event types (keep `basename(targetPath)` filtering).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/runProxy/recreateContainer.ts src/runProxy/nudgeRefresh.ts src/runProxy/watchCredentials.ts
git commit -m "feat: add docker/claude/watcher adapters for run-proxy"
```

---

## Task 5: `runProxyLoop` orchestrator

The state machine. Injectable adapters make it unit-testable with mocks and `vi.useFakeTimers()`.

**Files:**
- Create: `src/runProxy/runProxyLoop.ts`
- Test: `tests/unit/runProxy/runProxyLoop.test.ts`

**Interfaces:**
- Consumes: `planNextActions` (Task 1); `Credentials`, `NudgeResult`, `RefreshState` types (Task 1).
- Produces:
  - `interface RunProxyConfig { credentialsPath: string; secretPath: string; serviceName: string; refreshWindowMs: number; retryIntervalMs: number; maxAttempts: number; refreshEnabled: boolean }`
  - `interface RunProxyDeps { readCredentials; writeSecret; recreateContainer; nudgeRefresh; watch; onSigint; log; error; now }` (exact shapes below).
  - `function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number>` — resolves with the process exit code: `0` on SIGINT (container left running), `1` on any fatal error.

**State machine (implemented below — read before coding):**
- **Startup:** read creds (null → fatal), `writeSecret`, `await recreateContainer` (throw → fatal), start watcher, register SIGINT, arm the nudge timer from `planNextActions`.
- **Single self-rescheduling timer.** When it fires: if `awaitingOutcome`, the retry/outcome deadline was reached with no observed advance → a failed attempt; otherwise it is time to nudge.
- **`doNudge`:** set `awaitingOutcome`, record `lastNudgeAt`, arm the deadline at `lastNudgeAt + retryInterval`, then `await nudgeRefresh()`. A process error (`ok:false`) is an immediate failed attempt; success leaves the deadline armed to await a watcher-observed advance.
- **Failed attempt:** `consecutiveFailures++`; `>= maxAttempts` → fatal; else `doNudge` again.
- **Watcher event:** read creds (null → warn + skip); if `propagate`, `writeSecret` + recreate (one retry, else fatal) and update `lastAppliedToken`; if `expiresAt` advanced, reset `consecutiveFailures`/`awaitingOutcome` (refresh succeeded); re-arm the timer from `planNextActions`.
- **SIGINT:** stop watcher + timer, resolve `0`, leave the container running.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/runProxyLoop.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runProxyLoop, type RunProxyConfig, type RunProxyDeps } from '../../../src/runProxy/runProxyLoop';
import type { Credentials } from '../../../src/runProxy/types';

const MIN = 60_000;

function baseConfig(overrides: Partial<RunProxyConfig> = {}): RunProxyConfig {
  return {
    credentialsPath: '/fake/.credentials.json',
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
  fireWatcher: () => void;
  fireSigint: () => void;
  mocks: {
    writeSecret: ReturnType<typeof vi.fn>;
    recreateContainer: ReturnType<typeof vi.fn>;
    nudgeRefresh: ReturnType<typeof vi.fn>;
    watchClose: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(initial: Credentials): Harness {
  const creds = { value: initial };
  let watcherCb: (() => void) | null = null;
  let sigintCb: (() => void) | null = null;
  const watchClose = vi.fn();
  const mocks = {
    writeSecret: vi.fn(),
    recreateContainer: vi.fn().mockResolvedValue(undefined),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    watchClose,
    error: vi.fn(),
  };
  const deps: RunProxyDeps = {
    readCredentials: () => creds.value,
    writeSecret: mocks.writeSecret,
    recreateContainer: mocks.recreateContainer,
    nudgeRefresh: mocks.nudgeRefresh,
    watch: (_path, onEvent) => {
      watcherCb = onEvent;
      return { close: watchClose };
    },
    onSigint: (handler) => {
      sigintCb = handler;
    },
    log: vi.fn(),
    error: mocks.error,
    now: () => Date.now(),
  };
  return {
    deps,
    creds,
    fireWatcher: () => watcherCb?.(),
    fireSigint: () => sigintCb?.(),
    mocks,
  };
}

/** Flush pending microtasks + zero-delay timers so async startup/handlers settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProxyLoop', () => {
  it('writes the secret and recreates the container on startup', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
  });

  it('propagates a changed token on a watcher event: writeSecret + recreate once', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.writeSecret.mockClear();
    h.mocks.recreateContainer.mockClear();

    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireWatcher();
    await flush();

    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(1);
  });

  it('does not propagate when the token is unchanged', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    void runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    h.creds.value = { accessToken: 'A', expiresAt: 61 * MIN }; // only expiry moved
    h.fireWatcher();
    await flush();

    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });

  it('exits non-zero after maxAttempts consecutive no-advance nudges', async () => {
    // expiresAt within the refresh window so the nudge fires immediately at startup.
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const exit = runProxyLoop(baseConfig({ maxAttempts: 3 }), h.deps);
    await flush(); // startup arms nudge at now -> fires -> doNudge #1

    // Each retryInterval with no expiresAt advance is one failed attempt.
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
    h.fireWatcher();
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

  it('retries a propagate docker failure once, then exits non-zero', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();

    h.mocks.recreateContainer.mockRejectedValue(new Error('docker boom'));
    h.mocks.recreateContainer.mockClear();
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    h.fireWatcher();
    await flush();

    expect(h.mocks.recreateContainer).toHaveBeenCalledTimes(2); // initial + one retry
    await expect(exit).resolves.toBe(1);
  });

  it('on SIGINT tears down and exits 0 without touching the container', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const exit = runProxyLoop(baseConfig(), h.deps);
    await flush();
    h.mocks.recreateContainer.mockClear();

    h.fireSigint();

    await expect(exit).resolves.toBe(0);
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(1);
    expect(h.mocks.recreateContainer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: FAIL — cannot resolve `runProxyLoop`.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/runProxyLoop.ts`:

```typescript
import { planNextActions } from './planNextActions';
import type { Credentials, NudgeResult, RefreshState } from './types';

export interface RunProxyConfig {
  credentialsPath: string;
  secretPath: string;
  serviceName: string;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface RunProxyDeps {
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (token: string, path: string) => void;
  recreateContainer: (serviceName: string) => Promise<void>;
  nudgeRefresh: () => Promise<NudgeResult>;
  watch: (credentialsPath: string, onEvent: () => void) => { close: () => void };
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}

/**
 * Long-running orchestrator. Resolves with a process exit code: 0 on SIGINT
 * (container left running under its restart policy), 1 on any fatal error.
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
    let watcherHandle: { close: () => void } | null = null;
    let settled = false;

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

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      watcherHandle?.close();
      resolve(code);
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      settle(1);
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

    const onWatcherEvent = async (): Promise<void> => {
      if (settled) return;
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        deps.error('run-proxy: skipped credentials event (unreadable or partial write)');
        return;
      }

      const advanced = lastSeenExpiresAt !== null && creds.expiresAt > lastSeenExpiresAt;

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });

      if (plan.propagate) {
        deps.writeSecret(creds.accessToken, config.secretPath);
        const ok = await recreateWithOneRetry();
        if (settled) return;
        if (!ok) {
          fatal('docker failed to recreate the container while propagating a new token');
          return;
        }
        lastAppliedToken = creds.accessToken;
      }

      if (advanced) {
        // Refresh landed: reset failure tracking and stop awaiting an outcome.
        consecutiveFailures = 0;
        awaitingOutcome = false;
      }
      lastSeenExpiresAt = creds.expiresAt;

      const nextPlan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(nextPlan.nudgeAt);
    };

    const start = async (): Promise<void> => {
      const creds = deps.readCredentials(config.credentialsPath);
      if (creds === null) {
        fatal(`could not read credentials at ${config.credentialsPath}`);
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

      watcherHandle = deps.watch(config.credentialsPath, () => {
        void onWatcherEvent();
      });
      deps.onSigint(() => {
        deps.log('run-proxy: SIGINT received, stopping (container left running)');
        settle(0);
      });

      const plan = planNextActions({
        creds,
        lastAppliedToken,
        now: deps.now(),
        config: planConfig,
        refresh: refreshState(),
      });
      armTimer(plan.nudgeAt);
      deps.log('run-proxy: watching credentials; proxy is serving the current token');
    };

    void start();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/runProxy/runProxyLoop.test.ts`
Expected: PASS (7 tests). If a timing test hangs, ensure each async boundary is flushed with `await vi.advanceTimersByTimeAsync(...)` (used above) rather than bare `setTimeout`.

- [ ] **Step 5: Run the full unit suite and typecheck**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/runProxyLoop.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "feat: add runProxyLoop orchestrator for run-proxy"
```

---

## Task 6: `run-proxy` CLI command + wiring

**Files:**
- Create: `src/commands/runProxy.ts`
- Modify: `src/cli.ts`
- Test: `tests/e2e/cli.test.ts` (add a case)

**Interfaces:**
- Consumes: `runProxyLoop`, `RunProxyConfig`, `RunProxyDeps` (Task 5); all adapters (Tasks 2-4).
- Produces: `function registerRunProxy(program: Command): void`.

- [ ] **Step 1: Write the command registration**

Create `src/commands/runProxy.ts`:

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readCredentials } from '../runProxy/readCredentials';
import { writeSecret } from '../runProxy/writeSecret';
import { recreateContainer } from '../runProxy/recreateContainer';
import { nudgeRefresh } from '../runProxy/nudgeRefresh';
import { watchCredentials } from '../runProxy/watchCredentials';
import { runProxyLoop, type RunProxyDeps } from '../runProxy/runProxyLoop';

interface RunProxyOptions {
  credentials: string;
  secret: string;
  service: string;
  refreshWindow: string;
  retryInterval: string;
  maxAttempts: string;
  refresh: boolean;
}

export function registerRunProxy(program: Command): void {
  program
    .command('run-proxy')
    .description(
      'Own the Envoy proxy lifecycle: write the SDS secret, recreate the container so ' +
        'Envoy reads the current Claude token, then watch credentials.json and keep the ' +
        'token fresh. Foreground process; Ctrl-C to stop (leaves the container running).',
    )
    .option(
      '--credentials <path>',
      'Claude credentials file to watch',
      join(homedir(), '.claude', '.credentials.json'),
    )
    .option('--secret <path>', 'SDS secret output path', 'envoy/secrets/sds-secret.yaml')
    .option('--service <name>', 'docker compose service to recreate', 'envoy')
    .option('--refresh-window <minutes>', 'nudge this many minutes before expiry', '3')
    .option('--retry-interval <minutes>', 'wait this many minutes for a nudge to take', '2')
    .option('--max-attempts <n>', 'consecutive failed refreshes before exiting', '3')
    .option('--no-refresh', 'watch and propagate only; never nudge the CLI to refresh')
    .action(async (options: RunProxyOptions) => {
      const deps: RunProxyDeps = {
        readCredentials,
        writeSecret,
        recreateContainer,
        nudgeRefresh,
        watch: watchCredentials,
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      const exitCode = await runProxyLoop(
        {
          credentialsPath: options.credentials,
          secretPath: options.secret,
          serviceName: options.service,
          refreshWindowMs: Number(options.refreshWindow) * 60_000,
          retryIntervalMs: Number(options.retryInterval) * 60_000,
          maxAttempts: Number(options.maxAttempts),
          refreshEnabled: options.refresh,
        },
        deps,
      );

      process.exitCode = exitCode;
    });
}
```

Note: commander maps `--no-refresh` to `options.refresh` (defaults `true`, becomes `false` when the flag is present).

- [ ] **Step 2: Wire it into the CLI**

Modify `src/cli.ts` — add the import and registration:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerBuildEnvoyConfig } from './commands/buildEnvoyConfig';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';
import { registerRunProxy } from './commands/runProxy';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerImportSbxNetworkPolicy(program);
registerBuildEnvoyConfig(program);
registerWriteGithubConfig(program);
registerRunProxy(program);

await program.parseAsync();
```

- [ ] **Step 3: Add the e2e registration test**

Add to `tests/e2e/cli.test.ts`, inside the top-level `describe('configamatron CLI', ...)` block (after the `--version` test):

```typescript
  it('lists run-proxy with its flags in help output', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, 'run-proxy', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--credentials');
    expect(stdout).toContain('--no-refresh');
    expect(stdout).toContain('--service');
  });
```

- [ ] **Step 4: Build and run the e2e test**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: PASS, including the new `run-proxy --help` case.

- [ ] **Step 5: Commit**

```bash
git add src/commands/runProxy.ts src/cli.ts tests/e2e/cli.test.ts
git commit -m "feat: register run-proxy command and wire adapters"
```

---

## Task 7: Docker-harness integration test

Extends the existing integration setup: bring up a transient Envoy stack, start the built `run-proxy` (with refresh disabled) against a temp credentials file, write a new token, and assert Envoy picks it up via the admin `config_dump` `last_updated` for `sandbox_bearer_token` advancing.

**Files:**
- Create: `tests/integration/runProxy.test.ts`

**Interfaces:**
- Consumes: the built `dist/cli.js`; `scripts/generate-ca.sh`; `docker compose`; the admin endpoint pattern from `tests/integration/proxy.test.ts`.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/runProxy.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';
import { gitBashPath } from './gitBash';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));

const HTTPS_PORT = 18543;
const HTTP_PORT = 18180;
const ADMIN_PORT = 19902;

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let proxyProc: ResultPromise | null = null;

const envoyEnv = {
  ENVOY_HTTPS_PORT: String(HTTPS_PORT),
  ENVOY_HTTP_PORT: String(HTTP_PORT),
  ENVOY_ADMIN_PORT: String(ADMIN_PORT),
};

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

function adminConfigDump(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: ADMIN_PORT, path: '/config_dump', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Return the `last_updated` timestamp for the sandbox_bearer_token secret, or null. */
function secretLastUpdated(dump: string): string | null {
  const parsed = JSON.parse(dump) as {
    configs?: Array<{ dynamic_active_secrets?: Array<{ name: string; last_updated?: string }> }>;
  };
  for (const config of parsed.configs ?? []) {
    for (const secret of config.dynamic_active_secrets ?? []) {
      if (secret.name === 'sandbox_bearer_token') return secret.last_updated ?? null;
    }
  }
  return null;
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('waitFor timed out');
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-int-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-initial');

  await execa(gitBashPath(), ['scripts/generate-ca.sh'], { cwd: repoRoot });
  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '-o',
      `${repoRoot}/envoy/envoy.yaml`,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );
  mkdirSync(`${repoRoot}/envoy/secrets`, { recursive: true });

  // Start run-proxy in the background with refresh disabled (no real auth/network).
  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--credentials',
      credentialsPath,
      '--secret',
      'envoy/secrets/sds-secret.yaml',
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );

  // run-proxy performs the startup writeSecret + force-recreate; wait for admin readiness.
  await waitFor(() => adminConfigDump(), (dump) => secretLastUpdated(dump) !== null, 60000);
}, 90000);

afterAll(async () => {
  proxyProc?.kill('SIGINT');
  try {
    await proxyProc;
  } catch {
    // ignore non-zero/kill result
  }
  await execa('docker', ['compose', 'down'], { cwd: repoRoot, env: { ...process.env, ...envoyEnv } });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('run-proxy propagates credential changes to the running proxy', () => {
  it('recreates Envoy so the secret last_updated advances when the token changes', async () => {
    const before = secretLastUpdated(await adminConfigDump());
    expect(before).not.toBeNull();

    writeCredentials('token-rotated');

    const after = await waitFor(
      () => adminConfigDump(),
      (dump) => {
        const now = secretLastUpdated(dump);
        return now !== null && now !== before;
      },
      60000,
    );

    expect(secretLastUpdated(after)).not.toBe(before);
    expect(readFileSync(`${repoRoot}/envoy/secrets/sds-secret.yaml`, 'utf8')).toContain(
      'Bearer token-rotated',
    );
  }, 90000);
});
```

- [ ] **Step 2: Build, then run the integration test**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/runProxy.test.ts`
Expected: PASS. Requires Docker running. If `secretLastUpdated` returns `null`, inspect a raw `/config_dump` — the secret may appear under `dynamic_active_secrets` in a differently-shaped `configs` entry; adjust `secretLastUpdated`'s traversal to match the actual admin JSON.

- [ ] **Step 3: Confirm the existing proxy integration test still passes**

Run: `pnpm exec vitest run --config vitest.integration.config.ts`
Expected: both `proxy.test.ts` and `runProxy.test.ts` pass. (They use different admin/HTTP ports, so they don't collide, but they share `envoy/envoy.yaml` and `docker compose`; vitest runs files in separate processes serially by default — if a collision appears, note it and run integration files individually.)

- [ ] **Step 4: Commit**

```bash
git add tests/integration/runProxy.test.ts
git commit -m "test: add run-proxy docker integration test"
```

---

## Task 8: Remove `host-session-hook.sh` and update docs

**Files:**
- Delete: `scripts/host-session-hook.sh`
- Modify: `envoy-proxy.md`
- Modify: `README.md`

**Interfaces:** none (docs + cleanup).

- [ ] **Step 1: Delete the obsolete hook script**

```bash
git rm scripts/host-session-hook.sh
```

- [ ] **Step 2: Replace the SessionStart hook step in `envoy-proxy.md`**

In `envoy-proxy.md`, replace host-side setup step 5 and its JSON block, plus step 6 (`docker compose up -d`), with a single `run-proxy` step. The current steps 5-6 read:

```
5. Add the `SessionStart` hook to `~/.claude/settings.json`, then run `claude` once on the host so the hook populates `envoy/secrets/sds-secret.yaml`.

```
  "hooks": {
    "SessionStart": [
      ...
    ]
  }
```

6. `docker compose up -d`
```

Replace them with:

```markdown
5. `pnpm exec configamatron run-proxy` — this replaces both the old `SessionStart` hook and the manual `docker compose up -d`. It writes `envoy/secrets/sds-secret.yaml` from your current Claude credential, recreates the Envoy container so it reads that token, then stays in the foreground: it watches `~/.claude/.credentials.json` and recreates the container whenever the token changes, and nudges the `claude` CLI to refresh the token shortly before it expires. Leave it running (like `docker compose up` without `-d`); Ctrl-C stops it and leaves the container running.
   - Must run **on the host** with the `claude` CLI installed and logged in (it is the sole authority over `credentials.json`).
   - Pass `--no-refresh` to only watch and propagate without nudging the CLI. Run `pnpm exec configamatron run-proxy --help` for all flags.
```

Then renumber the following step (the Windows firewall step) from `7.` to `6.` and update its cross-reference: the firewall step's text says "printed by host-side step 7" — leave the *self*-reference wording intact but update any other step that points at "step 7" for the host IP.

- [ ] **Step 3: Fix the host-IP cross-reference in `envoy-proxy.md`**

In the VM-side setup section, step 4 currently reads "`<host-ip>` is printed by host-side step 7." Update it to "printed by host-side step 6." (the renumbered firewall step).

- [ ] **Step 4: Note `run-proxy` in `README.md`**

`README.md` links to `envoy-proxy.md` and lists the verification pipeline but does not enumerate CLI commands, so no command reference needs editing. Confirm `README.md` contains no reference to `host-session-hook.sh` (search it); if it does, replace it with `run-proxy`. Expected: no matches, no edit needed.

Run: `pnpm exec grep -r host-session-hook README.md envoy-proxy.md` (or use ripgrep) — expect zero matches after Steps 2-3.

- [ ] **Step 5: Run the full verification pipeline**

Run: `pnpm test`
Expected: PASS end-to-end (format, lint, typecheck, unit, build, e2e, integration).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: replace SessionStart hook with run-proxy; remove host-session-hook.sh"
```

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|-----------|------|
| `planNextActions` pure core (propagate + nudgeAt rules) | Task 1 |
| `readCredentials` (tolerates partial read) | Task 2 |
| `writeSecret` (ports `host-session-hook.sh`; matches fixture) | Task 3 |
| `recreateContainer` (`--force-recreate`) | Task 4 |
| `nudgeRefresh` (`claude -p … --model haiku`, stderr capture) | Task 4 |
| `watcher` dependency; watch `~/.claude/` filtered to `.credentials.json`, rename-safe | Task 4 |
| `runProxyLoop` orchestrator (startup, watcher event, single self-rescheduling timer, failure counting, SIGINT) | Task 5 |
| Configuration flags with defaults; refresh-disable | Task 6 |
| `registerRunProxy` + `src/cli.ts` registration | Task 6 |
| Unit tests: planNextActions, orchestrator (fake timers), writeSecret | Tasks 1, 3, 5 |
| Integration test (docker harness, config_dump last_updated advances, nudge disabled) | Task 7 |
| Delete `scripts/host-session-hook.sh`; docs replace SessionStart hook | Task 8 |

All spec sections map to a task. The "manual" nudge-timing verification is explicitly out of automation scope (spec §Testing/Manual) and is not a task.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; error handling is concrete (`fatal`, `recreateWithOneRetry`, `handleFailedAttempt`); no "handle edge cases" hand-waving.

**3. Type consistency:** `Credentials { accessToken; expiresAt }`, `RefreshState { enabled; awaitingOutcome; lastNudgeAt }`, `PlanConfig { refreshWindowMs; retryIntervalMs }`, `PlanResult { propagate; nudgeAt }`, `NudgeResult { ok; stderr }` are defined once in Task 1 and consumed unchanged in Tasks 2, 4, 5, 6. `runProxyLoop(config, deps): Promise<number>`, `RunProxyConfig`, and `RunProxyDeps` field names in Task 5 match their use in Task 6 and the tests. `planNextActions` signature matches between Task 1's definition and Task 5's calls.
