# Investigation: host-side DNS consolidation (Hyper-V)

**Date:** 2026-07-22
**Status:** Deferred — captured for a separate future effort. Not part of the VMware-removal cleanup.

## Summary

Each guest currently runs its own fake DNS responder so that hostname lookups
succeed and traffic reaches the host's Envoy proxy. Now that the project targets
**Hyper-V only** — with a dedicated Internal virtual switch and a stable host IP
on that switch — it may be possible to run a **single fake DNS responder on the
host**, bound to the Internal-switch IP (`<host-ip>:53`), and remove the in-guest
DNS (and possibly the in-guest DNAT/route) layer entirely.

This was originally impossible under VMware: there was no dedicated host adapter
we controlled, and binding `:53` on the host conflicted with an existing
wildcard listener. The Hyper-V Internal switch changes that premise.

## Current architecture (as of this investigation)

The guest's fake DNS answer is *not* used as real routing information — its only
job is to let the client's lookup succeed so it proceeds to connect. The two
guests implement this differently:

- **Ubuntu guest** (`templates/vm-shared/pre-scripts/`):
  - `dnsmasq-stub.conf` answers **every** name with a throwaway placeholder
    (`203.0.113.1`, TEST-NET-3), bound to `127.0.0.1:53`.
  - `60-dns-override.yaml` pins the guest resolver to `127.0.0.1` (with careful
    NetworkManager/networkd DHCP-DNS suppression).
  - `configamatron-egress.service` does the *real* redirect: iptables **DNAT**
    of all outbound tcp/80 and tcp/443 to `<host-ip>` by port, plus a guarded
    host-only **default-route** install at boot.
  - Envoy re-resolves the true hostname from SNI/Host and connects upstream.

- **Windows guest** (`templates/vm-shared-windows/pre-scripts/dns-responder/`):
  - `ConfigamatronDnsResponder` (a small .NET UDP responder, `Program.cs`)
    answers every A query with the **host proxy IP directly** (AAAA →
    NOERROR/no-answer so callers fall back to A). Bound to `127.0.0.1:53`.
  - Because names already resolve to the on-link host IP, the client connects
    straight to `<host-ip>:443` with SNI intact — **no DNAT step**.

So the Windows guest already runs the simpler "resolve everything to the proxy
IP, nothing left to DNAT" model. The Ubuntu guest still uses the older
placeholder-plus-DNAT model. The two have diverged.

## Proposed consolidation

Run one fake DNS responder **on the host**, bound to the Internal-switch adapter
IP (`<host-ip>:53`), answering all A queries with `<host-ip>` (the "Windows
model"). Point each guest's resolver at `<host-ip>` via its static network
config.

Consequences:

- **Ubuntu:** drop `dnsmasq` (install + `dnsmasq-stub.conf`), drop the
  `configamatron-egress.service` DNAT rules, and drop the guarded default-route
  hack. Every name resolves to an on-link host IP, so the client connects
  directly to the proxy with SNI intact — exactly what Windows does today.
  `60-dns-override.yaml` collapses to "set nameserver = host IP" (or is folded
  into the static-IP netplan the Hyper-V setup already writes).
- **Windows:** stop shipping/running `ConfigamatronDnsResponder` in-guest.
- **Both guests** reduce to roughly: **static IP + `nameserver = <host-ip>` +
  trust the proxy CA.** The entire in-guest DNS/DNAT/route layer disappears.
- **Host / `run-proxy`:** gains responsibility for supervising a `:53` responder
  bound to the Internal-switch IP, alongside the existing TCP forwarder it
  already runs (`src/runProxy/`). The existing `ConfigamatronDnsResponder` code
  is a natural starting point (it already answers all-A → configured IP), or a
  small Node responder could live next to the forwarder.

Why Hyper-V makes this viable: the Internal switch is a dedicated adapter we
create, with a stable host IP and **no competing DHCP** on it. That gives a
specific `<host-ip>:53` bind target we control — which VMware's host-only setup
did not.

## Key unverified risk — must validate on the HOST first

**Can the host bind `<host-ip>:53` while another process holds wildcard
`0.0.0.0:53`?** On Windows, a specific-IP UDP bind *usually* coexists with a
wildcard bind on the same port, but this was **not** verified on the host during
this investigation.

Note on the misleading probe: a `Get-NetUDPEndpoint -LocalPort 53` run during
this investigation showed `ConfigamatronDnsResponder` on `127.0.0.1:53`
coexisting with `svchost` on `0.0.0.0:53` — but that probe was run **inside the
isolated guest**, not on the host. It reflects the guest's port-53 world and
says nothing about the host. The real Hyper-V host is on the other side of the
isolation boundary and could not be probed from the guest.

The likely wildcard `:53` holder on the host is the **Hyper-V Default Switch /
ICS DNS proxy** — the same component that holds `:67` (DHCP) and forced the WSL
test-harness `ignoredPorts=67` workaround (see `technical-notes.md` and
`docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md`).

**To validate on the host** (Administrator PowerShell on the Hyper-V host, with
the Internal switch created and its host IP assigned):

```powershell
# What holds :53 today, and on which addresses?
Get-NetUDPEndpoint -LocalPort 53 | Select LocalAddress,LocalPort,OwningProcess
# Then attempt a specific-IP bind to <host-ip>:53 (e.g. a throwaway UDP listener)
# and confirm it succeeds alongside any wildcard holder.
```

If the specific-IP bind is refused, fallbacks worth exploring: reconfigure or
disable the conflicting ICS/Default-Switch DNS, or keep DNS in-guest but still
unify the two guests on the single simpler "resolve-to-host-IP, no DNAT" model
(a smaller win that needs no host `:53` bind).

## Scope / impact if pursued

- **Host code:** `run-proxy` lifecycle gains a DNS listener (bind, supervise,
  shut down) next to the existing forwarder in `src/runProxy/`.
- **Ubuntu templates:** remove `dnsmasq-stub.conf`, `configamatron-egress.service`,
  and most of `60-dns-override.yaml`; simplify `nn-configure-network.sh`.
- **Windows templates:** remove the `dns-responder` project and its wiring
  (`isDnsResponderBuildArtifact`, the responder-config plumbing in
  `05-configure-network.ps1`).
- **VM test harness (`tests/vm/`):** currently models a DHCP host-only network
  with an in-guest resolver; it would need reworking toward the static-IP,
  host-resolver model. This is the largest and riskiest piece.
- **Docs:** `README.md`, `usage-hyper-v-host.md`, `usage-windows-vm.md`,
  `technical-notes.md` guest-network sections.

## Recommendation

Pursue as its own brainstorm → spec → plan cycle **after** the VMware-removal
cleanup lands, and **after** confirming the host `:53` bind. Do not fold it into
the VMware-removal work — it is a guest-networking rewrite, not a rename.
