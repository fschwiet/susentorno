# Design: Merge config generation and logging into `run-proxy`

**Date:** 2026-07-10
**Status:** Approved (design)

## Summary

`run-proxy` becomes the single command that owns the proxy end to end: it builds
the Envoy config from the allowlist, keeps the Claude credential fresh, watches
`allowlist.txt` and reissues the leaf certificate when needed, and streams the
proxy's tagged access log inline. Two commands are removed — `build-envoy-config`
and `proxy-logs` — because their work now happens inside `run-proxy`.

Motivating goals:

1. Editing `allowlist.txt` should update the running proxy without a separate
   build step or restart command.
2. The proxy's access log should be covered by `pnpm test:vm`, including the case
   where the container is recreated while logging is running (credential or
   allowlist change).
3. There is no longer any need to open a second terminal for logging, and no need
   for an `--include-past` flag: `run-proxy` owns the container from birth, so it
   logs every event from the start with nothing to replay.

## Motivation / background

Today the workflow is three separate commands: `build-envoy-config` (allowlist →
`envoy.yaml`), `run-proxy` (watch credentials, recreate container on token
change), and `proxy-logs` (a separate `docker compose logs --follow` viewer). The
viewer breaks in exactly the situation you most want to observe: when `run-proxy`
force-recreates the container, `docker compose logs --follow` was following the
now-destroyed container and silently goes dead.

Because `run-proxy` already owns every container recreation, folding logging into
it removes that whole class of problem — `run-proxy` re-attaches its own follow at
each recreate — and removes the need for lifecycle monitoring, a second terminal,
and the `--include-past` flag.

A key constraint discovered during design: the leaf TLS certificate's SANs are
derived from the allowlist's terminate hosts (`generate-ca` → `ensureLeaf`). So
watching the allowlist and updating the proxy must reissue the leaf (reusing the
already-trusted root CA) whenever the terminate host set changes; otherwise a
rebuilt `envoy.yaml` would reference a leaf missing the new host's SAN and TLS
would fail in the guest.

## Non-goals

- Changing the root CA lifecycle. `generate-ca` still creates the root, and the
  guest still trusts it. `run-proxy` only ever reissues the *leaf*.
- Incrementally diffing allowlist changes. On an allowlist-triggered restart we
  clear unique-log tracking wholesale rather than clearing only changed hosts.
- Keeping any read-only log viewer. Logging exists only as part of `run-proxy`.
- Preserving `--blocked` / `--debounce` / `--unique` / `--include-past` behavior.
  Logging is unconditional and always "unique" (each host+protocol once).

## Design

### 1. `run-proxy` command surface & lifecycle

`run-proxy` is the single command that owns config generation, the proxy
container, credential freshness, allowlist watching, and inline logging.

**Removed:**
- The `build-envoy-config` command.
- The `proxy-logs` command.
- `run-proxy`'s startup check that `envoy.yaml` already exists (it builds it now).

**Options:**
- `--upstream-override <sniHost=host:port>` — moved from `build-envoy-config`.
  Test-only, repeatable. Applied on every config build (startup and every
  allowlist-triggered rebuild).
- Existing `--credentials`, `--secret`, `--service`, `--refresh-window`,
  `--retry-interval`, `--max-attempts`, `--no-refresh`, `--no-forward`,
  `--forward-listen`, `--forward-ports` unchanged.
- Removed: all `proxy-logs` options (`--follow`, `--blocked`, `--unique`,
  `--debounce`).

**Still required beforehand:** `configamatron init` and `configamatron generate-ca`.
The root CA must exist and be trusted in the guest; `run-proxy` reuses that root
and only reissues the leaf.

**Startup sequence:**
1. Read `allowlist.txt` and `credentials.json`.
2. **Arm both watchers as soon as their files are first read** — before the
   initial container recreate completes. A change that lands during the (slow)
   startup recreate is coalesced and applied in a restart right after first start,
   never dropped.
3. Build `envoy.yaml` from the allowlist (+ overrides).
4. Ensure the leaf matches the terminate hosts (reissue if needed).
5. Write the SDS secret from the current token.
6. Force-recreate the container.
7. Start the log follow.

### 2. Allowlist watching, leaf reissue & config rebuild

`run-proxy` watches `allowlist.txt` with the same `watcher`-based helper used for
credentials (parent-directory watch + basename filter; already handles
atomic-rename editors on Windows).

**On an allowlist change:**
1. Read + parse `allowlist.txt`.
2. **If the wildcard syntax is invalid** (the existing `allowlist.invalid` check
   from `build-envoy-config`): log
   `run-proxy: allowlist has unsupported wildcard syntax, keeping previous config`
   with the offending entries, and **do not restart**. The proxy keeps serving the
   last-good config. The watcher stays live, so fixing the file triggers a fresh
   attempt.
3. **If valid:** compute the terminate-host SANs. If they differ from the current
   leaf's SANs, reissue the leaf (reusing the existing root CA — no guest re-trust).
   Rebuild `envoy.yaml` and write it.
4. Force-recreate the container, logging
   `run-proxy: restarting proxy — allowlist changed`.
5. **Clear all unique-log tracking** (wholesale).

**On a credential change:** today's behavior (write secret → recreate), plus log
`run-proxy: restarting proxy — credentials changed`, and **preserve** unique-log
tracking across the restart.

The leaf-reissue and config-build logic move into small shared functions (reused
from what `generate-ca` and the old `build-envoy-config` did) so both the CLI and
unit tests can call them directly.

### 3. Inline logging (always-on, always-unique)

`run-proxy` runs a `docker compose logs --follow <service>` child and feeds each
line through the existing pipeline:
`parseLine` → `classify` → unique dedup → `formatOutput` → stdout, interleaved
with `run-proxy`'s own status lines.

- **Reuse, don't reinvent:** `parseLine`, `classify`, `formatOutput`, and the
  `unique` path of `Reducer` move (with the deleted `proxy-logs` command's logic)
  into `run-proxy`, relocated under `src/runProxy/`. The `all` and `debounce`
  reducer modes and `keepEntry` / `--blocked` filtering are dropped.
- **No `--tail` / `--include-past` needed:** each recreate produces a fresh
  container whose log history starts empty, and `run-proxy` attaches its follow
  right after recreating — so it sees every line from the container's birth with
  no backlog to replay and no risk of re-dumping.
- **Restart handling for the log stream:** before each force-recreate, stop the
  current log-follow child; after the container is back, start a new one. Driven by
  `run-proxy` itself — no lifecycle polling.
- **Unique state:** one shared unique-tracking map for the life of the process.
  Persists across a credential-triggered restart; cleared wholesale on an
  allowlist-triggered restart.
- **Child teardown** reuses the existing `killProcessTree` helper so the log
  follow dies cleanly on restart and on Ctrl-C.

Logging is unfiltered: both ALLOW (CRED / PASS / HTTP) and BLOCK (TLS / HTTP)
lines are shown, each host+protocol once.

### 4. Clean shutdown (Ctrl-C) & concurrency model

**SIGINT bug fix.** Today `settle(0)` resolves the loop's promise, but the process
keeps running and a second Ctrl-C reprints the "SIGINT received" line (the log
call runs before the `settled` guard, and a handle keeps the event loop alive
after resolve). Fix:

1. **Guard the SIGINT handler itself** so a second Ctrl-C prints nothing and does
   nothing.
2. **Tear down every long-lived handle on shutdown:** credential watcher, allowlist
   watcher, the log-follow child (via `killProcessTree`), any pending timer, and
   the forwarder. Confirm the process actually exits (empirically, e.g. it returns
   to the shell / no stray active handles) rather than assuming; only if a stray
   handle proves unclosable do we fall back to an explicit `process.exit(code)`
   after cleanup.

**Concurrency / coalescing model.** With two watchers plus in-flight restarts:

- A single "restart in progress" flag serializes recreates — never two
  `docker compose up --force-recreate` concurrently.
- Watchers stay armed at all times (startup and during a restart). An event that
  arrives during an in-flight restart sets a per-source "dirty" marker
  (credentials and/or allowlist) instead of being dropped.
- When the current restart finishes, if any dirty marker is set, run exactly one
  more restart that re-reads both files fresh. This collapses a burst of edits into
  the minimum number of recreates while guaranteeing the final state reflects the
  latest files.
- If both credentials and allowlist changed during a restart, the follow-up
  restart clears unique tracking (allowlist change wins).

### 5. Testing

**Unit (`test:unit`).** `runProxyLoop` stays a pure state machine driven by
injected deps, now including `startLogStream` / `stopLogStream`, `buildConfig`,
`ensureLeaf`, and an allowlist watcher. Cases:
- Allowlist change → rebuild + reissue-leaf-if-SANs-changed + recreate + clear
  unique.
- Invalid allowlist edit → no restart, previous config kept, watcher stays live.
- Credential change → recreate, unique tracking preserved.
- Coalescing: an event during an in-flight restart triggers exactly one follow-up
  restart; both-changed → unique cleared.
- SIGINT → single teardown; second SIGINT is a no-op.
- Unique dedup + `formatOutput` behavior (migrated from the deleted `proxy-logs`
  reducer tests, trimmed to the unique path).

**VM (`test:vm`).** Drive the stack through `run-proxy` itself so its stdout can be
captured (approach A). `startProxyStack` folds its former `build-envoy-config` +
`docker compose up` steps into a single `run-proxy` launch (background process,
capturing stdout, with `--upstream-override` and the ports it already sets).
Assertions:
- Log lines appear for guest traffic through the proxy.
- Editing the staged `allowlist.txt` produces `restarting proxy — allowlist changed`
  **and** continued log output afterward (proving the follow re-attached), with
  unique tracking reset.
- Rotating `credentials.json` produces `restarting proxy — credentials changed`
  with continued log output and unique tracking preserved.

### 6. Migration, docs & cleanup

- **Test harnesses:** `tests/proxyStack.ts` and `tests/integration/runProxy.test.ts`
  move from a separate `build-envoy-config … --upstream-override` step to driving
  `run-proxy --upstream-override …` (keeping `--no-refresh --no-forward` where they
  already use them). `startProxyStack` folds `build-envoy-config` + `docker compose
  up` into a single `run-proxy` launch.
- **Delete dead code:** `src/commands/buildEnvoyConfig.ts`,
  `src/commands/proxyLogs.ts`, their CLI registrations, and the now-unused reducer
  modes / `entryFilter` / `keepEntry`. Keep `parseLine`, `classify`,
  `formatOutput`, `killProcessTree`, and the unique logic (relocated under
  `src/runProxy/`).
- **`usage.md`:** rewrite the numbered workflow — remove the `build-envoy-config`
  step and the separate `proxy-logs` section; document that `run-proxy` builds the
  config, watches both `allowlist.txt` and credentials, logs all handled hosts
  inline (unique), reissues the leaf automatically when terminate hosts change, and
  that editing `allowlist.txt` while `run-proxy` runs now takes effect live.
- **`README.md` / `technical-notes.md`:** update references to the two removed
  commands.

## Open questions

None outstanding; all design decisions resolved during brainstorming.
