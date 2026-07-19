# Envoy bootstrap-rejection crash-loops read as `State.Running=true` under a Docker restart policy

**Date:** 2026-07-18
**Image:** `envoyproxy/envoy:v1.31-latest`
**Motivation:** Side investigation prompted by the plan
`docs/honist-v/plans/2026-07-18-run-proxy-robustness.md`, which needed a way to
(a) deliberately make an Envoy container fail at startup and (b) detect that
failure from the host via `docker inspect`. Both assumptions turned out to
interact with Docker's restart policy in ways worth recording for anyone
running Envoy under Docker Compose.

## Setup under test

- Envoy launched by Docker Compose with `restart: unless-stopped` on the
  service.
- Envoy's bootstrap `admin.address.socket_address.port_value` was mutated to
  force specific startup outcomes; everything else in the bootstrap was a valid,
  working config.
- Container observed with
  `docker inspect --format '{{.State.Running}} {{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}'`
  sampled once per second.

## What was tested and observed

### 1. Admin `port_value: 70000` — rejected at bootstrap, container exits

Envoy validates the admin socket port against the proto constraint and refuses
to start:

```
[critical][main][source/server/server.cc:412] error initializing config
'/etc/envoy/envoy.yaml': Proto constraint validation failed
(BootstrapValidationError.Admin: ... | caused by
SocketAddressValidationError.PortValue: value must be less than or equal to 65535)
[info][main][source/server/server.cc:1038] exiting
```

The Envoy process exits non-zero before binding any listener. This is a
reliable way to make Envoy fail fast on a bad bootstrap: pick a `port_value`
greater than 65535 (the field is a `uint32`, so it parses, but PGV validation
rejects it). Other malformed bootstrap values that fail proto validation would
behave the same way.

Note: the value must exceed the *validated* range. Values that merely look
"wrong" but are in range do not crash. `port_value` is not silently clamped —
it is validated — so `70000` is rejected outright rather than wrapped to a
16-bit port.

### 2. Admin `address: 192.0.2.1` (unroutable) — bind failure, container exits

A syntactically valid but unbindable admin address passes proto validation and
fails later, at bind time:

```
[critical][main][source/server/server.cc:412] error initializing config
'/etc/envoy/envoy.yaml': cannot bind '192.0.2.1:9901': Cannot assign requested address
[info][main][source/server/server.cc:1038] exiting
```

Also a reliable startup failure, but it happens later in startup (after more
initialization) than the proto-validation rejection in case 1.

### 3. Admin port moved off the mapped container port — Envoy stays healthy

Setting the admin `port_value` to a port that Envoy *can* bind but that is not
the one the host publishes (e.g. binding admin to `9902` inside the container
while Compose only maps container `9901`) produces a fully healthy Envoy that
never exits. `RestartCount` stays `0`. From the host, a probe of the mapped
admin port is simply refused forever, because nothing inside the container is
listening on the mapped port. This is a useful way to simulate a "never becomes
ready" container without crashing it.

## The key finding: `restart: unless-stopped` masks the crash from `.State.Running`

With `restart: unless-stopped`, a container whose Envoy keeps failing at startup
(cases 1 and 2) does **not** settle into a dead state — it **crash-loops**, and
Docker restarts it with a growing backoff. Crucially, throughout that loop
`docker inspect` reports:

```
Running=true  Status=running     ExitCode=0  RestartCount=1
Running=true  Status=restarting  ExitCode=1  RestartCount=5
Running=true  Status=restarting  ExitCode=1  RestartCount=6
```

`.State.Running` was `true` in **every** sample over ~8 seconds, including while
`.State.Status` was `restarting` and the last `.State.ExitCode` was `1`. In
other words:

> Under a Docker restart policy, `.State.Running` is **not** a reliable "is this
> container healthy / going to serve" signal. It reads `true` during the restart
> backoff of a crash-loop, so a container that has never once served a request
> can still report `Running=true` indefinitely.

`.State.Status` does flip to `restarting`, but it also briefly returns to
`running` during each crash attempt, so a single `docker inspect` can catch
either value — polling `.State.Status` alone is racy.

## Practical guidance for using Envoy under Docker

- **To force a deterministic Envoy startup failure for testing:** set the admin
  `socket_address.port_value` above 65535 (proto-validation rejection, before
  any bind) or the admin `address` to an unroutable IP (bind failure). The
  former fails earliest.
- **To simulate a container that is up but never ready:** move Envoy's admin
  listener to a port the host does not map, leaving Envoy otherwise valid. The
  container stays up (`RestartCount=0`) and host readiness probes are refused.
- **To detect from the host whether an Envoy container has failed to start,**
  do **not** rely on `.State.Running` when the container runs under a restart
  policy. Two robust alternatives:
  - `.RestartCount > 0` — race-free once the first crash has happened. Under
    `restart: unless-stopped` a healthy Envoy never exits, so any non-zero
    restart count means the container has already died at least once and is
    crash-looping. This is what run-proxy's host-side liveness probe now uses,
    combined with `.State.Status == "running"` for the not-yet-crashed and
    already-exited cases.
  - Removing the restart policy for containers you intend to health-gate
    externally, so a failed start settles into a terminal `exited` state that
    `.State.Running == false` reports honestly. (Not chosen here, because the
    restart policy is wanted for steady-state resilience.)
- **A crash-loop grows its backoff over time.** Early in the loop the container
  spends more time briefly "running"; later, the `restarting` windows dominate.
  Any host-side detector that polls should assume it may observe a transient
  "running" window and should key off a monotonic signal (`RestartCount`) rather
  than an instantaneous one.
