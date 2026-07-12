# Streaming responses cut mid-flight by Envoy's default 15s route timeout

**Date:** 2026-07-12
**Status:** Root cause confirmed; fix applied (see "Fix applied" below)

## Symptom

Running `claude` inside the isolated VM authenticates fine and works for a
while, then starts failing with:

    API Error: Connection closed mid-response.

The failures get **more frequent as a session carries on**. The proxy access
log shows the traffic taking the TLS-terminate path (`CFGM|term|…`,
`ALLOW CRED`) — i.e. it is reaching Envoy and being credential-injected, not
being blocked.

## Why this is a *new* finding

We already have `docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt`,
which documents a different cause of dropped connections: the **restart/warmup
race** during a container swap (curl exit 35 on a new connection, exit 56 on an
in-flight one — the latter is literally a stream "cut mid-response" when the old
container is killed). That race is tied to a *swap* (credential rotation or
allowlist edit) and was addressed by the blue-green architecture
(`docs/superpowers/specs/2026-07-11-run-proxy-blue-green-zero-downtime-restart-design.md`).

Today's finding is a **second, independent cause** that has nothing to do with
swaps and fires in steady state, which is why it dominates the "as the session
carries on" symptom:

> Envoy's per-route `timeout` defaults to **15 seconds**, and that timeout caps
> the **entire upstream response**, including a streaming body. The Anthropic API
> is a long-lived SSE stream. Any single response that takes longer than 15s to
> finish streaming is severed by Envoy — the client has already received `200` +
> headers, so it sees the bytes stop partway through: "Connection closed
> mid-response."

This was never documented because the earlier investigation was scoped to the
swap window and never measured a no-swap, long-response case.

### Why it worsens over a session

- Early turns: short prompts → responses finish streaming well under 15s → fine.
- Later turns: context grows → time-to-first-token and total streaming time both
  climb → responses cross 15s → the route timeout starts guillotining them.

### Evidence

- `src/envoyConfig.ts` (`buildTerminateEntry`) generated the terminate route with
  **no `timeout` field**, and a repo-wide search found no `timeout` /
  `stream_idle_timeout` / `idle_timeout` anywhere in the generated config — so
  every timeout fell back to the Envoy default. Image is
  `envoyproxy/envoy:v1.31-latest` (`templates/proxy/docker-compose.yml`), whose
  `RouteAction.timeout` default is 15s and applies to the whole response.
- The symptom ("headers received, then bytes stop") is exactly what a route
  timeout does to an in-flight streaming response (it cannot send a clean 5xx once
  headers are already on the wire).

## The fix

Disable the per-route timeout on the terminate route only:

```yaml
route:
  cluster: cluster_terminate_api_anthropic_com
  timeout: 0s      # was: absent → Envoy default 15s
```

`0s` disables the overall-response cap. We deliberately do **not** touch
`stream_idle_timeout` (see next section) — its 5-minute default still reaps
genuinely dead streams.

This only affects the TLS-terminate HTTP routes. The passthrough `:443` path is a
TCP proxy with no HTTP route timeout, and the `:80` path is not used for the
streaming API.

### Why not a shorter `stream_idle_timeout`?

It's the wrong knob, and Anthropic's keepalives are exactly why:

- `stream_idle_timeout` measures the gap *between bytes on an active stream*.
  Anthropic sends periodic SSE `ping` events specifically to keep long streams
  alive, and each ping resets that timer — so a shorter value would not reliably
  fire on a live-but-slow stream, and a value short enough to matter would start
  cutting **legitimate** slow streams (a new bug).
- It also does nothing for the swap-drain problem below: drain force-closes whole
  TCP connections regardless of stream idleness, and the persistent keep-alive
  connection *between* requests is governed by the connection-level `idle_timeout`
  (1h default), not `stream_idle_timeout`.

### Why not fix it client-side (Claude CLI)?

Wrong layer. The cut happens inside Envoy before the client can do anything but
retry a half-consumed stream, which is messy. Client-side retry is a useful
*backstop* for the residual swap cuts (below), not a fix for the route timeout.

## Interaction with blue-green switching

This was the main worry when applying the fix: does removing the route timeout
conflict with the red-green drain, which force-closes the old color's connections
30s after a swap (`gateway.ts` `drain`, drain timeout 30s)?

**No — it's compatible, and slightly kinder.** The two mechanisms live at
different layers:

- Route `timeout` — per-HTTP-stream, inside each color's Envoy, fires in steady
  state (no swap).
- Drain force-close (30s) — raw TCP, in the host gateway, blind to HTTP/streams,
  fires only at a swap.

For a long stream living on the old color's persistent connection during a drain:

- **Before (15s route timeout):** the stream is guillotined at 15s regardless.
- **After (`timeout: 0s`):** the stream runs and is cut only if it is still going
  at the 30s drain deadline.

So disabling the route timeout gives in-flight streams *more* grace during a swap
(up to 30s instead of 15s), never less.

## What we confirmed about the residual swap cut (and did NOT re-open)

Credential rotation triggers a full swap — `runProxyLoop.ts` sets
`restartNeeded = true` on `credentials changed`, and the blue-green design
(`…run-proxy-blue-green-zero-downtime-restart-design.md`) records that this is
mandatory here, because:

- **File-based SDS hot-reload does not work on this platform.** inotify does not
  cross Docker Desktop's Windows bind mount, so Envoy's `watched_directory` never
  re-reads the secret (`sds.update_attempt: 1`, token never changed). The
  `watched_directory` in `envoyConfig.ts` is therefore vestigial for hot-reload;
  the container recreate is the *only* thing that applies a rotated token (Envoy
  reads config + secret once, at process start).
- **REST SDS hot-reload works but was rejected** — it would require run-proxy to
  serve the raw bearer token on a container-reachable port, the exact
  token-exposure this proxy exists to prevent.
- **Full dynamic xDS** was rejected as too large a rewrite.

So the ~hourly credential-rotation swap, and its 30s drain force-cut of any
still-open stream, is a **deliberately accepted soft edge** ("Zero-downtime for
*existing* connections during a swap" is an explicit non-goal of the blue-green
design). The route-timeout fix does not remove it, but it is a separate, rarer
event than the steady-state 15s cut this fix targets. After the fix, the SDK's
own reconnect-onto-the-new-color retry is what covers it.

## Future improvement (only if the residual cut still bites): graceful Envoy drain

If, after the route fix ships, the ~hourly credential-rotation cut still surfaces
as user-visible "Connection closed mid-response", there is one incremental
improvement that fits the existing architecture and adds **no** token-exposure
surface:

At flip time, instead of leaving the old color's connections to sit until the 30s
hard TCP cut, have run-proxy call the **old color's Envoy admin** with a graceful
drain — `POST /drain_listeners?graceful` (or `/healthcheck/fail`). Envoy then
sends `Connection: close` / HTTP-2 `GOAWAY`, so the client finishes its current
request cleanly and opens a new connection (→ the new color) for the next one.
This turns "hard cut at 30s" into "clean handoff, with the 30s cut only as a
backstop for genuinely stuck streams."

run-proxy already knows each color's admin port (it health-gates on it via
`waitColorReady`), so the wiring is small. **Verify the graceful-drain behavior
against `envoyproxy/envoy:v1.31` before committing** — it has not been tested on
this image, and file-SDS is a cautionary tale about assuming documented Envoy
features work under this Docker Desktop / WSL setup.

## Applying the fix to a running proxy

Because Envoy reads its config once at process start, editing `envoyConfig.ts` and
rebuilding does **not** change the already-running proxy. The new `timeout: 0s`
takes effect on the next container start — i.e. the next credential rotation or
allowlist edit (which each bring up a fresh color), or immediately if you restart
`run-proxy`. Restart `run-proxy` to apply it now rather than waiting for the next
swap.

## References

- `docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt` — the swap
  window race (exit-35 / exit-56); the other, swap-tied cause of dropped
  connections.
- `docs/superpowers/specs/2026-07-11-run-proxy-blue-green-zero-downtime-restart-design.md`
  — blue-green rationale, the SDS hot-reload findings, and the accepted
  existing-connection soft edge.
- `docs/superpowers/specs/2026-07-10-run-proxy-merge-config-and-logging-design.md`
  — "write secret → recreate" on credential change.
- `src/envoyConfig.ts` (`buildTerminateEntry`) — where `timeout: 0s` was added.
- `tests/unit/envoyConfig.test.ts` — asserts the terminate route carries
  `timeout: '0s'`.
