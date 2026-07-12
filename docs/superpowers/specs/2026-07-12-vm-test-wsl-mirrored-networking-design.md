# VM e2e suite under WSL mirrored networking — design

**Date:** 2026-07-12
**Status:** approved
**Scope:** `pnpm test:vm` only (tests/vm/, technical-notes.md). No changes to run-proxy or the gateway.

## Problem

The blue-green redesign (2026-07-11 plan) moved run-proxy's public listener from a
Docker-published container port to a plain Node.js TCP server on Windows loopback
(`src/runProxy/gateway.ts`). The WSL-hosted VM test harness previously reached the proxy
because Docker Desktop's WSL integration republishes Docker-published ports inside WSL;
a plain Windows process bound to 127.0.0.1 gets no such bridging, so under WSL NAT
networking the harness could no longer reach the gateway at all.

Switching WSL to **mirrored** networking mode fixes reachability (WSL shares the Windows
localhost), and mirrored mode is the machine's chosen state going forward — it is the
newer, Microsoft-recommended mode. But mirrored mode also pools WSL's ports with
Windows', which broke the harness one step later:

- dnsmasq (tests/vm/harness/net.sh) must bind UDP **0.0.0.0:67** to serve DHCP.
  The wildcard bind is not configurable away: DHCP server port 67 is fixed by RFC 2131
  (the guest's systemd-networkd client has no nonstandard-port option, and the suite
  exists to imitate a stock VM on a VMware NAT/host-only adapter), and dnsmasq's
  `bind-interfaces` scopes only its DNS sockets — DHCP needs the wildcard to receive
  broadcasts.
- Windows already holds **172.29.0.1:67** (dynamic address; was 172.25.64.1 in an
  earlier session): the ICS/SharedAccess DHCP helper for Hyper-V's built-in
  **Default Switch**. This is stock Windows plumbing present on effectively every
  Hyper-V/WSL machine and restarted by Windows on demand — the conflict reproduces
  anywhere, and stopping the service is not viable.

Result: `dnsmasq: failed to bind DHCP server socket: Address already in use`.

## Decision

Keep mirrored mode and exempt the conflicting port(s) from mirrored port sharing via
WSL's `.wslconfig` `ignoredPorts` setting, with the requirement made self-announcing by
preflight guards in vm.test.ts. Implementation is spike-first: every claim about which
binds conflict is demonstrated on the machine before test code changes.

## Design

### Machine configuration

`%USERPROFILE%\.wslconfig` gains, under `[experimental]`:

```ini
[experimental]
ignoredPorts=67
```

taking effect after `wsl --shutdown`. Ports listed there are excluded from mirrored-mode
port sharing: Linux can bind them even though Windows uses them; the Windows side is
untouched (ICS keeps its copy of port 67). The exact list is an open parameter the spike
settles — 80/443/53 join it only if demonstrated necessary.

### Spike-first implementation order

Step one, before any test-code change: set the config and walk the harness's actual bind
sequence under mirrored mode, demonstrating each claim:

1. dnsmasq DHCP — wildcard UDP 67 (the known failure; must succeed after the config).
2. socat forwarders — TCP `10.213.87.1:80` and `:443` (possible collision with Windows
   wildcard listeners such as http.sys on 0.0.0.0:80).
3. dnsmasq DNS in gateway mode — `10.213.87.1:53` (interface-scoped; expected fine).
4. Guest egress through MASQUERADE (mirrored-mode routed traffic is the least-charted
   territory), then a full `pnpm test:vm` run.

**Fallback:** if the spike surfaces a failure `ignoredPorts` cannot cover — most
plausibly guest egress itself misbehaving under mirrored routing — stop and switch to
the rejected-for-now network-namespace approach (below) rather than patching around it.

### Preflight guards in vm.test.ts beforeAll

Two new checks alongside the existing Envoy-reachability guard, both failing fast with
actionable messages naming the exact fix:

1. **Networking mode:** `wslinfo --networking-mode` must report `mirrored`; the error
   names the `.wslconfig` line to change.
2. **Port-67 probe:** attempt a wildcard UDP-67 bind inside WSL as root (a `python3`
   one-liner). On failure the error states the `[experimental] ignoredPorts=67` fix and
   the `wsl --shutdown` step. Probing beats parsing `.wslconfig`: it also catches the
   setting being present but not yet applied, or dropped by a future WSL update — the
   "experimental" risk of `ignoredPorts` lands here, loudly, instead of as a cryptic
   dnsmasq failure twenty minutes into a run.

If the spike grows the `ignoredPorts` list, the probe list grows to match.

### Documentation and comment hygiene

- The one-time-setup paragraph in `technical-notes.md` gains the mirrored-mode and
  `ignoredPorts` requirements.
- The stale comment at `vm.test.ts:20-22` (reachability explained via Docker Desktop
  port republishing, a mechanism the blue-green redesign removed) is rewritten to
  describe the mirrored-mode reality. `CFGM_VMTEST_ENVOY_HOST` remains as the escape
  hatch for pointing at a non-default address.

## Alternatives considered

- **Network namespace inside WSL** — move bridge, taps, QEMU, dnsmasq, and forwarders
  into a private netns with its own port pool (mirrored sharing applies to the init
  namespace). Most robust against any future Windows port-squatting and needs no machine
  config, but every harness script grows `ip netns exec` plumbing and guest egress needs
  a veth hop plus double NAT. Held as the fallback if the spike defeats `ignoredPorts`.
- **Static guest IPs via cloud-init (no DHCP)** — rejected: the suite deliberately
  exercises DHCP semantics (the `proto dhcp` route assertion, gateway-vs-host-only lease
  shapes, S3's no-default-route boot). Static IPs would stop testing the thing the suite
  is for.
- **Stop the ICS/SharedAccess service** — rejected: it is Hyper-V Default Switch
  plumbing, restarted by Windows on demand; stopping it breaks unrelated OS features.
- **Return WSL to NAT mode and expose the gateway on the WSL-facing adapter** —
  workable (the harness is proven under NAT) but declined: the machine is staying on
  mirrored mode by choice.

## Verification

Done means:

- `pnpm test:vm` fully green under mirrored networking.
- Each guard demonstrated to fire: the mode guard checked against a non-mirrored report,
  and the port guard shown failing in the pre-`ignoredPorts` machine state (the spike
  passes through that state for free, before applying the fix).
