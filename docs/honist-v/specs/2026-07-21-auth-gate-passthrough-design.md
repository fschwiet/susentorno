# Pass non-placeholder credentials through unmodified instead of rejecting them

**Date:** 2026-07-21

## Background

See `docs/investigations/2026-07-22-remote-control-session-token-rejected-by-claude-gate.md`
for the full investigation. Summary: `/remote-control` fails because Claude Code
mints a second, non-placeholder `sk-ant-si-<JWT>` session token and sends it to
`api.anthropic.com`. The proxy's Lua gate (`templates/proxy/gate.lua`) rejects
any `Authorization` header that isn't *exactly* the sandbox placeholder with a
`403`, so this second credential never reaches the real upstream.

The same gate-then-inject shape exists for three endpoint groups today, all in
`src/envoyConfig.ts`:

- **Claude** (`templates/proxy/gate.lua`, mounted at `/etc/envoy/gate.lua`) — single
  fixed Bearer placeholder.
- **Codex** (`CODEX_GATE_LUA`, inlined) — single fixed Bearer placeholder.
- **GitHub** — two hosts, two gates: `GITHUB_API_TOKEN_GATE_LUA` (accepts `token
  <PAT>` or `Bearer <PAT>`) for `api.github.com`, and `GITHUB_BASIC_GATE_LUA`
  (base64-decodes `Basic <creds>` and checks only the password half, since the
  username is chosen by git's credential helper and unknown at config time) for
  `github.com`.

In every case, a Lua "gate" filter runs first and 403s on any non-matching
`Authorization` value; only requests that pass reach the
`envoy.filters.http.credential_injector` filter, which unconditionally
(`overwrite: true`) replaces `Authorization` with the real credential from SDS
before forwarding upstream.

Separately, the investigation also found that when `Authorization` is absent
entirely (observed for `downloads.claude.ai`), the gate already lets the
request through (`if auth == nil then return end`), but the injector still adds
the real credential unconditionally — causing spurious `401`s from endpoints
that expect no `Authorization` header at all.

## Goal

Replace the reject-on-mismatch behavior with pass-through: a request's
`Authorization` header should be forwarded to the real upstream unmodified
(semantically — see the header-multiplicity note below) whenever it does not
satisfy the host's placeholder predicate — whether it's a different,
non-matching value (e.g. the `sk-ant-si-` session token) or absent entirely.
Injection should happen **only** when the predicate matches. This applies
uniformly to all three endpoint groups (Claude, GitHub, Codex). "Placeholder
predicate" is exact-string comparison for Claude, Codex, and GitHub's
`api.github.com` token gate; for GitHub's `github.com` Basic-auth gate it's
"decodes as `Basic <any-username>:<placeholder-PAT>`", since the username is
chosen by git's credential helper and isn't part of the placeholder itself.

This is intentionally not a security boundary: the isolated VM never has
access to the host's real credentials, so there is nothing sensitive to
protect by rejecting unrecognized values — the placeholder-match logic exists
only to decide when to substitute the real credential, not to gate access.

## Non-goals

- No change to how the real credential is stored, mounted, or delivered via
  SDS.
- No change to the placeholder values themselves.
- No change to the `#pragma auth candidate` mechanism (`buildAuthCandidateEntry`)
  — that remains a separate, per-host, always-passthrough allowlist category.

## Design

### Filter chain shape

Each authenticated host's filter chain changes from:

```
[Lua gate (reject on mismatch)] -> [credential_injector, overwrite:true] -> [Router]
```

to:

```
[Lua pre-filter (host-specific)] -> [credential_injector, overwrite:false] -> [Lua post-filter (shared)] -> [Router]
```

This shape is needed because Envoy's `credential_injector` only exposes one
lever — `overwrite:true` (always replace) or `overwrite:false` (inject only if
the header is currently absent) — and neither setting alone can express
"inject only when the header exactly equals the placeholder": both "genuinely
no header sent" and "wrong header, leave it alone" need to result in *no*
injection, while "header equals placeholder" needs to result in injection.
`overwrite:false` alone conflates the first and third case once the
placeholder is cleared. Two small Lua filters flanking the injector resolve
this without relying on any route-based or dynamic-metadata-based Envoy
mechanism.

### Lua pre-filter (one per host type)

Reuses each existing gate's matching logic (`gate.lua`'s Bearer comparison,
`CODEX_GATE_LUA`'s Bearer comparison, `GITHUB_API_TOKEN_GATE_LUA`'s two-scheme
comparison, `GITHUB_BASIC_GATE_LUA`'s base64-decode-and-compare-password),
with every `request_handle:respond({[":status"] = "403"}, ...)` call removed
and replaced as follows. **First, unconditionally**, every pre-filter removes
any inbound `x-configamatron-no-auth` header before doing anything else — the
marker is a proxy-internal control signal for the post-filter and must never
be something the client can forge or accidentally collide with; a client
request that happens to carry that header name alongside a non-matching
`Authorization` must not cause the post-filter to later strip it. Then:

- **Matches the placeholder predicate** → remove the `Authorization` header.
  This makes it look absent to the injector, which (now `overwrite:false`)
  injects the real credential.
- **Present but does not match** (including any decode failure in the
  GitHub Basic case — malformed base64, missing `Basic ` prefix, etc.) →
  leave the header completely untouched. The injector sees a header already
  present and skips, so the original value reaches the upstream unmodified.
- **Absent entirely** → set `Authorization` to a fixed sentinel value
  (`sandbox-no-credential`) via `headers():replace(...)` (never `add`, to
  guarantee at most one value) and set the marker header
  (`x-configamatron-no-auth: 1`, also via `replace`). This makes the injector
  see "present" and skip, preserving "no credential" as the eventual outcome,
  but leaves an artifact that must be stripped before the request leaves the
  proxy.

The sentinel `Authorization` value and the marker header name are defined
once as shared constants in `src/envoyConfig.ts` and used by all four
pre-filters and the post-filter, so they can't drift independently. The
sentinel value itself has no meaningful content beyond being a valid,
non-empty header value — it exists purely to make the header non-absent for
the injector's benefit — and is never inspected by the post-filter; only the
(now ingress-sanitized) marker header controls cleanup.

**Header-multiplicity note:** "unmodified" here is semantic, based on what
Envoy's header map presents to Lua (which folds duplicate same-name headers).
It is not a guarantee of byte-for-byte wire preservation if a client ever
sent multiple `Authorization` fields — an edge case with no known real
client behavior in this proxy's traffic, called out for completeness rather
than as a requirement to solve.

### Lua post-filter (one shared, generic implementation)

Runs after `credential_injector`, before the router, in all four filter
chains (Claude, Codex, `api.github.com`, `github.com`). Does not need to know
any host's placeholder:

- If the marker header (`x-configamatron-no-auth`) is present, remove both it
  and the `Authorization` header, restoring "no Authorization header at all"
  before the request reaches the router.
- Otherwise, do nothing.

Because this filter is host-agnostic, it is defined once in `src/envoyConfig.ts`
and reused across `buildClaudeEntry`, `buildGithubEntry` (both GitHub
variants), and `buildCodexEntry`, inlined the same way `CODEX_GATE_LUA` and
the GitHub gates already are today. `templates/proxy/gate.lua` keeps living at
its current mounted path (`/etc/envoy/gate.lua`) for the Claude pre-filter —
no new file mount is needed in `templates/proxy/docker-compose.yml`.

Each filter chain's two Lua entries must use distinct configured `name`
fields (e.g. `configamatron.auth_pre` and `configamatron.auth_post`) even
though both use the `envoy.filters.http.lua` extension type — Envoy filter
names double as keys for per-route configuration and stats, so reusing the
bare extension type name for both would make them indistinguishable in
per-route overrides and Lua error logs.

### `credential_injector` changes

All three `overwrite: true` settings in `src/envoyConfig.ts` (Claude, GitHub,
Codex — lines currently at the `buildClaudeEntry`, `buildGithubEntry`, and
`buildCodexEntry` credential_injector blocks) change to `overwrite: false`.

### Diagnostic logging

`gate.lua`'s existing `logInfo` call (added during the investigation to log a
24-char prefix + length of any rejected credential) is removed, not reworded.
Nothing is being rejected anymore, so there is no rejection event to log; this
can be revisited later if passthrough traffic needs its own observability.

## Data flow example

`api.anthropic.com`, three cases:

1. **Normal chat traffic** — VM sends the placeholder. Pre-filter matches,
   removes `Authorization`. Injector (absent → inject) adds the real OAuth
   token. Post-filter sees no marker, does nothing. Upstream gets the real
   credential. (Unchanged from today.)
2. **`/remote-control` session token** — VM sends `Bearer sk-ant-si-<JWT>`.
   Pre-filter: present, doesn't match, leaves it untouched. Injector (present →
   skip) does nothing. Post-filter sees no marker, does nothing. Upstream gets
   the session token unmodified. (Previously a 403; this is the bug fix.)
3. **`downloads.claude.ai`, no auth sent** — pre-filter: absent, sets sentinel
   + marker. Injector (present → skip) does nothing. Post-filter sees the
   marker, strips both the sentinel and `Authorization` entirely. Upstream
   gets no `Authorization` header, same as what the VM originally sent.
   (Previously got the real credential force-added, causing a `401`.)

## Testing

Existing tests asserting reject-on-mismatch flip to asserting pass-through:

- `tests/integration/codexInjection.test.ts`: `'403s a leaked real Bearer that
  is not the placeholder'` becomes an assertion that a non-placeholder Bearer
  reaches the mock upstream unmodified (no injection, no 403).
- `tests/integration/githubInjection.test.ts`: same shift for both the Basic
  and token/Bearer gates.
- `tests/unit/envoyConfig.test.ts`: `expect(injector.overwrite).toBe(true)`
  becomes `false` for all three injector configs; add an assertion that each
  authenticated filter chain's `http_filters` list includes the shared
  post-filter after `credential_injector` and before the router.

New coverage:

- **Absent-header case**, for all four host configs: a request with no
  `Authorization` header reaches upstream with no `Authorization` header — not
  the real credential, and not the sentinel/marker either.
- **Sentinel-leak check**: explicit assertion that the mock upstream never
  sees `x-configamatron-no-auth` or the sentinel `Authorization` value under
  any code path (match, mismatch, or absent).
- **Present-and-matches** (existing happy-path tests should still pass
  as-is): placeholder in, real credential out — confirming `overwrite:false` +
  clear-on-match still triggers injection correctly.
- **Marker-spoofing adversarial cases**: a request that already carries
  `x-configamatron-no-auth` alongside (a) a non-matching `Authorization` and
  (b) the placeholder — in both cases the client's marker must be stripped by
  the pre-filter and must not affect the outcome (case (a) still passes the
  original credential through untouched; case (b) still injects normally).
- **GitHub Basic edge cases**: malformed base64, missing `Basic ` prefix, and
  wrong scheme/case (e.g. `bearer` vs `Bearer`) all fall through to
  "present but does not match" — pass through untouched, no crash.
- **Non-auth headers unaffected**: spot-check that unrelated request headers
  are unchanged across all branches (pre/post filters only ever touch
  `Authorization` and the marker header).
- **Rendered-config assertions**: for each of the three builders
  (`buildClaudeEntry`, `buildGithubEntry` — both GitHub variants —,
  `buildCodexEntry`), assert `overwrite: false` on the generated
  `credential_injector` config and the presence of both Lua filters, by
  distinct name, in the correct order in `http_filters`.
