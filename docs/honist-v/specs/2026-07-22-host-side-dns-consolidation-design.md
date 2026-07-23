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

### 2. Wire semantics derived from the existing responder, with a tightened input grammar

The response format follows
`templates/vm-shared-windows/pre-scripts/dns-responder/Program.cs`, which is
proven against real guest resolvers, re-implemented in TypeScript. **Not** a
verbatim port, and the difference is deliberate: that responder binds
`127.0.0.1`, so its only client is a local stub resolver. The host responder binds
a network-facing address reachable by every guest on the switch, which is a wider
input surface than the original was written for. The original ignores `QDCOUNT`,
opcode, `QR`, and `QCLASS`; does not validate label lengths; and its
malformed-query path echoes the request's own header counts back.

Response format:

- Echo the 2-byte transaction ID; QR=1, **preserve RD**, RA=0, RCODE=0 (NOERROR)
- `QDCOUNT=1`; `ANCOUNT=1` **only** when `QTYPE=A` (1), otherwise `0`
- `NSCOUNT=0`, `ARCOUNT=0`
- Echo the (single, validated) question section
- For A: compression pointer `0xC00C`, TYPE `A`, CLASS `IN`, **TTL 30**,
  RDLENGTH 4, RDATA = the host IP

Accepted query grammar — anything outside it is rejected rather than best-effort
parsed:

- Standard `QUERY` opcode, `QR=0`, exactly one question, `QCLASS=IN`
- QNAME with valid label lengths, no compression pointer (a question section has
  nothing to point back to), total length within bounds
- A packet shorter than a complete 12-byte header is **dropped with no reply** —
  there is not even a transaction ID to echo, so a reply is impossible. (An
  earlier draft said such packets receive a reply; that was incorrect.)
- A parseable packet that violates the grammar gets `FORMERR`, with header counts
  set explicitly rather than echoed from the request

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

**Startup is all-or-nothing.** There are now three services binding in sequence
(gateway, DNS, DHCP), and a failure at step three must not leave the first two
holding ports. `startGateway` already rolls back its own partially-created
listeners (`src/runProxy/gateway.ts:87-90`), but that guarantee does not extend
across services. A startup helper acquires them in order and, on any failure,
closes what it has already opened in reverse order before propagating the error —
so a failed launch leaves no orphaned listeners and can be retried immediately.
Tests cover failure injected at each stage, and shutdown arriving during partial
initialization.

**If the Internal-switch adapter's IP disappears or changes while running**, the
existing sockets remain bound to the old address and will not recover on their
own. This is treated as fatal: the condition is detected and `run-proxy` exits
with a diagnostic naming the adapter, rather than continuing in a state where
guests silently cannot resolve or renew. Supervised rebinding is deliberately not
attempted — it is more machinery than the failure frequency justifies, and the
loud exit is diagnosable.

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

#### Address allocation: an in-memory lease table

An earlier draft of this spec specified a **stateless** allocator — a hash of the
client MAC into the host range, with "collisions resolved by linear probe" and a
claim that it "cannot exhaust a pool." That design was incoherent and is
**rejected**: linear probing requires knowing which addresses are already taken,
which is precisely a lease table, and a finite range obviously can exhaust. Two
MACs hashing to the same slot would both have been handed the same address.

The design is an **in-memory lease table**, keyed by client identity:

- **Client identity** is the DHCP client-identifier (option 61) when present,
  otherwise `chaddr`. Consistent keying matters: some clients send option 61 and
  expect it to be authoritative.
- **Preferred address** is still derived from a stable hash of the identity into
  `.10`–`.209`, so a given guest normally lands on the same address run after run.
  This is a *hint*, not a guarantee — the table is authoritative and resolves
  conflicts by probing for the next free entry.
- **Expiry** is tracked; lapsed entries return to the pool. `RELEASE` frees
  immediately; `DECLINE` marks an address unusable for the process lifetime.
- **Exhaustion** is a real state: no free entry means no `OFFER`, logged loudly.
  With one or two guests on an isolated switch this should never happen, but it
  must fail visibly rather than silently reuse an address.

**Restart behaviour is defined rather than assumed.** The table does not persist;
`run-proxy` restarts with an empty one. A client that then renews for an address
we have no record of is **ACKed if that address is in range and unallocated**,
adopting the client's existing claim rather than forcing a disruptive `NAK`. Only
an out-of-range or already-allocated request is `NAK`ed. This makes a restart
invisible to a running guest in the common case.

Rationale for keeping state at all: guest IPs are load-bearing for very little —
every name resolves to the host, and SMB is guest→host — but "very little" is not
"nothing", and correctness under collision and renewal is worth a few dozen lines
of bookkeeping.

#### DHCP protocol behaviour

Only `DISCOVER` reception was empirically validated (A1). The **reply** path was
not, and getting it wrong produces exactly the "guest has no network" failure this
design exists to avoid, so it is specified here rather than left to the
implementation.

**Reply destination.** The socket sets `SO_BROADCAST`. Replies go to
`255.255.255.255:68` whenever `ciaddr` is zero — i.e. the client has no usable
address yet, so a unicast reply would require ARP for an address it does not hold.
The BOOTP broadcast flag is honoured when set. `RENEWING` clients (unicast
`REQUEST` with a non-zero `ciaddr`) are answered unicast to `ciaddr`. `giaddr` is
expected to be zero; a non-zero value means a relay is involved, which this
topology does not support, and such packets are ignored with a log line.

**States handled**, per RFC 2131:

| Client state | Request shape | Response |
|---|---|---|
| SELECTING | `DISCOVER` | `OFFER` with `yiaddr` |
| REQUESTING | `REQUEST` + option 54 == us | `ACK` |
| REQUESTING | `REQUEST` + option 54 == another server | ignore; release our offer |
| INIT-REBOOT | `REQUEST` + option 50, no option 54 | `ACK` if in range and free, else `NAK` |
| RENEWING | unicast `REQUEST`, `ciaddr` set | `ACK` |
| REBINDING | broadcast `REQUEST`, `ciaddr` set | `ACK` |
| — | `RELEASE` | free the lease, no reply |
| — | `DECLINE` | mark address unusable, no reply |
| — | `INFORM` | `ACK` with options only, `yiaddr` zero |

Fields echoed or set explicitly: `xid`, `flags`, `chaddr`, `htype`/`hlen`, and the
magic cookie. `siaddr` is the host IP. Malformed option streams — an option
running past the end of the buffer, or a missing terminator — cause the packet to
be dropped, not partially parsed.

**Options served:** subnet mask (1), router (3) = host IP, DNS (6) = host IP,
broadcast address (28), lease time (51), server identifier (54), T1/T2 (58/59).
Serving a router option is deliberate — nothing should ever route off-subnet since
all names resolve to the host, but clients and applications behave better with a
default route present, and it replaces the guarded default-route hack the Ubuntu
egress unit performs today.

**Every received packet is checked against the local address it arrived on**, so a
socket or firewall rule accidentally widened to another network cannot cause the
server to answer clients it does not own.

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

Accepted tradeoff, stated more carefully than an earlier draft did: guest network
availability is now coupled to a host process being up, and this is **not** merely
a cosmetic change in how failure presents. Previously a down proxy failed at
connect ("connection refused") while the guest kept a working address, its share
mount, and every local diagnostic. Now a guest that boots without `run-proxy`
running gets **no address at all**, which also costs it the SMB mount and any
network-based administration. That is materially worse, and the pre-boot listener
checks in decision 8 do nothing about a crash, a host reboot, or a
credential-related exit that happens *after* the guest is up.

Recovery contract:

- **Guest booted before `run-proxy`:** the DHCP client keeps retrying (observed
  during A1 validation, where a guest retried `DISCOVER` for minutes). Starting
  `run-proxy` afterwards must let the guest acquire a lease with no console
  intervention. This is an explicit test, not an assumption.
- **`run-proxy` restarts while a guest holds a lease:** covered by the restart
  behaviour in decision 5 — the guest's renewal is ACKed rather than NAKed.
- **DNS and DHCP must remain available across Envoy blue/green restarts.** They
  are on the `run-proxy` lifecycle, not the per-color one, so this should hold by
  construction; it is worth a test because the failure would be intermittent and
  confusing.
- **Console recovery** remains the documented last resort: static addressing
  applied by hand is still supported and is the escape hatch if DHCP misbehaves.

Running `run-proxy` as an auto-restarting host service would address the crash
case properly. That is **out of scope here** — it changes how the whole tool is
operated, not just its networking — but it is the natural follow-on if the
foreground-process dependency proves annoying in practice.

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
| **A6** | The Windows and Ubuntu DHCP clients interoperate with the server: full DORA, replies actually reaching an address-less client, renewal, and behaviour across a `run-proxy` restart. | The server does not exist yet; DHCP clients are notoriously particular about option encoding and message sequencing. Phase 0 proved only that a `DISCOVER` **arrives** — never that a reply gets back. | Validate at the Phase 4 checkpoint, against both guests. |

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
- **A3 — CONFIRMED, including SNI.** Two connections were made from the guest
  *by name*, so the host responder had to resolve them first. Both resolved to
  `192.168.67.1` and connected to the same port:

  | SNI sent | Outcome |
  |---|---|
  | `api.anthropic.com` (allow-listed) | handshake OK, `HTTP/1.1 404 Not Found` from upstream |
  | `evil-not-allowed.example.com` | connection closed during handshake |

  Same destination IP, same port, different outcome — SNI is the only thing Envoy
  could have distinguished them by. **The guest's SNI survives the host-DNS path
  intact**, which is the property the whole design rests on.

  Separately, after importing the proxy CA into the guest's trusted roots, a
  plain `Invoke-WebRequest` to `https://api.anthropic.com` returned a real HTTP
  404 from the service — full end-to-end through resolution, TLS validation, and
  upstream proxying.
- **A5 — CONFIRMED.** Adapter identity survived the switch reassignment and reboot
  unchanged: alias `Ethernet 2`, MAC `00-15-5D-00-71-10`, `ifIndex 11`.

  This run also produced unplanned supporting evidence for decision 5: on the
  Default Switch the guest still carried its static `192.168.67.50` and DNS
  `192.168.67.1`, leaving it with no working connectivity on the NAT network.
  Static configuration does not follow the network — precisely the fragility that
  DHCP-on-both-networks removes.

  **Re-leasing after a switch move is demonstrated in one direction.** Once the
  guest was reverted to DHCP and moved to the Default Switch, it booted and took a
  fresh ICS lease (`172.17.224.36/20`, gateway `172.17.224.1`) with no manual
  intervention. So a shutdown-plus-reassignment does cause a clean re-lease. The
  **reverse** direction — moving back onto `configamatron-internal` and taking a
  lease from `run-proxy` — cannot be tested until Phase 2 exists, and is part of
  A6. Whether a *live* switch move (without a reboot) re-leases is untested and
  not relied upon: the documented procedure always shuts the guest down first.
- **A4 — TRANSPORT CONFIRMED; authenticated mount outstanding.** With the guest on
  the Default Switch (DHCP address `172.17.224.36/20` from ICS) and the SMB rule
  scoped to that adapter, **TCP 445 on the host was reachable**. That is decision
  6's load-bearing requirement: routing plus firewall scope permit the share to be
  served on the NAT network.

  Mounting the share itself did not succeed, for a reason unrelated to this
  design: the share grants access only to the `configamatron-share` account, and
  this throwaway guest had never been given that saved credential (the step at
  `usage-hyper-v.md:193-198` in normal setup). A credentials gap on an
  unconfigured guest, not a transport or firewall problem.

  A4 as originally written claimed the share would be *mountable*, so recording it
  as fully confirmed would overstate the evidence. SMB authentication, share-name
  access, and persistent-mount behaviour over the Default Switch remain untested
  and are folded into the manual setup checkpoint.

- **A6 — outstanding.** Cannot be tested until the DHCP server exists (Phase 2).
  It is the only assumption still open.

**Phase 0 is complete.** Every assumption that could be tested without new code
has been retired, and none of them sent a decision back for revision.

Incidental observation to verify during implementation: the guest's
`Resolve-DnsName` reported `DNS server failure` for an AAAA query, where the
intended behaviour is NOERROR with zero answer records. This is most likely how
that cmdlet surfaces an empty answer rather than a genuine defect — the same run
resolved `api.anthropic.com` successfully through the normal client path, which
attempts AAAA before A, and the existing `ConfigamatronDnsResponder` ships these
exact semantics today. The unit tests in Phase 1 must assert the response
**bytes** (ANCOUNT=0, RCODE=0) rather than rely on cmdlet reporting.

### Validation results — Phase 4 checkpoint (2026-07-23)

Run against the real environment at `c:\vm-isolated\.configamatron`: a Windows 11
guest (`DESKTOP-3VVGHIA`) with a **single** Hyper-V NIC, host `192.168.67.1/24` on
`configamatron-internal`, and `run-proxy` serving gateway, DNS and DHCP.

**Precondition correction, found before any result was recorded.**
`host-allow-vm-inbound.ps1` had never been run in this environment: the UDP/53 and
UDP/67 rules were absent, and the SMB rule present was the older manually-created
name. DNS and DHCP were nonetheless working — carried by a broad
interactive-prompt firewall rule (`node.exe`, inbound TCP **and** UDP, **any**
port, profile `Public`) created by a Windows "Allow" dialog. That rule was
deleted and the script run, so **every result below was recorded against the
documented firewall configuration**, not an incidental one. Worth noting because
the accidental rule perfectly masked the missing intended ones.

- **A6 — CONFIRMED.** Every DHCP lifecycle property held against a real Windows
  client.

  - **Replies reach an address-less client.** This is the specific unknown Phase 0
    could not reach — it proved only that a `DISCOVER` *arrives*. After
    `ipconfig /release`, `/renew` completed in seconds and returned
    `192.168.67.37` (inside the `.10`–`.209` pool) with the host as router **and**
    DNS. Full DORA to a client with no address works.
  - **Renewal.** The lease extended in place for a full 3600s, matching
    `leaseSeconds`; Windows retained the original `Lease Obtained` and advanced
    `Lease Expires`.
  - **Restart adoption.** `run-proxy` was stopped and restarted so its lease table
    came back **empty** while the guest still held `.37`. The guest's REQUEST was
    **ACKed with a full lease, not NAKed**, and the address was preserved — the
    adoption branch in `dhcpLeases.request` works against a real client.
  - **Late host start.** The guest was booted onto the isolated switch with nothing
    serving DHCP and fell back to APIPA (`169.254.146.134`). `run-proxy` was then
    started at `15:50:22` host local; the guest acquired `192.168.67.37`
    **unattended at `15:55:17` — 4m55s, with no console intervention.**
    Corroborated by the guest's own `Lease Obtained` (`15:55:16`) and by Windows'
    NCSI probes (`www.msftconnecttest.com`, `www.msftncsi.com`) appearing in the
    proxy log at that instant.

    **Recovery is bounded by the Windows client's APIPA retry timer (~5 minutes),
    not by the server.** Once a Windows DHCP client self-assigns `169.254.x.x` it
    re-attempts `DISCOVER` on roughly a five-minute cycle, and the guest recovered
    on its first retry after the server appeared. Nothing host-side can shorten
    this. Unattended recovery is therefore reliable but **not prompt** — the docs
    should say so, or a ~5-minute wait after an out-of-order boot will be mistaken
    for a failure.
  - **Address stability.** Across a release/renew, a server restart with an empty
    table, and a full shutdown → APIPA → late-start cycle, the guest landed on
    `192.168.67.37` every time. The identity-hash preference in
    `dhcpLeases.acquire` holds in practice, not just in unit tests.

- **A4 — CONFIRMED; the outstanding half is now closed.** With the guest moved to
  the Default Switch and a `cmdkey` credential saved for the Default Switch host
  IP, `net use \\172.22.208.1\vm-shared-windows` succeeded **without prompting for
  a password**, and the share listed correctly. That is the authenticated mount
  Phase 0 could not perform. `cmdkey` entries are per-address, so an entry
  separate from the Internal-switch one is required — this is the step at
  `usage-hyper-v.md` that the Phase 0 throwaway guest lacked.

  Negative control: in the NAT phase `Resolve-DnsName example.com` returned **real
  public addresses** (`172.66.147.243`, `104.20.23.154`) plus AAAA records — not
  `192.168.67.1` — confirming the guest was genuinely on ICS's resolver and the
  Internal-switch path was not still in play.

- **DNS and end-to-end.** `example.com`, `api.anthropic.com` and
  `totally-made-up.invalid` all answered `192.168.67.1` at **TTL 30**. The
  `.invalid` name is the load-bearing one: it has no real resolution anywhere.
  `Invoke-WebRequest https://api.anthropic.com` returned 404, and the Envoy access
  log recorded `CFGM|term|…|via_upstream|404` — `via_upstream` proving the response
  came from the **real** upstream rather than being generated locally, i.e. the
  full path (resolution → TLS against the proxy CA → credential injection →
  upstream) worked.

- **Blue/green.** Touching `allowlist.txt` swapped `configamatron-envoy-blue` →
  `-green` in ~6 seconds. Across 12 samples spanning the swap, **DNS answered every
  time and neither `192.168.67.1:53` nor `:67` ever dropped**, and guest traffic
  kept flowing mid-swap. This is structural rather than lucky: the swap replaces
  only the Envoy container, while DNS and DHCP live in the `run-proxy` process,
  which does not restart.

- **No warnings.** Zero warning, error, NAK or pool-exhaustion lines across the
  whole session, including both restarts and the swap.

**Decision 5 (host DHCP) is validated end to end. Phase 5 is unblocked.**

#### Findings and follow-ups from this checkpoint

1. **The DHCP server logs nothing per-transaction.** ACK-vs-NAK could not be
   observed host-side; the restart-adoption result rests on behaviour (address
   retained, exact 3600s extension) rather than direct evidence. A one-line log on
   ACK / NAK / adoption would make this checkpoint self-evidencing and is worth
   adding before anyone has to debug a client interop problem in the field.
2. **`templates/vm-shared-windows/verify-config.ps1:58` asserts a `403` that
   `gate.lua` can no longer produce.** The gate was deliberately changed (see
   `docs/investigations/2026-07-22-remote-control-session-token-rejected-by-claude-gate.md`)
   so a present, non-placeholder `Authorization` passes through unmodified; there
   is now no 403 path in `gate.lua` at all. Confirmed by the `via_upstream|404`
   log line. Pre-existing and unrelated to this design, but the verifier reports a
   false FAIL until fixed. `templates/vm-shared/verify-config.sh:203` has the same
   stale assertion.
3. **Live switch moves work but need a cache flush.** Reassigning the adapter
   without a shutdown does re-lease (faster than APIPA recovery, since link-up is
   an immediate trigger), but the guest can retain DNS answers from the previous
   network — ICS's real answers can carry long TTLs. `Clear-DnsClientCache` after
   the move resolves it. The documented procedure only covers the shutdown flow;
   this is worth documenting rather than leaving to be rediscovered.
4. **Nested virtualization in the guest adds a second adapter that is not a second
   NIC.** A guest with the Hyper-V role gets its own `vEthernet (Default Switch)`
   (description "Hyper-V Virtual Ethernet Adapter", as against "Microsoft Hyper-V
   Network Adapter" for a real vNIC). It is gateway-less and DNS-less, so it
   provides no egress path and does not compromise isolation — but its subnet
   regenerates across guest reboots (observed `172.22.112.1` → `172.29.160.1`),
   which is a live demonstration of why the design pins everything to the
   Internal-switch IP.
5. **Guest clock skew is cosmetic.** The guest ran two hours behind the host
   throughout. Lease expiry is computed host-side and the client's renewal timer is
   a relative interval, so neither depends on the clocks agreeing; only log
   correlation is affected.

**One caveat on coverage.** The return leg of the switch round trip was performed
as a *live* move plus `Clear-DnsClientCache` rather than the documented
shutdown-and-reassign, so the documented Default-Switch → Internal transition was
not re-exercised here. It is substantially covered by the late-host-start test,
which booted the guest onto the isolated switch and acquired a lease with no
guest-side action of any kind.

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

**Phase 3 — Host-side documentation only.** The parts of `usage-hyper-v.md` that
describe host setup: firewall rules and `run-proxy` startup moved ahead of the
guest scripts (decision 7), and the widened SMB scope (decision 6). These are true
regardless of which guest model is shipped, so they can land now.

**Phase 4 — Windows guest, with its documentation.** Delete the `dns-responder`
project and its wiring; the adapter stays on DHCP. Update `usage-windows-vm.md`
and the Windows half of the setup flow **in the same phase**. Behaviourally a
no-op from the guest's perspective — same answers, different source — and the
guest is already available, making this the lowest-risk guest phase and the
natural first end-to-end proof.

**Phase 5 — Ubuntu guest, with its documentation.** Delete the in-guest
DNS/DNAT/route layer and update the Ubuntu half of the setup flow in the same
phase. Larger deletion, and the harness work is concentrated here.

**Phase 6 — Remaining documentation.** `README.md`, `technical-notes.md`, and any
cross-cutting narrative that only becomes accurate once both guests have migrated.

An earlier draft put the entire setup-procedure rewrite in Phase 3, ahead of both
guest migrations. That was wrong: it would publish a DHCP-only, single-adapter
procedure while the shipped scripts still installed the in-guest responder and,
on Ubuntu, the DNAT rules — documentation contradicting the templates for two
phases. Splitting the docs so each guest's instructions land with its own template
change keeps the tree self-consistent at every phase boundary.

**Manual checkpoint after Phase 4 and again after Phase 5.** The guest-side phases
cannot be verified automatically: the VM test harness simulates the topology via
WSL rather than exercising a real Hyper-V guest. Each guest must be taken through
the full flow — NAT phase, scripts, shutdown, adapter reassignment, boot, and a
successful request to an allow-listed domain — before the work is considered done.
The Phase 4 checkpoint additionally covers the A6 items that need a real client:
full DORA, renewal, an authenticated SMB mount, a guest that boots *before*
`run-proxy` and then recovers, and a `run-proxy` restart while the guest holds a
lease.

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
  per decision 5. Packet parse/build, the lease table (preferred-address
  derivation, conflict resolution, expiry), and the message-type state machine
  kept as separate, independently testable units.
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

Testing is split across three layers with an explicit boundary, because no single
layer can cover both the protocol implementation and the Windows-specific
behaviour.

**Layer 1 — unit/protocol tests (`tests/unit/`), against the real modules.**
Table-driven, pure byte-array assertions, no network:

- DNS: A answers, AAAA → NOERROR/no-answer, other qtypes, RD preservation, the
  compression pointer, and the tightened grammar (multiple questions, non-IN
  class, invalid label lengths, a compression pointer in the question, a packet
  shorter than the header, EDNS additional records). Assert `ANCOUNT`/`RCODE`
  **bytes**, never a client cmdlet's interpretation.
- DHCP: option encoding, and each row of the state table in decision 5 — SELECTING,
  REQUESTING against us and against another server's option 54, INIT-REBOOT with
  option 50, RENEWING, REBINDING, `RELEASE`, `DECLINE`, `INFORM`. Plus reply
  destination selection (broadcast when `ciaddr` is zero, unicast when renewing),
  non-zero `giaddr` rejection, and malformed option streams.
- Lease table: two identities whose preferred address collides, concurrent
  `DISCOVER`s, pool exhaustion, expiry, restart with an outstanding offer, and a
  client requesting its previous address after a restart (ACK when in-range and
  free, NAK when not).

Remove `templates.test.ts` assertions covering `60-dns-override.yaml`, deleted.

**Layer 2 — the WSL/QEMU harness (`tests/vm/`), which keeps `dnsmasq`.** The
harness continues to run `dnsmasq` as a **stand-in** for the host services,
reconfigured to behave like them: hand out router and DNS pointing at the bridge
IP, and answer every name with that same address. What this layer verifies is the
**guest-side simplification** — that a guest configured only for DHCP, with no
in-guest resolver and no DNAT rules, reaches the proxy correctly.

It deliberately does **not** exercise the TypeScript DHCP/DNS implementation.
Running the production servers inside WSL would test them on Linux, whose
specific-IP broadcast binding differs from the Windows behaviour they are written
for, and would still not exercise Windows Firewall — high cost, misleading
fidelity.

Keeping `dnsmasq` also preserves something load-bearing that a naive rework would
have broken: `tests/vm/harness/guest.sh:7-11` derives each guest's SSH address by
looking up its MAC in `$RUN/dnsmasq.leases`. That lease file is the harness's
control channel for every `gexec` call. Replacing the harness DHCP server would
require reimplementing guest-IP discovery; retaining `dnsmasq` leaves it working
untouched.

Assertions that change: the `dnsmasq` stub answering the placeholder and the
in-guest `dnsmasq` service being active (`vm.test.ts:111-126`, `:198`), both
DNAT-rule assertions (`:123-126`, `:403-405`), and the `dig ... @127.0.0.1`
placeholder check (`:407-408`). These become: names resolve to the host IP, and no
NAT rules exist. Note the distinction the reworked tests must keep clear —
`dnsmasq` still runs *in the harness*, but no longer *in the guest*.

**Layer 3 — manual Hyper-V checkpoints.** The only layer that can cover
Windows-specific binding, firewall scoping, and real DHCP client interop (A6).
Enumerated under Phases.

## Documentation changes

Split across phases so the docs never contradict the shipped templates.

- **`usage-hyper-v.md`, host-side sections (Phase 3).** Move host firewall and
  `run-proxy` startup ahead of the guest scripts (decision 7). Document the
  widened SMB scope and the fact that the Default Switch address must be
  discovered with `ipconfig` rather than hardcoded, since Hyper-V regenerates that
  subnet across host reboots (decision 6). Keep the "one host IP threads through
  everything" framing, which now also covers DNS and DHCP — and make explicit that
  it applies to the **Internal-switch** IP only.
- **`usage-hyper-v.md`, guest-side flow + `usage-windows-vm.md` (Phase 4).**
  Replace the two-adapter setup with the single-adapter NAT-then-reassign flow for
  the Windows guest; remove the in-guest DNS responder steps; guests are DHCP
  throughout, so the static-IP instructions go. Document static addressing as the
  **manual recovery path** rather than the normal procedure.
- **`usage-hyper-v.md`, Ubuntu guest flow (Phase 5).** The same conversion for
  Ubuntu, landing with the template deletions.
- **`README.md`, `technical-notes.md` (Phase 6).** Update the numbered-script flow
  and rewrite the guest-networking sections: DNS and DHCP are host
  responsibilities; the DNAT layer is gone. Update the testing "fidelity gaps"
  paragraph — which currently forward-references this effort — to describe the
  three-layer boundary above, including that the harness no longer exercises the
  production DHCP/DNS code.
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
- **Manual, DHCP lifecycle** (the A6 items no automated layer can reach):
  - full DORA on a cold boot, and a renewal observed at T1
  - a guest booted **before** `run-proxy`, which then acquires a lease once
    `run-proxy` starts, with no console intervention
  - `run-proxy` restarted while the guest holds a lease — the guest keeps working
    and its renewal is ACKed, not NAKed
  - DNS and DHCP stay available across an Envoy blue/green restart
  - an **authenticated** SMB mount over the Default Switch, closing the part of A4
    that Phase 0 left open
  - a guest moved back onto `configamatron-internal` takes a lease from
    `run-proxy` — the direction Phase 0 could not test

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
- Every A query from a guest resolves to the host IP, so a host-served name
  becomes reachable once a listener and a firewall rule are separately configured.
  (An earlier draft made *actual* arbitrary-port reachability a completion
  criterion. That was wrong: the per-port firewall rule and the 80/443 routing
  question are explicitly out of scope, so the criterion could not be met by the
  work this spec describes.)
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

- **The DHCP reply path is the remaining load-bearing unknown.** Phase 0 confirmed
  that a guest's `DISCOVER` *arrives* at a specific-IP bind. It did **not** confirm
  that an `OFFER`/`ACK` sent from that socket reaches a client which still has no
  address — the case that requires broadcasting to `255.255.255.255:68`. Together
  with client interop, renewal, and post-restart behaviour, this is what A6 covers
  and what the Phase 4 checkpoint must exercise before Phase 5 proceeds. If it
  fails, decision 5 collapses and the design reverts to static addressing, with the
  brick risk and the write-before-shutdown step returning.
- **DHCP client interop.** A server bug presents as "guest has no address" — the
  same class of failure static configuration risked, relocated from a typo to our
  code, and now affecting the SMB mount and network administration too. Mitigated
  by static configuration remaining a supported manual fallback: if DHCP
  misbehaves, console in and set an address by hand.
- **The VM test harness rework.** Reduced by the layering above — retaining
  `dnsmasq` as the harness DHCP/DNS stand-in preserves the `dnsmasq.leases`
  control channel and sidesteps WSL's `:67` constraint (`tests/vm/wsl.ts:71-84`).
  The residual risk is fidelity: this layer no longer exercises the production
  DHCP/DNS code at all, so a defect there can only be caught by unit tests or the
  manual checkpoints.
- **Host process liveness is now a guest dependency.** Accepted per decision 7,
  which now specifies the recovery contract. `run-proxy` is a foreground command,
  not a service, so a crash or host reboot leaves guests without DNS and
  eventually without leases; running it as a supervised service is noted as
  follow-on.
- **Rogue or competing DHCP.** Nothing authenticates a DHCP server. Another server
  appearing on the Internal switch could be preferred by a client, and a
  carelessly widened bind or firewall rule could make *ours* answer on a network
  it does not own. Mitigated by strict interface-scoped firewall rules, binding
  the specific adapter IP rather than a wildcard, and validating the local address
  each packet arrived on (decision 5).
- **Widened SMB exposure is broader than "host-local".** Decision 6 accepts it on
  the basis that the share holds no secrets, which remains true — but other VMs
  and containers on the Default Switch can now *attempt authentication* against
  it, and `configamatron-share` is a real credential even if the content it
  guards is placeholders. Share and NTFS permissions must both be read-only, and
  the account's scope should be documented so it is not mistaken for an
  unprivileged one.
