# Design: Zero-downtime proxy restarts via blue-green container swap

**Date:** 2026-07-11
**Status:** Approved (design)

## Summary

`run-proxy` currently applies every change — a credential rotation or an
`allowlist.txt` edit — by force-recreating its single Envoy container in place.
During that swap the old container keeps answering `/ready`=200 until the instant
it is destroyed, so any request that lands in the swap window has its TLS
handshake dropped (curl exit 35; see
`docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt`). The test harness
was hardened against this, but the production `run-proxy` was not: a real
sandboxed workload hitting the proxy mid-swap would still fail.

This design makes restarts **zero-downtime for new connections** by turning
`run-proxy` into a stable front door that swaps between two Envoy containers
(blue/green). A change brings up the idle color fresh, health-gates it on its own
admin port, atomically flips a forwarder to it, then drains and stops the old
color. Credential rotations (frequent, automatic, not schedulable) and allowlist
edits (rare, schedulable) both go through the same swap, so neither drops a new
connection.

Motivating goals:

1. A credential rotation must never fail an in-flight or newly-arriving request.
2. The exit-35 "handshake into the swap window" failure must be impossible from a
   real workload, not just gated around in the test harness.
3. No new network surface that exposes the bearer token (this is why we swap
   containers rather than hot-reload the token from a run-proxy-hosted SDS server
   — see "Alternatives considered").

## Motivation / background

Two empirical findings from this design session shaped the approach (both
reproduced with throwaway probes against the real `envoyproxy/envoy:v1.31`
image on this Docker Desktop / Windows host):

- **File-based SDS hot-reload does not work here.** Envoy's `watched_directory`
  never re-reads the secret file — `sds.<name>.update_attempt: 1` after both an
  atomic `mv` and an in-place overwrite; the injected token stayed at its startup
  value. inotify does not cross Docker Desktop's bind mount on Windows. So the
  simplest "just hot-reload the token, never restart" path is impossible on this
  platform, and fixing `writeSecret` to rename atomically would not help.
- **REST SDS (Envoy polling run-proxy over HTTP) does work** (`update_success`
  incremented, token flipped in ~1s). It was rejected on security grounds, not
  capability grounds: it requires run-proxy to serve the raw bearer token on a
  port the container can reach, and the entire purpose of this proxy is that the
  sandbox never holds that token. Blue-green keeps the token in a
  per-container file and adds no such endpoint.

The core architectural constraint: two containers cannot both bind
`127.0.0.1:443` on the host. Zero-downtime therefore requires an indirection —
a stable front that clients always hit, forwarding to whichever container is
live. `run-proxy` already owns exactly that primitive in `forwarder.ts`.

## Non-goals

- **Zero-downtime for *existing* connections during a swap.** New connections
  never fail. Connections already open on the old color are drained for up to a
  timeout, then cut. This is the accepted soft edge for a rare-ish event.
- **Changing `envoyConfig.ts` / the Envoy config itself.** Each color runs an
  identical Envoy internally on 443/80/9901. The only difference between colors
  is the *host-published* ports. No per-color config files.
- **Eliminating the allowlist-edit restart.** Allowlist edits still cause a swap
  (now zero-downtime); we are not moving to dynamic LDS/CDS xDS config.
- **Preserving the `waitForEnvoyRestart` / `getEnvoyContainerId` test helpers.**
  Readiness moves into `run-proxy`, so tests gate on its stdout instead. These
  helpers largely go away.

## Design

### 1. Two-container compose topology

`templates/proxy/docker-compose.yml` gains a second service. `envoy_blue` and
`envoy_green` are identical except for container name and the host ports they
publish (backend HTTPS/HTTP + admin), each driven by env vars `run-proxy` sets at
`up` time. Both mount the same `envoy.yaml`, `ca/`, and `secrets/`.

Sharing one `envoy.yaml` and one secret file across both colors is safe because
**Envoy reads its config and SDS secret once, at process start.** When we bring
up green, it reads whatever is on disk *now* (the new allowlist / new token);
blue, already running, keeps the old config and old token in memory until it is
stopped. There is never a need for per-color config files.

Container-internal ports stay 443/80/9901 for both colors (separate network
namespaces, no conflict). Only the host publish ports differ.

### 2. Dynamic port allocation

At each swap, `run-proxy` picks free loopback ports for the idle color's backend
and admin, and passes them to compose via env before `docker compose up`. This
avoids a new fixed-port CLI surface and any port-conflict between the two colors.
`run-proxy` records the admin port it chose so it can health-gate that color.

Tests continue to hit the stable front (`:443`, or `:18443` under the test
env overrides) and never reference backend ports.

### 3. Gateway forwarder (extends `forwarder.ts`)

The forwarder becomes the always-on stable front and the swap point. It gains:

- **A mutable connect target**, read per incoming connection. A flip changes the
  target so new connections go to the new color; connections already piped to the
  old color are untouched. This *is* the drain mechanism.
- **Connection tracking per color**, so drain can wait for the old color's active
  count to reach zero.

Listeners:

- **Loopback `:443`/`:80` — always on** (both production and `--no-forward`/test
  mode). This is the stable address the VMnet bridge and the tests hit.
- **VMnet-adapter `:443`/`:80` — production only**, unchanged from today except it
  now targets the active color. In practice the existing VMnet bridge can keep
  targeting loopback:443 (the front), or target the color directly; either way
  the color-switch logic lives in exactly one place.

Because the container no longer publishes 443/80 on the host, `127.0.0.1:443/:80`
is free for `run-proxy`'s forwarder to bind. `127.0.0.1:443` and
`VMnetIP:443` are distinct bind addresses and coexist.

### 4. Swap sequence

When `drainRestarts` determines a change needs a new container (allowlist edit or
credential rotation):

1. Write the new `envoy.yaml` and/or secret to disk (as today).
2. Choose the **idle** color; pick free ports for it; `docker compose up -d
   --force-recreate envoy_<idle>`.
3. **Ready-gate:** wait until the idle color's *own* admin port answers
   `/ready`=200. This is a fresh, separate container — its admin only reports
   ready when it is genuinely serving, so unlike the in-place-recreate case there
   is no window where `/ready` reflects a stale container.
4. **Flip** the forwarder's target to the idle color. It is now active; new
   connections go to it.
5. **Drain** the old color: it already receives no new connections; wait for its
   tracked connection count to reach 0 or the drain timeout, then
   `docker compose stop envoy_<old>`.
6. Re-point the access-log stream at the new active color.

Startup is the same minus the drain: bring up blue, ready-gate it, start the
forwarder targeting blue, log "serving".

### 5. Readiness ownership

`run-proxy` does not log "serving" (startup) or "swap complete" (restart) until
the new color is ready **and** flipped. Integration and VM tests gate on these
stdout lines instead of poking docker `ps -q` / the admin port directly. This is
what lets the harness drop `waitForEnvoyRestart` / `getEnvoyContainerId`.

## Failure handling & decisions

- **Green fails to become ready → abort the swap, keep blue serving, log the
  failure loudly, tear down the failed green.** Strictly more robust than today's
  fatal-on-recreate-failure: the proxy keeps working on the old config, and the
  operator sees the error. Safe for credentials because the old token is still
  valid during the rotation overlap.
- **Drain timeout — default 30s, configurable.** Long passthrough tunnels / large
  in-flight downloads on the old color get up to the timeout to finish; on timeout
  the old color is force-stopped, cutting whatever remains. New connections are
  never affected — that is the zero-downtime guarantee. Cutting *old* connections
  at the timeout during a swap is the accepted soft edge (non-goal above).
- **Two compose services, not raw `docker run`** — stays close to the existing
  `composeDir` / `ps -q` / `compose down` patterns.

## Testing

- **Unit — gateway forwarder:** flipping the target mid-connection keeps existing
  connections on the old target and routes new ones to the new; drain resolves
  when the old color's count hits 0, and force-cuts on timeout.
- **Integration (`runProxy.test.ts`):** swap on an allowlist change and on a
  credential change; assert the new config/token is served, the active color
  alternates blue↔green, and a connection opened *before* the swap still
  completes successfully through the old color.
- **VM e2e (`tests/vm/vm.test.ts`):** the exit-35 regression — a passthrough
  `curl` fired right at a swap must now succeed, because `run-proxy` reports the
  swap complete only after the new color is ready+flipped and the old color has
  drained. Gate the probe on `run-proxy`'s stdout line rather than the admin port.

## Alternatives considered

- **REST SDS hot-reload (no restart, single container).** Verified working, but
  requires run-proxy to serve the raw bearer token on a container-reachable port.
  Rejected: it adds exactly the token-exposure surface this proxy exists to
  prevent, and would need careful bind/firewall isolation from the guest VMnet.
- **File `watched_directory` SDS hot-reload.** Impossible here — inotify does not
  cross the Docker Desktop bind mount (probe: `update_attempt: 1`, token never
  changed).
- **Full dynamic xDS (file-based LDS/CDS/SDS).** True single-container
  zero-downtime with no forwarder swap, but a large, higher-risk rewrite of
  `envoyConfig.ts` (dynamic forward proxy + SNI filters under LDS) for a benefit
  blue-green already delivers.
- **Ready-gate only, accept the blip.** Fixes exit-35 but still drops connections
  on every restart. Credential rotations are automatic and not schedulable, so an
  hourly random blip is unacceptable — this is why zero-downtime was required.
