# Investigation: host-side DNS consolidation (Hyper-V)

**Date:** 2026-07-22
**Status:** **Closed 2026-07-23 — pursued and implemented.** The body below is
preserved as written; see "Outcome" at the end for what actually happened, and
where reality diverged from what this note predicted.

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
- **Docs:** `README.md`, `usage-hyper-v.md`, `usage-windows-vm.md`,
  `technical-notes.md` guest-network sections.

## Recommendation

Pursue as its own brainstorm → spec → plan cycle **after** the VMware-removal
cleanup lands, and **after** confirming the host `:53` bind. Do not fold it into
the VMware-removal work — it is a guest-networking rewrite, not a rename.

---

## Outcome (2026-07-23)

Pursued as recommended, through its own spec and plan:

- Spec: `docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`
- Plan: `docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md`

**The blocking risk cleared.** A specific-IP UDP bind to `<host-ip>:53` does
coexist with a wildcard `0.0.0.0:53` holder on Windows, and — the part that
actually mattered — packets addressed to the specific IP are delivered to the
**specific** socket, not intercepted by the wildcard holder. The wildcard holder
was confirmed to be ICS (`SharedAccess`), as this note guessed. Measured
properly on the host this time, not from inside a guest: see
`docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`.

### Where the outcome differed from this note

Four things, all in the direction of a simpler result than proposed:

1. **Guests ended up on DHCP, not "static IP + nameserver".** This note proposed
   pointing each guest's resolver at the host "via its static network config".
   Phase 0 validation killed that: static configuration does not follow the
   network, so a guest moved between the Default and Internal switches carried a
   dead address and resolver with it. `run-proxy` therefore serves **DHCP as well
   as DNS**, handing out the host as both router (option 3) and DNS (option 6).
   A DHCP server was not in this note's scope at all, and became the largest
   piece of host-side work.
2. **The end state is simpler than "static IP + nameserver + trust the CA".** It
   is **"DHCP + trust the proxy CA"** — the guest has no network configuration to
   speak of, and switching networks became a purely host-side operation with no
   guest-side change in either direction.
3. **`60-dns-override.yaml` was deleted outright, not collapsed.** This note
   expected it to shrink to "set nameserver = host IP". It existed solely to
   arbitrate between two simultaneous resolvers; with one adapter active at a
   time there is never more than one, so nothing remained to configure.
4. **The VM harness was the predicted risk, but not in the predicted way.** It
   was reworked toward a DHCP host-resolver model rather than the static-IP one,
   and it deliberately does **not** exercise the production DHCP/DNS servers:
   those are Windows-targeted, and running them under WSL would test Linux socket
   behaviour instead. The harness keeps its own dnsmasq standing in for
   `run-proxy` — which is also its control channel, since `guest.sh` derives every
   guest's SSH address from that lease file.

### Validated on real hardware

The Windows guest checkpoint confirmed full DORA to an address-less client,
renewal, lease adoption across a `run-proxy` restart, unattended recovery when
the host starts late, and an authenticated SMB mount over the Default Switch.
Results and the incidental findings are recorded in the spec's "Validation
results — Phase 4 checkpoint (2026-07-23)".

One follow-on concern surfaced that this note did not anticipate: because the
guest now reaches host services through a small set of firewall-allowed ports on
a multi-homed host, the confinement to the Internal-switch address depends on
the Windows **strong host model** rather than on the firewall rules. See
`docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`.

**Not yet closed:** the Ubuntu guest half has been implemented but never run on a
real Ubuntu VM. The rewritten `templates/vm-shared/verify-config.sh` has only
been syntax-checked.
