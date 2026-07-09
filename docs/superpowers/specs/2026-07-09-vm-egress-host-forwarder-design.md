# VM egress host forwarder — design

Date: 2026-07-09

## Problem

On a Windows host running the sandbox VM under VMware (host-only networking) and
Envoy under Docker Desktop, the VM's live-egress checks (`verify-config.sh`) fail
— timeouts, 5–15s TCP connects, intermittent stalls — even though the host's own
checks (`verify-proxy.ps1`) pass fully.

Root cause, confirmed 2026-07-08 by elimination: **Docker Desktop's published-port
relay (the WSL2 backend / `com.docker.backend` proxy) accepts connections
arriving on the VMware host-only interface (VMnet1, e.g. `192.168.241.1`) slowly
and unreliably — delayed/dropped SYN-ACKs — while connections to the same
published ports over loopback (`127.0.0.1`) are instant.**

Evidence (all ruled out as the cause, with measurements):

- MTU/MSS: full 1500-byte frames pass VM→host with the DF bit set; true path-MTU
  is 1500. Lowering MTU only marginally helped a lossy path, never fixed it.
- Wire loss: 0% ICMP loss VM→host on both small and large (1428-byte) packets.
- IPv6 listener, Envoy health, upstream reachability, host CPU/RAM (24 cores,
  idle): all fine.
- Windows host's own non-loopback TCP ingress: a plain Python socket on
  `VMnet1:8099` served 20 MB in ~0.05s, 5/5 runs — so the Windows/VMware TCP path
  is fast; only Docker's relay is slow.
- Validated fix: a userspace TCP forwarder `VMnet1:80/443 → 127.0.0.1:80/443`
  (with Docker publishing Envoy on loopback) gave the VM `conn ~0.0003s`, allow-
  listed `:80` `200` in ~0.3s, and credential-gate `:443` `403` in 0.006s — all
  5/5 fast and reliable.

The VM configuration, DNS stub, routing/DNAT, MTU, and Envoy are all correct.
The defect is entirely on the host, in how Docker Desktop forwards published
ports for connections that arrive on the host-only interface.

## Goal

Route the VM's `:80`/`:443` traffic onto the proven-fast loopback handoff to
Docker, by inserting a native userspace TCP forwarder on the VMnet1 IP that pipes
to `127.0.0.1`, and catch this failure class in the host verifier so it can never
again surface only inside the VM.

## Non-goals

- No changes to Envoy's configuration, allow-list logic, or credential gate.
- No dependency on Windows `netsh portproxy`/IP Helper, nor on WSL2 networking
  internals (see Rejected alternatives).
- No attempt to make the forwarder survive `run-proxy` not running — a working
  proxy already requires `run-proxy` (token freshness).

## Design

### Data flow

```
VM curl → DNAT → <vmnet1-ip>:80/443
                     │  native Windows socket accept (the fast path, measured)
                     ▼
         run-proxy forwarder (Node net.Server on <vmnet1-ip>:80/443)
                     │  pipes bytes both ways, TCP-transparent
                     ▼
              127.0.0.1:80/443  (Docker-published Envoy — loopback, fast)
                     ▼
                   Envoy → upstream
```

The forwarder is byte-transparent TCP with no HTTP/TLS awareness, so it serves
all three Envoy modes identically: `:80` HTTP, `:443` SNI passthrough, and `:443`
terminate (gate.lua). Envoy still terminates/inspects and applies all policy
exactly as today.

### Forwarder module — `src/runProxy/forwarder.ts`

Two units with clear boundaries:

- `resolveForwardListenAddress(adapterName): string | null`
  - Discovers the IPv4 address of the VMware host-only adapter via
    `os.networkInterfaces()`.
  - `adapterName` defaults to `"VMware Network Adapter VMnet1"` — the same
    default used by `host-allow-vm-inbound.ps1`.
  - Returns the non-internal IPv4 address, or `null` if the adapter/address is
    not found.

- `startForwarder({ listenAddress, ports }): Promise<ForwarderHandle>`
  - Starts one `net.Server` per entry in `ports`, each listening on
    `listenAddress:<port>` and piping every accepted connection to
    `127.0.0.1:<samePort>`.
  - Per connection: connect upstream to loopback; pipe both directions; on
    upstream-connect error or either side ending, destroy both sockets. (Mirrors
    the relay validated during debugging.)
  - Resolves once all listeners are bound; rejects if any bind fails.
  - `ForwarderHandle = { close(): Promise<void> }` stops all listeners and
    resolves when closed.

### CLI options on `run-proxy`

- `--forward-listen <ip>` — override the bind address (default: auto-discovery
  via `resolveForwardListenAddress`).
- `--forward-ports <http,https>` — default to the same `ENVOY_HTTP_PORT` /
  `ENVOY_HTTPS_PORT` (80/443) that `docker-compose` publishes, so the forwarder
  and Docker always agree on ports.
- `--no-forward` — disable forwarding entirely (non-Windows hosts, or tests that
  connect over loopback).

### Lifecycle (in `registerRunProxy`, wrapping the existing loop)

1. Unless `--no-forward`, resolve the listen address. If forwarding is enabled
   but no address can be resolved, **fail fast**: print a clear error and exit
   non-zero. Never run silently without forwarding — that reintroduces the bug.
2. Start the forwarder *before* `runProxyLoop`, so a bind failure surfaces before
   container work. Connections that arrive before Envoy is up simply fail; the VM
   does not connect during setup.
3. `await runProxyLoop(...)` unchanged.
4. In a `finally`, `close()` the forwarder. Consistent with today's behavior
   (Ctrl-C leaves the container running): the container persists, but the VM path
   requires `run-proxy` to be running — which it must be for token freshness.

The forwarder is started/stopped in the command wrapper, not inside
`runProxyLoop`, so the loop's credential/token logic and its unit tests stay
focused and unchanged.

### docker-compose.yml — publish loopback-only

```yaml
ports:
  - '127.0.0.1:${ENVOY_HTTPS_PORT:-443}:443'
  - '127.0.0.1:${ENVOY_HTTP_PORT:-80}:80'
  - '127.0.0.1:${ENVOY_ADMIN_PORT:-9901}:9901'
```

This frees `<vmnet1-ip>:80/443` for the forwarder and forces all traffic through
the fast loopback handoff. The host's existing `--resolve ...:127.0.0.1` checks
still work because Envoy is still published on loopback.

### Firewall

`host-allow-vm-inbound.ps1` is unchanged: it already opens inbound TCP 80/443 on
the VMnet1 adapter, which is where the forwarder now listens.

## Verification

`verify-proxy.ps1` gains a "VM-path" section (it already discovers `$hostIp` =
the VMnet1 IP near the end):

- Assert listeners exist on `<vmnet1-ip>:80` and `<vmnet1-ip>:443`.
- Re-run the allow-listed `:80`, passthrough `:443`, and credential-gate checks
  against `<vmnet1-ip>` (via `--resolve host:port:<vmnet1-ip>`), not just
  `127.0.0.1`. A future relay/forwarder regression then fails the host check
  instead of only surfacing inside the VM.
- Keep the existing loopback checks — they isolate Envoy itself from the
  forwarder.

## Tests

- `forwarder.test.ts` (unit):
  - bytes flow client→target and target→client through `startForwarder` pointed
    at a local mock server on `127.0.0.1`;
  - the client socket is destroyed when the upstream target is down;
  - `close()` releases the listeners (a subsequent bind on the same port
    succeeds).
- `resolveForwardListenAddress` (unit): picks the correct adapter IPv4 from a
  mocked `os.networkInterfaces()`; returns `null` when the adapter is absent.
- Existing `runProxy` tests: assert the forwarder is started and stopped around
  the loop, and that `--no-forward` skips it.
- The VM e2e harness (`tests/vm`) runs with real DNAT unchanged; on non-Windows
  CI it uses `--no-forward` / `--forward-listen` as appropriate.

## Docs

Brief note in `usage.md` / `technical-notes.md`: the VM reaches Envoy through
`run-proxy`'s forwarder into loopback, and why (Docker Desktop's external-
interface published-port relay is slow/unreliable from the host-only interface).

## Rejected alternatives

- **`netsh portproxy` in `host-allow-vm-inbound.ps1`** (native, persistent). Adds
  a dependency on Windows `netsh portproxy` and the IP Helper service; its
  reboot-persistence also means a dangling listener pointing at a dead Docker;
  and its performance was not empirically validated (only a userspace forwarder
  was). Persistence buys little because a working proxy already requires
  `run-proxy`.
- **WSL2 mirrored networking** (`networkingMode=mirrored` in `.wslconfig`).
  Couples explicitly to WSL2 and to Docker Desktop's WSL2 backend — a dependency
  that is only transitive today — and is a global, machine-wide change that can't
  be expressed in the repo's per-environment templates.

Both were rejected in favor of the Node forwarder, which adds no new platform
coupling (Node `net` is already in use), is the only option validated fast, and
tests cleanly.

## Risks

- If the VMnet1 IP changes, `--forward-listen`/auto-discovery must pick up the new
  value; fail-fast on an unresolvable address makes this loud rather than silent.
- Forwarding is only up while `run-proxy` runs. Accepted: this rides an existing
  hard dependency rather than adding a new failure axis, and `verify-proxy.ps1`
  now detects a missing forwarder.
