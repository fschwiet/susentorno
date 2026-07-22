# `/remote-control` fails: Claude Code presents a second, non-placeholder credential that the sandbox gate rejects

**Date:** 2026-07-22

## Background: how the proxy protects the real Claude credential

The sandboxed VM never holds the user's real Anthropic OAuth credential. Its
`~/.claude/.credentials.json` contains a fixed placeholder access token,
`sk-ant-oat-SANDBOX-PLACEHOLDER` (sent as `Authorization: Bearer
sk-ant-oat-SANDBOX-PLACEHOLDER`). The host-side proxy (Envoy) terminates TLS
for `api.anthropic.com` (and several other `*.anthropic.com` /
`*.claude.ai` hosts) and runs two HTTP filters in front of the real upstream:

1. **A Lua "gate" filter** (`templates/proxy/gate.lua`, mounted into the
   Envoy container as `/etc/envoy/gate.lua`): if the request's `Authorization`
   header is present and is not *exactly* equal to the placeholder string, it
   immediately responds `403` with the body `sandbox: unexpected credential`
   and never forwards the request upstream. This exists to catch the sandbox
   somehow acquiring and sending the *real* production credential.
2. **A `credential_injector` filter** (Envoy's
   `envoy.filters.http.credential_injector`, backed by SDS), which runs after
   the gate and unconditionally overwrites the `Authorization` header with the
   real credential before forwarding upstream (`overwrite: true`, so it
   replaces the header regardless of what's currently in it).

Normal Claude Code API/chat traffic sends the placeholder, passes the gate,
gets the real token swapped in by the injector, and succeeds — this is the
steady-state path and was working throughout this investigation (interleaved
`200` responses on `api.anthropic.com` kept appearing the whole time).

## Symptom

Running `/remote-control` from inside the VM's Claude Code session failed
with:

```
Remote Control disconnected · Transport closed: server rejected connection (code 403)
```

## Investigation

### 1. Host proxy logs showed two failing hosts

Filtering the host's `docker compose logs` for Anthropic/Claude domains during
a `/remote-control` attempt showed two distinct failure patterns, interleaved
with successful ordinary traffic:

- `downloads.claude.ai` — every request returned `401` **from the real
  upstream** (`via_upstream|401|-|283|131`: response actually round-tripped in
  283ms with a 131-byte body).
- `api.anthropic.com` — some requests returned `403` **from the proxy itself**
  (`lua_response|403|-|0|30`: zero upstream round-trip, 30-byte body — the
  exact length of the gate's `"sandbox: unexpected credential"` string),
  repeating on a growing retry interval (roughly 1s → 2s → 4s → ... over the
  course of a `/remote-control` attempt) while unrelated `200` chat traffic
  continued to succeed on other connections in between.

This log detail (`%RESPONSE_CODE%`, `%RESPONSE_FLAGS%`, `%DURATION%`,
`%BYTES_SENT%`) is only available on the raw Envoy access log
(`docker compose logs envoy`, `CFGM|term|...` lines), not in the friendlier
`run-proxy` terminal summary (`ALLOW CRED <host>`), which only confirms the
proxy matched and terminated TLS for the host — it does not indicate whether
the request actually succeeded.

### 2. `downloads.claude.ai`: diagnosed with the `#pragma auth candidate` allowlist section

The proxy's allowlist file supports a `#pragma auth candidate` section: hosts
listed there get TLS terminated (so headers are visible) but get **no** gate
check and **no** credential injection — the client's original headers pass
through to the real upstream untouched, and Envoy logs a 12-character prefix
of several auth-related headers (`Authorization`, `Cookie`, `X-Api-Key`,
`X-Auth-Token`, `Proxy-Authorization`) for inspection.

Moving `downloads.claude.ai` from `#pragma claude authenticated` to
`#pragma auth candidate` and retrying `/remote-control` produced:

```
CFGM|cand|...|downloads.claude.ai|downloads.claude.ai|via_upstream|-|-|-|-|-
```

All five tracked header fields were empty (`-`) — the client sends **no**
authentication of any kind on this request. This means the prior `401`s were
not caused by a wrong credential being sent; they were caused by the
credential injector **force-adding** a real `Authorization: Bearer <real
token>` header to a request that was never supposed to carry one, and the
real `downloads.claude.ai` server rejecting the unexpected header.

Note: this diagnostic path does not capture the actual HTTP response code
(only `%RESPONSE_CODE_DETAILS%`, e.g. `via_upstream`), so it wasn't possible
to confirm from logs alone whether the request succeeded once un-injected —
this would need to be confirmed by checking whether `/remote-control` actually
connects.

### 3. `api.anthropic.com`: same technique is unsafe here — it would also break the working parts of `/remote-control`

Moving `api.anthropic.com` to `#pragma auth candidate` would disable
credential injection for **all** traffic to that host, including whatever
initial, correctly-authenticated call `/remote-control` makes to obtain
its own session credential (see below) — so this approach would prevent the
interesting second request from ever being generated at all, and would also
break ordinary chat traffic in that VM for the duration of the test. This
path was not used for `api.anthropic.com`.

### 4. Instrumenting the gate itself instead

Rather than disabling the gate, `templates/proxy/gate.lua` was temporarily
modified to log a truncated prefix of any credential it rejects (via Envoy's
`request_handle:logInfo`, which writes to the Envoy process log, not the
structured access log) before returning its normal `403`. This changes no
behavior for any request — the placeholder-matching path is completely
unaffected, and the rejected request is still blocked exactly as before; it
only adds visibility into the previously-discarded value.

First pass (12-character prefix) logged:

```
sandbox: rejected credential prefix=Bearer sk-an
```

This matched the first 12 characters of the placeholder itself
(`Bearer sk-ant-oat-SANDBOX-PLACEHOLDER`), so it was inconclusive — it could
have been the placeholder failing exact-match for a trivial reason, or a
different real token in the same family.

Second pass (24-character prefix, plus total header length) logged, on three
separate `/remote-control` attempts, an identical result each time:

```
sandbox: rejected credential len=777 prefix=Bearer sk-ant-si-eyJhbGc
```

## Finding

The credential `/remote-control` presents to `api.anthropic.com` is **not**
the sandbox's OAuth access-token placeholder and is not a malformed/leaked
copy of it. It is a distinct, 777-character credential:

- Prefix `sk-ant-si-` — a different token namespace from the OAuth access
  token's `sk-ant-oat-` prefix that the placeholder and injector are built
  around.
- Immediately followed by `eyJhbGc`, the standard base64url opening of a JWT
  (`{"alg":`) — i.e. the token is `sk-ant-si-<JWT>`, a session token, not an
  OAuth access token.
- All three captured instances had the identical length (777) and prefix,
  consistent with the same token being minted once by `/remote-control` and
  then retried repeatedly against `api.anthropic.com`, being rejected by the
  gate every time.

The most likely explanation: `/remote-control` first makes a call to
`api.anthropic.com` using the normal, correctly-injected real OAuth
credential, receives back this `sk-ant-si-` session token, and then uses
*that* token (not the OAuth token) for its actual control-plane/transport
call — which the gate has no concept of and rejects as an "unexpected
credential," producing the `403` visible to the client as `Remote Control
disconnected · Transport closed: server rejected connection (code 403)`.

Separately, and still open: whatever `downloads.claude.ai` is used for during
`/remote-control` appears to expect no `Authorization` header at all, and the
injector currently adds one unconditionally for every host under
`#pragma claude authenticated`, which — independent of the `api.anthropic.com`
issue — was also observed returning `401` before the diagnostic change.

## Evidence retained

- Raw host proxy access log lines (`docker compose logs`), both the
  friendly `run-proxy` summary and the raw `CFGM|term|...` / `CFGM|cand|...`
  lines, for `api.anthropic.com` and `downloads.claude.ai` during multiple
  `/remote-control` attempts.
- Three `gate.lua` `logInfo` captures showing `len=777`,
  `prefix=Bearer sk-ant-si-eyJhbGc` for the rejected `api.anthropic.com`
  credential.
