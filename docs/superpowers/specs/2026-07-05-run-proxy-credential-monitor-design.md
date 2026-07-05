# `run-proxy` Credential Monitor — Design

## Purpose

The Envoy sandbox proxy injects the host's Claude bearer token into the VM's
requests, reading it from `envoy/secrets/sds-secret.yaml` (file-based SDS). Two
findings from investigating live-reload behaviour motivate this work:

1. **The running proxy never picks up token changes.** Envoy's SDS file watch
   relies on inotify, and inotify events do not cross the Docker Desktop bind
   mount on Windows (the secrets dir lives on the Windows filesystem, mounted
   into the Linux container via grpcfuse/virtiofs). Confirmed empirically: after
   both in-place and atomic-rename writes to `sds-secret.yaml`, the admin
   `config_dump` `last_updated` for `sandbox_bearer_token` stayed frozen at
   container-start time. The value is effectively read **once, when the container
   starts**.

2. **The container is long-lived, not per-session.** It runs under
   `docker compose` with `restart: always`. So the current `SessionStart` hook
   (`scripts/host-session-hook.sh`), which rewrites `sds-secret.yaml` on the host,
   updates a file the running container will never re-read. When the host's OAuth
   access token is refreshed, the VM eventually gets 401s from `api.anthropic.com`
   until the container is recreated.

This spec introduces a new `configamatron run-proxy` command that owns the proxy
lifecycle: it writes the secret, (re)creates the container so Envoy reads the
current token, then **monitors `~/.claude/.credentials.json`** and recreates the
container whenever the token changes. It also keeps the token fresh by nudging the
official `claude` CLI to refresh shortly before expiry, so the VM keeps working
even when the host runs no interactive Claude Code sessions.

`run-proxy` replaces `scripts/host-session-hook.sh` and its `SessionStart` hook.

## Non-goals

- **No reverse-engineered OAuth.** `run-proxy` never calls Anthropic's token
  endpoint or handles refresh tokens itself. The official `claude` CLI remains the
  sole authority over `credentials.json`, which keeps refresh safe even when
  interactive Claude Code runs on the same host (no refresh-token rotation races).
- **No fix to Envoy's inotify reload.** We recreate the container rather than try
  to make in-container file watching work across the Docker Desktop mount.
- **No change to the Envoy config, allowlist pipeline, CA, or VM-side setup.**
- **No daemonization.** `run-proxy` is a foreground process the user leaves
  running (like `docker compose up` without `-d`).

## Architecture

`run-proxy` is a long-running foreground command. It splits into a **pure
decision core** plus **thin, mockable side-effecting adapters**, and is driven by
two independent event sources — a file watcher (propagation) and a scheduled
timer (refresh) — with no polling interval.

```
~/.claude/.credentials.json ──(watcher: file change)──► readCredentials
                                                              │
                                                    planNextActions (pure)
                                                        │           │
                                             propagate? │           │ nudgeAt
                                                        ▼           ▼
                                   writeSecret + recreateContainer  (re)arm nudge timer
                                                        │                    │
                                                        ▼                    ▼
                                       sds-secret.yaml + `docker      timer fires ──► nudgeRefresh
                                       compose up -d --force-          (`claude -p … --model haiku`)
                                       recreate envoy`                        │
                                                                     refresh updates credentials.json
                                                                     ──► watcher fires (loop closes)
```

### Why event-driven, not polling

Propagation is event-shaped (react when `credentials.json` changes); the refresh
nudge is time-shaped (act a fixed interval before a known `expiresAt`). A poll
loop approximates both badly and forces an awkward interval choice. Instead:

- **Propagation** uses a file watcher (the [`watcher`](https://www.npmjs.com/package/watcher)
  package). Claude Code rewrites `credentials.json` via atomic rename (new inode),
  the exact case where raw `fs.watch` on Windows silently goes dead; `watcher`
  handles rename/replace and debouncing cross-platform. It watches `~/.claude/`
  non-recursively, filtered to `.credentials.json`.
- **Refresh** uses a single self-rescheduling `setTimeout`, computed from the
  exact `expiresAt`. The watcher re-arms this timer whenever `expiresAt` changes.

Idle overhead is ~zero: a far-future timer plus native FS events.

### Pure decision core

```
planNextActions({ creds, lastAppliedToken, now, config, refresh })
  → { propagate: boolean, nudgeAt: number | null }
```

`refresh` carries the retry state the timing needs: whether a nudge is currently
awaiting an outcome and when it last fired (exact field shape finalized in the
plan).

- `propagate` — `creds.accessToken !== lastAppliedToken`.
- `nudgeAt` — when to (re)arm the nudge timer:
  - normally `expiresAt − refreshWindow`;
  - `now` if that point is already past (token within-window or expired — fire
    immediately);
  - `refresh.lastNudgeAt + retryInterval` if a nudge is awaiting an outcome and
    `expiresAt` has not advanced;
  - `null` when refresh handling is disabled.

All timing lives here with no I/O, so it is exhaustively unit-testable by varying
`now`/`expiresAt`/`refresh`.

### Adapters (side-effecting, injectable)

- `readCredentials(path)` → parsed `claudeAiOauth`. Tolerates a partial mid-write
  read (parse failure → skip event, wait for the next).
- `writeSecret(token, path)` → writes `sds-secret.yaml` as
  `inline_string: "Bearer <token>"`. This is `host-session-hook.sh`'s body ported
  to TypeScript.
- `recreateContainer()` → `docker compose up -d --force-recreate envoy`.
- `nudgeRefresh()` → `claude -p "<minimal prompt>" --model haiku`.

### Orchestrator (`runProxyLoop`)

**Startup:**
1. `readCredentials` → `writeSecret` → `docker compose up -d --force-recreate
   envoy`. `--force-recreate` is required: writing the secret does not change the
   compose config, so plain `up -d` would leave an already-running container
   untouched with its stale in-memory token. `--force-recreate` is idempotent
   across every prior state (absent / running / stopped / dead) and always ends
   with Envoy reading the current secret. Failure here is fatal (exit non-zero).
2. Start the `watcher`.
3. `planNextActions` → arm the nudge timer (may be `now` if already near expiry).

**Watcher event (`credentials.json` changed):**
- `readCredentials` → `planNextActions`.
- If `propagate` → `writeSecret` + `recreateContainer`; update `lastAppliedToken`.
- If `expiresAt` advanced → refresh succeeded: reset `consecutiveFailures = 0`,
  cancel any pending retry, re-arm the nudge timer to `newExpiresAt − refreshWindow`.

**Nudge timer fires:**
- `nudgeRefresh()`; arm a `retryInterval` timer as the outcome deadline.
  - Watcher reports advanced `expiresAt` first → success (above).
  - Retry timer fires with no advance → attempt failed: `consecutiveFailures++`.
    - `>= maxAttempts` → log error + exit non-zero.
    - else → nudge again.

An **attempt fails** if the `claude` process errors (non-zero exit / not found /
network) **or** it ran but `expiresAt` did not advance within `retryInterval`.
`consecutiveFailures` counts consecutive failures only; any success resets it. The
final error message includes the last CLI stderr when the CLI errored, else
`"token did not refresh after N attempts"`.

We **keep nudging past `expiresAt`** — the refresh token outlives the access token
by far (the host refreshes fine after >8h idle), so giving up at expiry would be
wrong. `maxAttempts` is the only stop condition for refresh.

### Configuration (flags, with defaults)

| Flag | Default | Meaning |
|------|---------|---------|
| `refreshWindow` | 3 min | Nudge this long before `expiresAt`. Safely inside the confirmed ~4-min CLI refresh window. |
| `retryInterval` | 2 min | Wait this long for a nudge to take before counting it failed / retrying. |
| `maxAttempts` | 3 | Consecutive failed refresh attempts before fatal exit. |
| credentials path | `~/.claude/.credentials.json` | Source file to watch. |
| secret path | `envoy/secrets/sds-secret.yaml` | SDS output. |
| service name | `envoy` | `docker compose` service to recreate. |
| refresh enabled | on | Disable to watch/propagate only (never nudge). |

### Error handling summary

- **Startup docker failure** → fatal, exit non-zero.
- **Propagate docker failure** (mid-run) → error log; retry once, then exit
  non-zero (Envoy is serving a stale token — fail loud).
- **Credential read/parse error** → warn, skip the event, await the next.
- **Refresh failures** → bounded by `maxAttempts`, then fatal exit.
- **SIGINT** → stop watcher + timers, leave the container running (it has
  `restart: always`), exit 0.

`maxAttempts` governs *refresh* only; docker failures are handled separately.

## Components / Deliverables

- `src/commands/runProxy.ts` — `registerRunProxy(program)`; wires the CLI command,
  flags, adapters, and orchestrator.
- `src/runProxy/planNextActions.ts` — the pure decision core.
- `src/runProxy/*` — adapters (`readCredentials`, `writeSecret`,
  `recreateContainer`, `nudgeRefresh`) and `runProxyLoop` orchestrator, kept in
  small focused files.
- `src/cli.ts` — register `run-proxy`.
- `package.json` — add the `watcher` dependency.
- `scripts/host-session-hook.sh` — deleted (its logic moves into `writeSecret`).
- `envoy-proxy.md` / `README.md` — replace the `SessionStart` hook setup step with
  "run `configamatron run-proxy`"; note it must run on the host with the `claude`
  CLI installed and logged in.

## Testing / Verification Plan

**Unit — `planNextActions` (pure, no I/O):**
- Token unchanged → `propagate: false`; changed → `true`.
- `expiresAt` far out → `nudgeAt = expiresAt − refreshWindow`.
- `expiresAt` within window / past → `nudgeAt = now`.
- Nudge awaiting an outcome, not advanced → `nudgeAt = refresh.lastNudgeAt + retryInterval`.
- `expiresAt` advanced → nudge pushed far out.

**Unit — orchestrator with mocked adapters + fake timers** (`vi.useFakeTimers`):
- Watcher event with changed token → `writeSecret` + `recreateContainer` once.
- Nudge fires; no-advance × `maxAttempts` → exit non-zero with the error message;
  a success mid-sequence resets the counter.
- Propagate docker failure → retry once → exit non-zero.
- SIGINT → watcher/timers torn down, exit 0, container left running.

**Unit — `writeSecret`:** emitted `sds-secret.yaml` matches the expected
`inline_string: "Bearer <token>"` structure (match any existing fixture).

**Integration (extends the existing docker harness):** start `run-proxy` against a
temp `credentials.json` and the transient Envoy stack; write a new token into the
file; assert Envoy serves it (admin `config_dump` `last_updated` for
`sandbox_bearer_token` advances). The `claude`-CLI nudge is mocked/disabled here —
it needs real auth and network; its trigger *timing* is covered by the unit tests.

**Manual (not automated):** confirm `claude -p … --model haiku` refreshes the
token near expiry. Already validated by hand: refreshes at ~3–4 min before
`expiresAt`, does not at ~10 min. This is the one empirical dependency and is
noted as a manual check.
