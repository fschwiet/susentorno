# run-proxy robustness: shutdown abort + never-serving fast-fail

**Date:** 2026-07-18
**Scope:** Issue #2 from the proxy diagnosis (proxy robustness / defense-in-depth). Issue #1
(allowlist cross-section de-confliction) is tracked separately and is **not** part of this spec.

## Problem

When Envoy is handed a config it will never serve — the case issue #1 can currently produce —
`run-proxy` wedges instead of failing cleanly:

- **`waitColorReady`** (`src/runProxy/waitColorReady.ts:30-41`) polls the color's admin `/ready`
  on a self-re-arming 250 ms `setTimeout` for the full `timeoutMs` (60 s at startup). It never
  checks whether shutdown has begun, so a Ctrl+C during the wait resolves the loop promise but
  leaves the orphaned poll re-arming its timer, keeping the event loop alive for up to 60 s. The
  second-SIGINT guard (`src/runProxy/runProxyLoop.ts:335`) swallows every further Ctrl+C, so the
  terminal is unresponsive for that minute.
- The same shape exists in **`gateway.drain`** (`src/runProxy/gateway.ts:95-99`): a 100 ms poll
  loop bounded only by `drainTimeoutMs` (30 s), with no shutdown awareness.
- Even absent a Ctrl+C, `bringUpColor` runs `docker compose up -d` **detached** — it returns as
  soon as the container launches, never waiting for health. If Envoy rejects the config it exits
  immediately, but `waitColorReady` only sees `ECONNREFUSED` and cannot tell "still warming up"
  from "already dead," so it burns the full 60 s before reporting failure.

Net effect: a config Envoy refuses either wedges Ctrl+C for ~60 s, or fails 60 s slower than it
needs to, with a message that doesn't hint at the cause.

## Goals

1. Shutdown (`shutdown()` in `runProxyLoop`) interrupts any in-flight `waitColorReady` / drain
   wait **immediately**, so Ctrl+C is always responsive.
2. A color whose container has **exited** is detected and reported **fast**, instead of waiting out
   the timeout. The timeout remains the backstop for "container alive but Envoy wedged."
3. A **test-only fault-injection** mechanism lets the e2e suite deterministically reproduce both a
   crashing-config color and a wedged color — in a way that survives the issue-#1 fix, so these
   tests keep verifying the robustness paths after the underlying allowlist bug is gone.

Non-goals: changing the allowlist parser (issue #1); changing blue-green swap semantics; adding
user-facing diagnostics beyond one distinguishing log line.

## Design

### 1. Shutdown abort (AbortSignal)

`runProxyLoop` owns a single `AbortController` (`shutdownAbort`). `shutdown()` calls
`shutdownAbort.abort()` before it resolves the loop promise — so the abort fires synchronously the
moment `settled` flips.

The signal threads into the two long-poll deps, whose signatures gain it:

- `waitColorReady: (color: Color, ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<WaitResult>`
- `drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<void>`

Both implementations replace their bare `setTimeout` sleep with an **abortable sleep** helper that
resolves either when the delay elapses or when the signal aborts (non-throwing):

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- **`waitColorReady`**: each iteration checks `signal.aborted` (top of loop and after the sleep) and
  returns `{ ready: false, reason: 'timeout' }` immediately when set. The `if (settled) return`
  guards already present after each `deps.waitColorReady` call (`runProxyLoop.ts:294,386`) discard
  the result, so no shutdown-time message is emitted for the aborted case.
- **`gateway.drain`** (decision **(a)**): on abort, break the wait loop and **return early without
  force-closing** the drained target's connections. The command's `finally` already calls
  `gateway.close()` (`src/commands/runProxy.ts:192`), which destroys every remaining connection a
  moment later — so an abort means "stop waiting and get out," not "do redundant teardown."

Everything else `shutdown()` touches is already handled: the nudge `timer` is cleared, and the log
stream is awaited before resolving.

### 2. Container-exit fast-fail

New module `src/runProxy/isColorRunning.ts`:

```ts
export async function isColorRunning(color: Color, composeDir: string): Promise<boolean>
```

Runs `docker inspect --format '{{.State.Running}}' envoy_<color>` (in `composeDir`); returns
`true` only when the container is running, `false` when it has exited or does not exist (a missing
container / non-zero inspect is treated as not-running).

`waitColorReady` gains the color identity plus this liveness check (injected, so it stays unit-
testable without docker). Its loop becomes:

1. Probe admin `/ready`. On 200 → `{ ready: true }`.
2. If `signal.aborted` → `{ ready: false, reason: 'timeout' }`.
3. Else check liveness; if the container has **exited** → `{ ready: false, reason: 'exited' }`
   immediately.
4. Else if past the deadline → `{ ready: false, reason: 'timeout' }`.
5. Else abortable-sleep and repeat.

Return type widens from `boolean` to:

```ts
type WaitResult = { ready: true } | { ready: false; reason: 'exited' | 'timeout' };
```

The loop's existing `!ready` handling is unchanged in behavior (keep the previous proxy on a
restart; `fatal` at startup) but gains a distinguishing log line: for `reason === 'exited'` it
logs e.g. `run-proxy: new proxy (<color>) exited during startup — likely config issue, check the logs` (and the
startup-path equivalent), versus the existing generic "did not become ready" for `'timeout'`.

The enum is retained specifically for **test observability** (see §4), not for user guidance — in
either failure the operator reads the container logs; the value here is letting the e2e suite assert
*which* path was taken without a flaky timing check.

### 3. Fault injection (test-only)

New `run-proxy` option, mirroring the existing `--upstream-override` "test use only" convention:

```
--inject-fault <crash-config|never-ready>   (test use only)
```

Threaded `run-proxy` → `deps.buildConfig` → `writeEnvoyConfig(allowlist, path, overrides, fault)` →
`generateEnvoyConfig(allowlist, { overrides, fault })`. The fault is applied as a render-time
mutation of the generated `envoy.yaml` — the whole config is ours to generate, so no container
image or entrypoint changes are needed, and the mutation is independent of allowlist resolution
(so it is not neutralized by the issue-#1 fix):

- **`crash-config`** — set `admin.address.socket_address.port_value` to an out-of-range value
  (`70000`). Envoy's bootstrap proto validation constrains `port_value` to `<= 65535`
  (`envoy.config.core.v3.SocketAddress`), so Envoy rejects the config at load with a proto-
  constraint error and exits non-zero **before binding any listener** — deterministically, on every
  platform, independent of the allowlist. It is a single-field mutation of the admin block we
  already emit (`envoyConfig.ts:363-364`). Container reaches `exited` → exercises the §2 fast-fail.
- **`never-ready`** — render an otherwise-valid config but move admin off container port 9901 (the
  port the compose file maps the host admin port to). Envoy runs healthy, but the admin probe is
  refused forever → container stays alive → the classic "up but wedged" case. This is also the
  instrument that parks `run-proxy` in `waitColorReady` for the shutdown-abort e2e test.

When no `--inject-fault` is passed, config rendering is byte-for-byte unchanged.

### 4. Tests

**Unit:**

- `waitColorReady`: (a) an already-aborted signal → resolves `{ ready: false, reason: 'timeout' }`
  promptly (well under `timeoutMs`); (b) `isAlive` reports not-running → resolves
  `{ ready: false, reason: 'exited' }` promptly; (c) existing ready-after-503s and never-ready
  timeout cases still pass (updated to the new return shape).
- `gateway.drain`: with a lingering connection and an aborted signal → resolves promptly instead of
  waiting `timeoutMs`, and does not force-close (left to `close()`).
- `runProxyLoop`: SIGINT fired while a `waitColorReady` mock is still pending (mock resolves only
  when its signal aborts) → the loop aborts the signal and resolves `0` promptly. Extends the
  existing `runProxyLoop shutdown` describe block; the harness `waitColorReady`/`drainBackend`
  mocks are updated to accept and honor the signal argument and the new return shape.

**E2E (docker, extends `tests/integration/runProxy.test.ts` patterns):**

- **Shutdown abort (headline):** start `run-proxy --inject-fault never-ready`; it parks in the
  startup `waitColorReady`. Send SIGINT and assert the process exits promptly (sub-second, and in
  any case far under the 60 s `readyTimeoutMs`). A regression would hang ~60 s.
- **Container-exit fast-fail:** start `run-proxy --inject-fault crash-config`; assert startup fails
  fast with the distinguishing `exited during startup` log line and a non-zero exit, rather than
  waiting out the 60 s timeout.

## Files touched (anticipated)

- `src/runProxy/waitColorReady.ts` — abortable poll, liveness check, `WaitResult` return.
- `src/runProxy/isColorRunning.ts` — **new**, docker liveness probe.
- `src/runProxy/gateway.ts` — abortable `drain`.
- `src/runProxy/runProxyLoop.ts` — `AbortController`, abort in `shutdown()`, pass signal + color to
  the deps, distinguishing log line, `RunProxyDeps` signature updates.
- `src/commands/runProxy.ts` — `--inject-fault` option, wire signal/color/fault into deps.
- `src/runProxy/buildConfig.ts` + `src/envoyConfig.ts` — `fault` option and render-time mutations.
- Tests: `tests/unit/runProxy/waitColorReady.test.ts`, `tests/unit/runProxy/gateway.test.ts`,
  `tests/unit/runProxy/runProxyLoop.test.ts`, `tests/integration/runProxy.test.ts`.

## Open questions

None outstanding. Decisions locked: AbortSignal mechanism (approach A); drain-abort returns early
and defers teardown to `gateway.close()` (option (a)); `WaitResult` enum retained for test
observability; single `--inject-fault` option with `crash-config` and `never-ready` modes.
