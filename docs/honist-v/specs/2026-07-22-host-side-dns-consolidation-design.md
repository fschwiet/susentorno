# Host-side DNS consolidation

**Date:** 2026-07-22
**Status:** Approved for planning — contains open assumptions requiring VM validation
**Supersedes the open question in:** `docs/investigations/2026-07-22-host-side-dns-consolidation.md`
**Empirical basis:** `docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`

## Goal

Each guest currently runs its own fake DNS responder, and the two guests have
diverged in *how*: the Ubuntu guest answers every name with a throwaway
placeholder and then relies on iptables DNAT to redirect tcp/80 and tcp/443 to
the host, while the Windows guest answers every name with the host proxy IP
directly and needs no DNAT at all.

Replace both with **one fake DNS responder on the host**, supervised by
`run-proxy`, bound to the Internal-switch adapter IP. Every guest name then
resolves to the host proxy, the guest connects there directly with SNI intact,
and the entire in-guest DNS/DNAT/route layer is deleted.

`run-proxy` additionally serves **DHCP** on that network, so guests never carry
network-specific configuration at all. The guest contract reduces to:
**DHCP + trust the proxy CA.**

## Verified premise

The investigation that proposed this work flagged one blocking unknown: whether
the host can bind `<host-ip>:53` while another process holds wildcard
`0.0.0.0:53`. This was tested on the host and **answered affirmatively**. Full
method and results — including the port 67 / broadcast findings below — are in
`docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`.

What was established, all against the real `configamatron-internal` adapter
(`192.168.67.1`):

- The wildcard `0.0.0.0:53` holder is the **`SharedAccess` (Internet Connection
  Sharing)** service, as predicted.
- A specific-IP bind to `192.168.67.1:53` **succeeds** for UDP and TCP,
  unelevated, with no special socket options — while a control attempt to bind
  `0.0.0.0:53` correctly **fails** with `AddressAlreadyInUse`. The control is what
  makes the result meaningful: the conflict is real, and specific-IP binding is
  what escapes it.
- A live responder bound to `192.168.67.1:53` **received every query** addressed
  to that IP, including names ICS could have resolved for real. The more specific
  bind wins packet delivery; ICS does not intercept.
- `192.168.67.1:67` binds cleanly (ICS's DHCP bind is specific to the Default
  Switch address, not wildcard), and a socket bound to that specific address
  **does receive limited broadcast (`255.255.255.255`) and subnet broadcast**.
  This is the behaviour DHCP requires and is *not* how Linux behaves.

Consequences: no fallback is needed, and ICS does not have to be reconfigured or
disabled.

The original VMware-era obstacle is gone for a different reason than the ICS port
conflict: under VMware the guests reached the host through VMware's own network
endpoint, and VMware bound `:53` there to serve its NAT. The dedicated
`configamatron-internal` Internal switch is an endpoint this project controls,
with no competing binder on it.

## Scope

**In scope:**

- `src/runProxy/` — new DNS responder and DHCP server modules; `src/commands/runProxy.ts` wiring
- `templates/proxy/host-allow-vm-inbound.ps1`, `templates/proxy/verify-proxy.ps1`
- `templates/vm-shared/pre-scripts/` — `nn-configure-network.sh`,
  `dnsmasq-stub.conf`, `configamatron-egress.service`, `60-dns-override.yaml`
- `templates/vm-shared-windows/pre-scripts/` — `nn-configure-network.ps1`, the
  `dns-responder/` project and its build wiring
- `templates/vm-shared/verify-config.sh`, `templates/vm-shared-windows/verify-config.ps1`
- `tests/unit/**` affected by the above; `tests/vm/` harness and assertions
- `README.md`, `usage-hyper-v.md`, `usage-windows-vm.md`, `technical-notes.md`
- **The documented VM setup procedure** — this effort changes it (decision 4)

**Explicitly out of scope:**

- **Host-served names.** Making servers on the host reachable from guests by name
  on arbitrary ports is the motivating follow-on, and this work is a prerequisite
  for it, but the routing/firewall/Envoy questions it raises are deferred.
- **Reversible network isolation.** Deferred. This design deliberately builds no
  toggle, but makes the flip a pure host-side adapter reassignment.
- **Building a real DNS resolver.** The responder remains a catch-all stub.
- **Changing Envoy, the allowlist, or the blue/green color machinery.**
- **VMware support.** Dropped, not carried forward.
- `docs/superpowers/**`, `docs/honist-v/**`, `legacy/**` — point-in-time records.

## Design decisions

### 1. Responder lives in `run-proxy`, in-process

A new `src/runProxy/dnsResponder.ts` exposing
`startDnsResponder(opts): Promise<DnsResponderHandle>` with a `close()`,
deliberately mirroring `startGateway` in `src/runProxy/gateway.ts` so
`runProxy.ts` supervises it on the lifecycle it already has.

The original host-side DNS stub (`scripts/host-dns-stub.js`) was removed by
`docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md` because it was a script
the user had to "leave running in its own terminal" — an operational objection,
not a technical one. That objection no longer applies: `run-proxy` is a
supervised, long-lived host process that already resolves the Internal-switch
adapter IP and already listens on it. This design does not reintroduce a manual
step.

Rejected: **(b) a separate host process/service** — reintroduces exactly the
supervision problem that motivated moving DNS into the guests. **(c) reuse the
compiled `ConfigamatronDnsResponder` .NET exe on the host** — keeps a second
language and a build artifact in the tree for ~40 lines of packet construction,
and its config-file indirection is unnecessary once bind IP and answer IP are the
same value.

### 2. Wire semantics ported verbatim from the existing responder

The response format is ported from
`templates/vm-shared-windows/pre-scripts/dns-responder/Program.cs`, which is
proven against real guest resolvers. Re-implemented in TypeScript, not redesigned:

- Echo the 2-byte transaction ID; QR=1, **preserve RD**, RA=0, RCODE=0 (NOERROR)
- `QDCOUNT=1`; `ANCOUNT=1` **only** when `QTYPE=A` (1), otherwise `0`
- `NSCOUNT=0`, `ARCOUNT=0`
- Echo the question section verbatim
- For A: compression pointer `0xC00C`, TYPE `A`, CLASS `IN`, **TTL 30**,
  RDLENGTH 4, RDATA = the host IP
- Malformed query (< 12 bytes, or a question running past the buffer): reply with
  QR=1 and no answer records

Answering AAAA with NOERROR/no-answer rather than NXDOMAIN is load-bearing:
callers fall back to A instead of concluding the name does not exist.

**UDP only.** TCP/53 was verified bindable, but responses are ~50 bytes and never
approach truncation, and both current in-guest responders are UDP-only in
production. Revisit only if a resolver is observed retrying over TCP.

The answer decision is isolated in a pure function (`answerFor(qname, qtype)`)
separate from packet construction. Today it ignores `qname` and always returns the
host IP. This is for testability and to give the host-served-names follow-on a
single seam — it is **not** claimed to enable reversible isolation, which is
achieved by other means (decision 4).

### 3. Bind address, answer address, and lifecycle coupling

Both listeners bind the Internal-switch adapter IPv4 from the existing
`resolveForwardListenAddress()` in `src/runProxy/forwarder.ts` — the same call the
gateway already uses. **The answer IP is the bind IP**; there is no separate
configuration value and no `responder-config.txt` analogue.

They start under exactly the condition the gateway's Internal-switch listener
starts under: forwarding enabled. All three mean "serve the Internal switch", so
one condition governs them, and `--forward-listen <ip>` moves them together.

**No `--no-dns` flag.** There is no state in which forwarding is wanted but DNS is
not: a guest on `configamatron-internal` requires the host resolver, and a guest
on a NAT adapter uses that adapter's DHCP DNS and ignores the host responder
entirely — the responder sitting idle does no harm. A flag with no use case is not
added.

**Bind failure is fatal and loud**, matching the gateway's handling in
`src/commands/runProxy.ts:142-146`. A silently-absent listener is precisely the
failure that strands a guest, so it must never degrade quietly.

### 4. One active network adapter at a time

**This changes the documented VM setup procedure.**

Today, setup runs with **two** adapters attached: the permanent
`configamatron-internal` adapter and a temporary Default Switch (NAT) adapter for
internet. Isolation happens afterward by removing the NAT adapter and rebooting.

Two simultaneous adapters means two simultaneous resolvers. Once the guest's DNS
points at the host, `systemd-resolved` would race the host responder against the
NAT adapter's DHCP-supplied DNS and take whichever answered first —
nondeterministically proxied or direct. Suppressing that race is the *entire*
reason `templates/vm-shared/pre-scripts/60-dns-override.yaml` exists in its
current form.

Instead, **only one adapter is ever active**:

1. **NAT phase.** The VM's single adapter is connected to Hyper-V's Default
   Switch. DHCP, real DNS, real internet. All setup work happens here: OS
   install, the numbered scripts (apt, pnpm, tools), CA trust.
2. **Shutdown.**
3. **Reassign** that same adapter to `configamatron-internal`
   (`Connect-VMNetworkAdapter -SwitchName`).
4. **Isolated phase.** Boot. The guest takes a lease from `run-proxy`'s DHCP
   server and comes up isolated. Verify.

Consequences:

- `60-dns-override.yaml` is **deleted outright**, not reduced to a stub. There is
  never more than one resolver, so there is nothing to suppress.
- The interface-discovery block in `nn-configure-network.sh` is deleted.
- **Reassigning the existing adapter's switch, rather than adding/removing an
  adapter, is deliberate.** The guest keeps the same virtual NIC, so the interface
  name stays stable and any interface-scoped configuration remains valid.
  (Assumption A5.)
- This is not more steps than today, which already requires removing an adapter
  and rebooting.
- The setup procedure and the future reversible-isolation mechanism become the
  same mechanism, exercised once. Reversibility is not built here, but nothing in
  this design has to be undone to build it.

Rejected: **(b) keep two adapters and retain DHCP-DNS suppression** — preserves
the most fragile file in the guest layer and leaves a nondeterministic window.
**(c) keep two adapters and accept the race** — nondeterministic setup behaviour
manufactures flaky, hard-to-reproduce bug reports.

### 5. `run-proxy` serves DHCP on the Internal-switch network

The guest is configured for **DHCP on both networks and never reconfigured**. On
the Default Switch it takes a lease from ICS (real gateway, real DNS); on
`configamatron-internal` it takes a lease from `run-proxy` (host IP as router and
as DNS). Switching networks is therefore a purely host-side adapter reassignment
with **no guest-side change at all**.

This eliminates the largest risk the static-IP approach carried: a mistyped static
config left the guest with no address on an isolated network and no way to reach
the share that carries the fix, recoverable only through the Hyper-V console. It
also removes the "write the static config before shutdown" ordering constraint.

New `src/runProxy/dhcpServer.ts`, same module shape as the DNS responder
(`startDhcpServer` / handle / `close()`), bound to `<host-ip>:67`.

**Addresses are derived deterministically from the client MAC, with no lease
table.** A stable hash of the MAC maps into the host range (`.10`–`.209`),
avoiding `.1` (the host) and the broadcast address; collisions resolve by linear
probe. Rationale: guest IPs are load-bearing for nothing — every name resolves to
the host, and SMB traffic is guest→host — so lease state would be pure overhead.
This is idempotent across `run-proxy` restarts, needs no persistence, and cannot
exhaust a pool.

Rejected: **a conventional lease pool with expiry.** More familiar to a later
reader, but it introduces state that serves no purpose here and must survive
restarts to avoid handing the same address to two guests.

Options served: subnet mask (1), router (3) = host IP, DNS (6) = host IP, lease
time (51), server identifier (54), broadcast address (28), and T1/T2 (58/59).
Message types handled: `DISCOVER`→`OFFER`, `REQUEST`→`ACK`/`NAK`, `RELEASE`,
`INFORM`. Serving a router option is deliberate — nothing should ever route
off-subnet, since all names resolve to the host, but clients and applications
behave better with a default route present than without, and it replaces the
guarded default-route hack the Ubuntu egress unit performs today.

### 6. The share is reachable during the NAT phase

The SMB share carrying the numbered scripts is served over
`configamatron-internal` and currently scoped to that adapter alone. With one
adapter active at a time, the share and the internet would never be available
together — but the numbered scripts live on the share *and* download from the
internet.

**Resolution: scope the SMB (TCP 445) firewall rule to the Default Switch adapter
as well, permanently.** The numbered scripts then run in the NAT phase over
direct internet, exactly as they do today, and the isolated phase reduces to boot
and verify.

This is a smaller compromise than it first appears. The existing warning
(`usage-hyper-v.md:57`) is against exposing SMB on the **external NIC**; the
Default Switch is Hyper-V's NAT network, unreachable from the LAN or the internet.
The widened audience is other VMs and containers on the host's NAT network.

The share contains no secrets: `cert.pem` is the CA's **public** certificate, and
`credentials.json` / `auth.json` / `github-config.txt` are **sanitized
placeholders** (`src/commands/init.ts:19`, `src/commands/writeGithubConfig.ts:70`).
Real tokens live in `.configamatron/proxy/secrets/` and are injected server-side
by Envoy (`src/envoyConfig.ts:368`) — keeping them out of the guest is the
architecture's central property, and this change does not weaken it.

Permanent rather than setup-only is deliberate: re-scoping the rule between phases
is a manual step that fails **open** when forgotten. A standing, documented
exposure is preferable to a toggle that silently degrades.

Rejected: **(b) run the numbered scripts in the isolated phase through the proxy**
— moves `apt-get`, pnpm, and every tool download onto the Envoy allowlist during
setup, turning currently-invisible allowlist gaps into setup failures. **(c)
deliver the scripts by another channel** (ISO, Enhanced Session copy) — keeps the
share internal-only at the cost of a clunkier procedure.

**Note for the docs:** Hyper-V regenerates the Default Switch subnet across host
reboots, so the NAT-phase mount address is not stable and must be discovered with
`ipconfig` at mount time rather than hardcoded. Only the Internal-switch host IP
is stable — worth stating explicitly, since the guide is built on "one host IP
threads through everything."

### 7. Host readiness precedes isolated boot

Because the guest's only resolver — and now its only DHCP server — is the host,
`run-proxy` and the inbound firewall rules must be running **before** the VM is
booted into the isolated phase. `usage-hyper-v.md` currently documents the host
firewall/`run-proxy` step *after* the guest scripts; that ordering moves earlier.

This concentrates the requirement into a single statable precondition — "have
`run-proxy` up before booting the isolated VM" — rather than an interleaving
constraint spread across the script sequence.

Accepted tradeoff: guest network availability is now coupled to a host process
being up. Previously a down proxy failed at connect ("connection refused"); it now
fails at address acquisition or resolution. The failure is equally fast but
presents differently, which is why decision 8 adds listener checks.

### 8. Firewall rules and verification

`templates/proxy/host-allow-vm-inbound.ps1` gains inbound **UDP/53** and
**UDP/67** allow rules, scoped with `-InterfaceAlias` exactly as the existing TCP
80/443 rule is, and drops the stale-rule cleanup for `Envoy Sandbox Proxy DNS stub
(VM inbound)` — that rule becomes current again. This re-adds what
`docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md:62` removed, under the
same rule name. It also widens the SMB rule per decision 6.

The rules are required, not optional: the Internal-switch adapter is categorized
**Public**, all firewall profiles are enabled, and `DefaultInboundAction` resolves
to **block**. Pre-existing `HNS Container Networking - DNS (UDP-In)` rules may
incidentally permit DNS on some hosts, but they are created by container
networking and may be removed by it; this design does not rely on them.

`templates/proxy/verify-proxy.ps1` gains checks that UDP listeners are present on
`<host-ip>:53` and `<host-ip>:67`, so a missing service is diagnosable rather than
presenting as mysterious guest-side failures.

## Open assumptions requiring VM validation

These are **not** blockers to writing the plan, but each must be confirmed against
a real guest before the phase that depends on it is implemented. Phase 0 exists to
retire them. A Windows guest is available and can be switched between the Default
Switch and `configamatron-internal`.

| # | Assumption | Why it is uncertain | How to validate |
|---|---|---|---|
| **A1** | A DHCP `DISCOVER` broadcast from a real guest, arriving across the vSwitch, is delivered to a socket bound to `<host-ip>:67`. | The host test that established broadcast delivery was **host-originated** and pinned to the internal adapter. A guest broadcasts from `0.0.0.0` across the virtual switch — a different arrival path. | Passive listener on `<host-ip>:67` that logs any packet received; boot the guest on `configamatron-internal` with DHCP configured and observe whether `DISCOVER` arrives. **No DHCP server needed.** |
| **A2** | Inbound UDP/53 from a guest reaches the host responder through Windows Firewall with the interface-scoped rule. | All DNS testing so far originated on the host and never traversed the firewall. The adapter is Public with inbound defaulting to block. | Add the UDP/53 rule, run the test responder on `<host-ip>:53`, query it from the guest with `Resolve-DnsName -Server <host-ip>`. |
| **A3** | With DNS answered by the host, the guest connects to the proxy with SNI intact and traffic flows end to end. | The Windows guest already uses the resolve-to-host-IP model, so moving the *source* of the answer should be transparent — but that has not been demonstrated. | Point the guest's DNS at `<host-ip>`, stop the in-guest responder, `curl`/`Invoke-WebRequest` an allow-listed domain. |
| **A4** | The share is mountable over the Default Switch with the widened SMB scope, and the Default Switch host IP is discoverable at mount time. | New path; the share has only ever been served on the Internal switch. Default Switch addressing is not stable across host reboots. | Widen the 445 rule, attach the guest to the Default Switch, mount by the `ipconfig`-discovered IP. |
| **A5** | Reassigning the adapter's virtual switch preserves the guest's NIC identity (same interface alias/name) across the flip. | Asserted from the fact that it is the same virtual adapter, not measured. If the guest renames the interface, interface-scoped configuration breaks. | Record the guest's adapter alias/MAC, reassign the switch, reboot, compare. |
| **A6** | The Windows and Ubuntu DHCP clients interoperate with the deterministic-mapping server. | The server does not exist yet; DHCP clients are notoriously particular about option encoding and message sequencing. | Validate after Phase 2, against both guests. |

### Validation results (2026-07-22)

Run against a **fresh** Windows guest (`sus-windows`) that had never had any
configamatron setup applied — notably, it does not trust the proxy CA.

- **A1 — CONFIRMED.** A real guest's DHCP `DISCOVER`, sourced from `0.0.0.0:68`
  and broadcast across the vSwitch, was delivered to a socket bound to
  `192.168.67.1:67`. Observed repeatedly across two transaction IDs with the
  client MAC parsed correctly. This retires the load-bearing unknown: **decision 5
  (host DHCP) is viable.**
- **A2 — CONFIRMED.** From the guest, `example.com`, `api.anthropic.com`, and
  `totally-made-up.invalid` all resolved to `192.168.67.1` via the host responder,
  through an interface-scoped inbound UDP/53 firewall rule.
- **A3 — CONFIRMED for transport.** An HTTPS request to `api.anthropic.com`
  resolved, connected to `192.168.67.1:443`, and completed a TLS handshake in
  which Envoy presented a certificate. It failed only at CA trust
  (`Could not establish trust relationship`), which is expected on a guest that
  never ran the CA-trust step and is unaffected by this design. Full end-to-end
  confirmation is deferred to the Phase 4 checkpoint on a configured guest.
- **A5 — CONFIRMED.** Adapter identity survived the switch reassignment and reboot
  unchanged: alias `Ethernet 2`, MAC `00-15-5D-00-71-10`, `ifIndex 11`.

  This run also produced unplanned supporting evidence for decision 5: on the
  Default Switch the guest still carried its static `192.168.67.50` and DNS
  `192.168.67.1`, leaving it with no working connectivity on the NAT network.
  Static configuration does not follow the network — precisely the fragility that
  DHCP-on-both-networks removes.
- **A4 — outstanding.** Two false starts, neither informative: the
  `vm-shared-windows` SMB share was not published on the host at all, and the
  guest still held a static address on the wrong subnet. Retest pending.
- **A6 — outstanding.** Cannot be tested until the DHCP server exists (Phase 2).

Incidental observation to verify during implementation: the guest's
`Resolve-DnsName` reported `DNS server failure` for an AAAA query, where the
intended behaviour is NOERROR with zero answer records. This is most likely how
that cmdlet surfaces an empty answer rather than a genuine defect — the same run
resolved `api.anthropic.com` successfully through the normal client path, which
attempts AAAA before A, and the existing `ConfigamatronDnsResponder` ships these
exact semantics today. The unit tests in Phase 1 must assert the response
**bytes** (ANCOUNT=0, RCODE=0) rather than rely on cmdlet reporting.

## Phases

One spec, one plan, implemented sequentially. The phases are execution structure,
not separate cycles: no phase needs external sign-off before the next begins,
except where a manual checkpoint is called out.

**Phase 0 — Retire the open assumptions.** Scripts run against the ready Windows
guest to validate A1, A2, A3, A4, A5. No production code changes; throwaway
listeners and temporary firewall rules only. Outcomes are recorded back into this
spec, and any that fail send the affected decision back for revision.

**Phase 1 — Host DNS responder and firewall.** `dnsResponder.ts`, `runProxy.ts`
wiring, the UDP/53 rule, the `verify-proxy.ps1` check. Purely additive: guests
keep working on their in-guest responders throughout. Fully verifiable on the
host.

**Phase 2 — Host DHCP server and firewall.** `dhcpServer.ts`, the UDP/67 rule,
the corresponding verify check. Also additive — nothing consumes it until a guest
is booted on the Internal switch with DHCP configured. Retires A6.

**Phase 3 — Setup procedure revision.** Rework `usage-hyper-v.md` and the guest
docs to the single-adapter, NAT-then-reassign flow, with host readiness moved
ahead of the guest scripts and the widened SMB scope documented.

**Phase 4 — Windows guest.** Delete the `dns-responder` project and its wiring;
the adapter stays on DHCP. Behaviourally a no-op from the guest's perspective —
same answers, different source — and the guest is already available, making this
the lowest-risk guest phase and the natural first end-to-end proof.

**Phase 5 — Ubuntu guest.** Delete the in-guest DNS/DNAT/route layer. Larger
deletion, and the harness work is concentrated here.

**Manual checkpoint after Phase 4 and again after Phase 5.** The guest-side phases
cannot be verified automatically: the VM test harness simulates the topology via
WSL rather than exercising a real Hyper-V guest. Each guest must be taken through
the full flow — NAT phase, scripts, shutdown, adapter reassignment, boot, and a
successful request to an allow-listed domain — before the work is considered done.

Ordering rationale: the host services must exist and be proven reachable *from a
guest* before any guest phase removes its in-guest fallback. A guest that cannot
get an address or resolve a name has no route to the share that carries its fix,
and recovery requires console access.

## Implementation changes

### Host

- **`src/runProxy/dnsResponder.ts`** (new) — `startDnsResponder` /
  `DnsResponderHandle` / `close()`, per decisions 1–3. Packet construction and
  `answerFor` policy kept as separate, independently testable units.
- **`src/runProxy/dhcpServer.ts`** (new) — `startDhcpServer` / handle / `close()`,
  per decision 5. Packet parse/build, the deterministic MAC→IP mapping, and the
  message-type state machine kept as separate units.
- **`src/commands/runProxy.ts`** — start both services alongside the gateway when
  forwarding is enabled, using the same resolved IP; fail loudly on bind error;
  close them on shutdown; log their listen addresses alongside the gateway line.
- **`templates/proxy/host-allow-vm-inbound.ps1`** — add interface-scoped inbound
  UDP/53 and UDP/67 rules; widen the SMB rule to the Default Switch adapter;
  remove the stale-rule cleanup; rewrite the header comment, which currently
  explains why the UDP/53 rule was removed.
- **`templates/proxy/verify-proxy.ps1`** — add `<host-ip>:53` and `<host-ip>:67`
  UDP listener checks.

### Ubuntu guest (`templates/vm-shared/pre-scripts/`)

- **`dnsmasq-stub.conf`** — delete.
- **`configamatron-egress.service`** — delete. Both DNAT rules and the guarded
  default-route install go with it: nothing needs redirecting once names resolve
  to the host, and the default route now arrives via DHCP option 3.
- **`60-dns-override.yaml`** — delete (decision 4).
- **`nn-configure-network.sh`** — drop the `dnsmasq` install, the stub-config
  copy, the egress unit templating/enable, the interface-discovery block, and the
  netplan-override install. What remains is CA trust (system store,
  `NODE_EXTRA_CA_CERTS`, Firefox policy). The network portion disappears entirely:
  the guest stays on DHCP.
- **`verify-config.sh`** — replace the DNAT/`dnsmasq`/placeholder-resolution
  checks with: names resolve to the host IP, no NAT rules present, address
  acquired via DHCP.

### Windows guest (`templates/vm-shared-windows/pre-scripts/`)

- **`dns-responder/`** — delete the project, including the checked-in `obj/`
  build output.
- **`nn-configure-network.ps1`** — remove the `responder-config.txt` write, the
  Scheduled Task registration, and the loop that points every up adapter at
  `127.0.0.1`. No DNS configuration remains: it arrives via DHCP option 6.
- Remove the `isDnsResponderBuildArtifact` build wiring and any packaging that
  ships the responder into the share.
- **`verify-config.ps1`** — mirror the Ubuntu check changes.

### Tests

- **`tests/unit/`** — table-driven tests for the DNS responder (A answers, AAAA →
  NOERROR/no-answer, other qtypes, RD preservation, malformed input, compression
  pointer) and for the DHCP server (option encoding, DISCOVER/REQUEST handling,
  NAK paths, and that the MAC→IP mapping is stable, in-range, and collision-safe).
  All pure byte-array assertions. Remove `templates.test.ts` assertions covering
  `60-dns-override.yaml`, which is deleted.
- **`tests/vm/`** — the harness currently models a NAT network plus a gateway-less
  **DHCP** network with an in-guest resolver. It is re-modeled so the resolver and
  the DHCP server sit on the harness "host" side. Assertions that change: the
  `dnsmasq` stub answering the placeholder and the `dnsmasq` service being active
  (`vm.test.ts:111-126`, `:198`), both DNAT-rule assertions (`:123-126`,
  `:403-405`), and the `dig ... @127.0.0.1` placeholder check (`:407-408`). These
  become: names resolve to the host IP, and no DNAT rules exist.

  This is the largest and least certain piece of the work. It is carried in the
  guest phases rather than split out, because the assertions are guest-specific
  and a harness change alone cannot be validated. Note that
  `tests/vm/wsl.ts:71-84` already documents a WSL-specific `:67` constraint; the
  harness's own DHCP arrangement may need rework alongside.

## Documentation changes

- **`usage-hyper-v.md`** — the substantive rewrite. Replace the two-adapter setup
  with the single-adapter NAT-then-reassign flow. Move host firewall and
  `run-proxy` startup ahead of the guest scripts (decision 7). Document the
  widened SMB scope and the fact that the Default Switch address must be
  discovered rather than hardcoded (decision 6). Guests are DHCP throughout; the
  static-IP instructions are removed. Keep the "one host IP threads through
  everything" framing, which now also covers DNS and DHCP.
- **`usage-windows-vm.md`** — update for the new phase boundary; remove the
  in-guest DNS responder steps.
- **`README.md`** — update the numbered-script flow and any guest-network
  description referencing the DNAT/stub model.
- **`technical-notes.md`** — rewrite the guest-networking sections: DNS and DHCP
  are host responsibilities; the DNAT layer is gone. Update the testing "fidelity
  gaps" paragraph, which currently forward-references this effort.
- **`docs/investigations/2026-07-22-host-side-dns-consolidation.md`** — mark
  resolved, pointing at this spec and the port-53/67 investigation.

## Verification

- `pnpm test` must pass — the full pipeline in `package.json`: `format:check`,
  `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration`
  (needs Docker).
- `pnpm test:vm` must pass with the re-modeled harness.
- On the host with `run-proxy` running: `Get-NetUDPEndpoint -LocalPort 53` and
  `-LocalPort 67` show the services on the Internal-switch IP, coexisting with
  ICS; `Resolve-DnsName -Name <any-name> -Server <host-ip>` returns `<host-ip>`.
- `verify-proxy.ps1` passes, including the new listener checks.
- Repo-wide grep confirms no live references remain to `dnsmasq`,
  `configamatron-egress`, `60-dns-override`, `ConfigamatronDnsResponder`, or
  `isDnsResponderBuildArtifact` outside `docs/superpowers/**`, `docs/honist-v/**`,
  `docs/investigations/**`, and `legacy/**`.
- **Manual, both guests:** full flow through adapter reassignment and boot; an
  address acquired via DHCP with the host as router and DNS; a request to an
  allow-listed domain succeeds; no in-guest DNS service present; on Ubuntu, no
  iptables NAT rules present.

## Success criteria

- Exactly one fake DNS responder exists in the project, and it runs on the host
  under `run-proxy`.
- Both guests' network configuration is **DHCP plus proxy CA trust** — no static
  addressing, no in-guest DNS service, no DNAT rules, no default-route hack, no
  DHCP-DNS suppression.
- Guests never have more than one network adapter active, and switching a guest
  between isolated and NAT networks requires **no guest-side change**.
- Guest traffic reaches the proxy with SNI intact, exactly as the Windows guest
  achieves today; the Ubuntu and Windows network models are identical.
- A host server on an arbitrary port is reachable from a guest by name at
  `<host-ip>:<port>` — the capability this unblocks, even though exposing specific
  services is follow-on work.
- The full verification pipeline passes, and both manual guest checkpoints pass.

## Follow-on work

- **Host-served names.** Unblocked but not designed here. Every name already
  resolves to the host, so a host service on a non-conflicting port is reachable
  once a firewall rule permits it. The open questions are how services on
  **80/443** are distinguished from names that should be proxied upstream (Envoy
  routing by SNI/Host to a local backend), and how those rules are configured.
- **Reversible network isolation.** Now a pure host-side adapter reassignment,
  since the guest is DHCP on both networks. This spec makes it the same mechanism
  as setup but builds no toggle.
- **TCP/53.** Add only if a resolver is observed falling back to TCP.

## Risks

- **A1 is the load-bearing unknown.** If guest-originated DHCP broadcasts are not
  delivered to a specific-IP bind, decision 5 collapses and the design reverts to
  static addressing (with the brick risk and the write-before-shutdown step
  returning). Phase 0 retires this cheaply, with a passive listener and no server.
- **DHCP client interop (A6).** A server bug presents as "guest has no address" —
  the same class of failure static configuration risked, relocated from a typo to
  our code. Mitigated by static configuration remaining a supported manual
  fallback: if DHCP misbehaves, console in and set an address by hand.
- **The VM test harness re-modeling is the least certain implementation piece.**
  Moving the resolver and DHCP server to the harness host side may surface WSL
  networking constraints comparable to the existing `ignoredPorts=67` workaround.
- **Host process liveness is now a guest dependency.** Accepted per decision 7,
  mitigated by the `verify-proxy.ps1` checks and fatal-on-bind-failure behaviour.
- **Widened SMB exposure.** Accepted per decision 6 on the basis that the share
  holds no secrets and the Default Switch is host-local NAT.
