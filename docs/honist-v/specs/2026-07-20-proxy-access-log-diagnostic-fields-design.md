# Proxy access log diagnostic fields

Date: 2026-07-20

## Problem

`/remote-control` (run from inside the VM) wasn't working. The only trace on
the host was the proxy's friendly log line:

```
22:45:35  ALLOW CRED  downloads.claude.ai
```

That line only confirms Envoy matched the SNI, terminated TLS, and injected
the real Claude credential — it does not confirm the request to
`downloads.claude.ai` actually succeeded. Pulling the raw Envoy access log
confirmed this: filtered for `downloads.claude.ai`, both hits looked like

```
CFGM|term|2026-07-20T22:45:35|downloads.claude.ai|downloads.claude.ai|via_upstream
CFGM|term|2026-07-20T22:45:37|downloads.claude.ai|downloads.claude.ai|via_upstream
```

`via_upstream` (`%RESPONSE_CODE_DETAILS%`) only means "a response came back
from upstream" — it's identical whether that response was a 200 or a 403.
There was no way, from the logs, to tell whether `/remote-control`'s request
actually succeeded.

## Goal

Make the raw Envoy access log (read via `docker compose logs envoy` on the
host, or through `run-proxy`'s underlying log stream) distinguish "the proxy
let this request through" from "the request actually succeeded" — without
changing `run-proxy`'s friendly `ALLOW CRED` / `ALLOW PASS` / `BLOCK …`
terminal output, which stays exactly as it is today.

## Scope

**In scope:** the raw `CFGM|` access log line format for the four path IDs
that share `accessLog()` in `src/envoyConfig.ts` — `term`, `pass`, `http`,
`deny443`.

**Out of scope:**

- The `#pragma auth candidate` (`cand`) path and its `authCandidateAccessLog()`
  format. That is a separate, more sensitive feature with its own carefully
  calibrated truncation design (see
  `docs/superpowers/specs/2026-07-18-allowlist-pragma-auth-candidate-design.md`);
  this change doesn't touch it.
- `src/runProxy/classify.ts`, `src/runProxy/formatOutput.ts`,
  `src/runProxy/runProxyLoop.ts` — the parsed `Entry` type and the printed
  `HH:MM:SS  TAG  domain` line are unchanged. The new fields are visible by
  reading the raw docker log, not through `run-proxy`'s friendly stream.
- Logging any part of the `Authorization` header on `term`/`pass` paths. See
  "Rejected: logging auth header info" below.

## Change 1 — `src/envoyConfig.ts`: extend `accessLog(pathId)`

Append four fields to the existing format string:

```
CFGM|${pathId}|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%
```

- **`%RESPONSE_CODE%`** — the actual HTTP status Envoy returned to the VM
  (200, 403, 404, 500, ...). This is the field that was completely absent
  before, and the main answer to "did it succeed."
- **`%RESPONSE_FLAGS%`** — Envoy's short failure codes (`UF` upstream
  connection failure, `UT` upstream timeout, `UC` upstream connection
  termination, etc. — `-` when none apply). Needed because
  `%RESPONSE_CODE_DETAILS%` only reads `via_upstream` when a response came
  back at all; if the connection to the upstream host fails outright (refused,
  reset, timed out) there is no response code, and flags is the only field
  that says why.
- **`%DURATION%`** — total request duration in milliseconds. Surfaces
  hangs/timeouts.
- **`%BYTES_SENT%`** — body bytes Envoy sent **to the downstream client**
  (the VM), i.e. how much of the response the VM actually received. Catches
  the case where headers arrived (a 200 gets logged) but the body was cut
  short — the same failure family already documented in
  `docs/investigations/2026-07-12-streaming-response-cut-by-envoy-route-timeout.md`,
  and a plausible cause for `/remote-control` if it's fetching a large
  binary/installer. (Not `%BYTES_RECEIVED%`, which is bytes received *from*
  the downstream client's request — irrelevant for a GET.)

`accessLog()` is the one function shared by `term`, `pass`, `http`, and
`deny443`, so this applies uniformly across all four call sites with no
branching, matching the existing structure.

## Change 2 — `src/runProxy/parseLine.ts`: parse the new fields

- `AccessLine` gains four new optional fields: `responseCode`,
  `responseFlags`, `duration`, `bytesSent` — populated for the four
  non-`cand` path IDs (mirrors how `authHeaders` is optional and only
  populated for `cand`).
- `expectedFields` for non-`cand` lines changes from `6` to `10` to match the
  new format. Lines with the wrong field count still return `null`
  (malformed/truncated lines are dropped), same behavior as today, just
  against the new count.
- `cand` lines are unaffected (`expectedFields` stays `11` for them).

## Rejected: logging auth header info

Considered logging a truncated prefix of the `Authorization` header on
`term`/`pass` paths, the same way the `cand` path already does (12-char
prefix). Rejected because it's not the same situation:

- `cand` hosts have no credential injection — Envoy passes the client's own
  headers through untouched, so whatever gets logged there was never a
  secret Envoy manages.
- `term`/`pass` hosts go through `envoy.filters.http.credential_injector`,
  which overwrites `Authorization` with the real, live Claude credential
  before forwarding upstream. Envoy's access log captures headers as they
  exist at the end of the filter chain, so logging `%REQ(AUTHORIZATION)%` (or
  any truncation of it) on these paths would leak fragments of the real
  production token into `docker compose logs` — directly contradicting the
  existing invariant in
  `docs/superpowers/specs/2026-07-06-proxy-logging-design.md`: *"never the
  `Authorization` header. No injected token can leak into logs."*
- `%RESPONSE_CODE%` already answers the practical question this would have
  been used for: a 401/403 from the upstream is a strong signal the
  credential was rejected, without opening any new leak surface.

## Testing

- `tests/unit/envoyConfig.test.ts` — assert the extended format string is
  present for `term`, `pass`, `http`, and `deny443`, and that `cand`'s format
  is unchanged.
- `tests/unit/runProxy/parseLine.test.ts` — a 10-field non-`cand` line parses
  with the four new fields populated; a line with the old 6-field shape (or
  any other wrong count) still returns `null`; `cand` parsing is unaffected.
- `tests/integration/proxy.test.ts` — check whether any existing assertion
  pins the exact old field count/shape of a `CFGM|` line from the real Envoy
  stack; update it to the new shape if so.

## Rollout

Same as the original logging feature: this changes `envoy.yaml` output only
(new access-log fields, no structural/filter-chain change). Existing
environments pick it up by re-running `configamatron build-envoy-config` (or
just restarting `run-proxy`, which rebuilds the config) — no VM-side changes
needed.
