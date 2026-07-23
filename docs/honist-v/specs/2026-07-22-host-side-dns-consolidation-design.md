# Host-side DNS consolidation

**Date:** 2026-07-22
**Status:** Approved for planning
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

Both guests reduce to the same contract: **static IP + `nameserver = <host-ip>` +
trust the proxy CA.**

## Verified premise

The investigation that proposed this work flagged one blocking unknown: whether
the host can bind `<host-ip>:53` while another process holds wildcard
`0.0.0.0:53`. This was tested on the host and **answered affirmatively**; full
method and results are in
`docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md`.

Summary of what was established:

- The wildcard `0.0.0.0:53` holder on the host is the **`SharedAccess` (Internet
  Connection Sharing)** service, as predicted.
- A specific-IP bind to `192.168.67.1:53` **succeeds** for both UDP and TCP,
  unelevated, with no special socket options — while a control attempt to bind
  `0.0.0.0:53` correctly **fails** with `AddressAlreadyInUse`. The control is what
  makes the result meaningful: the conflict is real, and specific-IP binding is
  what escapes it.
- A live responder bound to `192.168.67.1:53` **received every query** addressed
  to that IP, including for names ICS could have resolved for real. The more
  specific bind wins packet delivery; ICS does not intercept.

Consequence: no fallback is needed. ICS does not have to be reconfigured or
disabled.

The original VMware-era obstacle is also gone, and for a different reason than
the port conflict: under VMware, the guests reached the host through VMware's own
network endpoint, and VMware bound `:53` on that endpoint to serve its NAT. The
dedicated `configamatron-internal` Internal switch is an endpoint this project
controls, with no competing binder on it.

## Scope

**In scope:**

- `src/runProxy/` — new DNS responder module; `src/commands/runProxy.ts` wiring
- `templates/proxy/host-allow-vm-inbound.ps1`, `templates/proxy/verify-proxy.ps1`
- `templates/vm-shared/pre-scripts/` — `nn-configure-network.sh`,
  `dnsmasq-stub.conf`, `configamatron-egress.service`, `60-dns-override.yaml`
- `templates/vm-shared-windows/pre-scripts/` — `nn-configure-network.ps1`, the
  `dns-responder/` project and its build wiring
- `templates/vm-shared/verify-config.sh`
- `tests/unit/**` affected by the above; `tests/vm/` harness and assertions
- `README.md`, `usage-hyper-v.md`, `usage-windows-vm.md`, `technical-notes.md`
- **The documented VM setup procedure** — this effort changes it (see decision 4)

**Explicitly out of scope:**

- **Host-served names.** Making servers on the host reachable from guests by name
  on arbitrary ports is the motivating follow-on, and this work is a prerequisite
  for it, but the routing/firewall/Envoy questions it raises are deferred to their
  own cycle. See "Follow-on work".
- **Reversible network isolation.** Likewise deferred. This design deliberately
  does *not* build a toggle; see decision 4 for why the setup procedure
  nonetheless moves toward it.
- **Building a real DNS resolver.** The responder remains a catch-all stub.
- **Changing Envoy, the allowlist, or the blue/green color machinery.**
- **VMware support.** Dropped, not carried forward. VMware guests could in
  principle conform to the new topology, but that path is not verified and the
  code for it is not retained.
- `docs/superpowers/**`, `docs/honist-v/**`, `legacy/**` — point-in-time records.

## Design decisions

### 1. Responder lives in `run-proxy`, in-process (decided)

A new `src/runProxy/dnsResponder.ts` exposing
`startDnsResponder(opts): Promise<DnsResponderHandle>` with a `close()`,
deliberately mirroring the shape of `startGateway` in `src/runProxy/gateway.ts`
so `runProxy.ts` supervises it on the lifecycle it already has.

The original host-side DNS stub (`scripts/host-dns-stub.js`) was removed by
`docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md` because it was a script
the user had to "leave running in its own terminal" — an operational objection,
not a technical one. That objection no longer applies: `run-proxy` is a
supervised, long-lived host process that already resolves the Internal-switch
adapter IP and already listens on it. This design does not reintroduce a manual
step.

Rejected: **(b) a separate host process/service** — reintroduces exactly the
supervision problem that motivated moving DNS into the guests in the first place.
**(c) reuse the compiled `ConfigamatronDnsResponder` .NET exe on the host** —
keeps a second language and a build artifact in the tree for ~40 lines of packet
construction, and its config-file indirection is unnecessary once the bind IP and
the answer IP are the same value.

### 2. Wire semantics ported verbatim from the existing responder (decided)

The response format is ported from
`templates/vm-shared-windows/pre-scripts/dns-responder/Program.cs`, which is
proven against real guest resolvers. It is re-implemented in TypeScript, not
redesigned:

- Echo the 2-byte transaction ID; QR=1, **preserve RD**, RA=0, RCODE=0 (NOERROR)
- `QDCOUNT=1`; `ANCOUNT=1` **only** when `QTYPE=A` (1), otherwise `0`
- `NSCOUNT=0`, `ARCOUNT=0`
- Echo the question section verbatim
- For A: name compression pointer `0xC00C`, TYPE `A`, CLASS `IN`, **TTL 30**,
  RDLENGTH 4, RDATA = the host IP
- Malformed query (fewer than 12 bytes, or a question that runs past the end of
  the buffer): reply with QR=1 and no answer records

Answering AAAA with NOERROR/no-answer rather than NXDOMAIN is load-bearing:
callers fall back to A instead of concluding the name does not exist.

**UDP only.** TCP/53 was verified bindable, but responses are ~50 bytes and never
approach truncation, and both current in-guest responders are UDP-only in
production. Adding a TCP listener is speculative; revisit only if a resolver is
observed retrying over TCP.

The answer decision is isolated in a pure function (`answerFor(qname, qtype)`)
separate from packet construction. Today it ignores `qname` and always returns the
host IP. This is for testability and to give the host-served-names follow-on a
single obvious seam — it is **not** claimed to enable reversible isolation, which
is achieved by other means (decision 4).

### 3. Bind address, answer address, and lifecycle coupling (decided)

The responder binds the Internal-switch adapter IPv4 obtained from the existing
`resolveForwardListenAddress()` in `src/runProxy/forwarder.ts` — the same call the
gateway already uses. **The answer IP is the bind IP**; there is no separate
configuration value and no `responder-config.txt` analogue.

The responder starts under exactly the condition the gateway's Internal-switch
listener starts under: forwarding enabled. Both mean "serve the Internal switch",
so one condition governs both, and `--forward-listen <ip>` moves them together.

**No `--no-dns` flag.** There is no state in which forwarding is wanted but DNS is
not: a guest on `configamatron-internal` requires the host resolver, and a guest
on a NAT adapter uses that adapter's DHCP DNS and ignores the host responder
entirely — the responder sitting idle does no harm. A flag with no use case is
not added.

**Bind failure is fatal and loud**, matching the gateway's handling in
`src/commands/runProxy.ts:142-146`. A silently-absent DNS listener is precisely
the failure that strands a migrated guest, so it must never degrade quietly.

### 4. One active network adapter at a time (decided)

**This is the decision with the largest blast radius, and it changes the
documented VM setup procedure.**

Today, setup runs with **two** adapters attached: the permanent
`configamatron-internal` adapter and a temporary Default Switch (NAT) adapter for
internet access. Isolation happens afterward by removing the NAT adapter and
rebooting.

Two simultaneous adapters means two simultaneous resolvers. Once the guest's DNS
points at the host, `systemd-resolved` would race the host responder against the
NAT adapter's DHCP-supplied DNS and take whichever answered first —
nondeterministically proxied or direct. Suppressing that race is the *entire*
reason `templates/vm-shared/pre-scripts/60-dns-override.yaml` exists in its
current form (the `dhcp4-overrides.use-dns: false`, the NetworkManager
`ipv4.ignore-auto-dns` passthrough, and the explicit `dhcp4: true` that forces the
drop-in to describe the DHCP interface at all).

Instead, restructure setup so **only one adapter is ever active**:

1. **NAT phase.** The VM's single network adapter is connected to Hyper-V's
   Default Switch. DHCP, real DNS, real internet. All internet-dependent work
   happens here: OS install, apt packages, pnpm, tools.
2. **Last step before shutdown.** Write (do not apply) the static network
   configuration for the isolated network: static IP, **no gateway**,
   `nameserver = <host-ip>`. Applying it while on NAT would sever internet
   immediately; it takes effect on next boot.
3. **Shutdown.** Reassign that same adapter to the `configamatron-internal`
   switch (`Connect-VMNetworkAdapter -SwitchName`).
4. **Isolated phase.** Boot. The guest comes up with the static IP and the host
   resolver, mounts the SMB share, and runs the remaining (non-internet)
   configuration scripts.

Consequences:

- `60-dns-override.yaml` is **deleted outright**, not reduced to a stub. There is
  never more than one resolver, so there is nothing to suppress.
- The interface-discovery block in `nn-configure-network.sh` (locating the
  default-route interface to aim the DNS override at) is deleted: the target is
  the one known static interface.
- **Reassigning the existing adapter's switch, rather than adding/removing an
  adapter, is deliberate.** The guest keeps the same virtual NIC across the
  transition, so the interface name stays stable and both the netplan interface
  reference and the Windows adapter alias remain valid.
- This is not more steps than today. The current flow already requires removing an
  adapter and rebooting; this replaces that with reassigning one adapter and
  rebooting.
- The setup procedure and the future reversible-isolation mechanism become the
  same mechanism, exercised once. Reversibility is *not* built here, but nothing
  in this design has to be undone to build it.

**Known wrinkle, must be handled explicitly:** the Internal switch runs no DHCP,
and the SMB share that carries the configuration scripts is served over that same
network. A guest that boots into the isolated phase still configured for DHCP gets
no address, and therefore cannot mount the share to fix itself. This is why step 2
is mandatory and why it precedes the shutdown. On Ubuntu the static file must now
actively override the installer's DHCP profile for that same interface
(`dhcp4: false`), where previously it merely described a separate second adapter.

Mitigations: validate the config parses before shutting down (`netplan generate`
on Ubuntu); document the Hyper-V console as the recovery path, since it is the
only way in if the static config is wrong.

Rejected: **(b) keep two adapters and retain DHCP-DNS suppression** — preserves
the most fragile file in the guest layer and leaves a nondeterministic window
during setup. **(c) keep two adapters and accept the race** — nondeterministic
setup behavior is how flaky, hard-to-reproduce bug reports are manufactured.

### 5. Host readiness precedes isolated boot (decided)

Because the guest's only resolver is now the host, `run-proxy` and the inbound
firewall rule must be running **before** the VM is booted into the isolated phase.
`usage-hyper-v.md` currently documents the host firewall/`run-proxy` step *after*
the guest scripts; that ordering is moved earlier.

This concentrates the ordering requirement into a single, statable precondition —
"have `run-proxy` up before booting the isolated VM" — rather than an interleaving
constraint spread across the script sequence.

Accepted tradeoff: guest DNS availability is now coupled to a host process being
up. Previously a down proxy failed at connect time ("connection refused"); it now
fails at resolution ("could not resolve host"). The failure is equally fast but
presents differently, which is why decision 6 adds a listener check.

### 6. Firewall rule and verification (decided)

`templates/proxy/host-allow-vm-inbound.ps1` re-adds an inbound **UDP/53** allow
rule, scoped with `-InterfaceAlias` exactly as the existing TCP 80/443 rule is,
and drops the stale-rule cleanup for `Envoy Sandbox Proxy DNS stub (VM inbound)` —
that rule stops being stale and becomes current again. This re-adds what
`docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md` removed, under the same
rule name.

The rule is required, not optional: the Internal-switch adapter is categorized
**Public**, all firewall profiles are enabled, and `DefaultInboundAction` resolves
to **block**. Pre-existing `HNS Container Networking - DNS (UDP-In)` rules may
incidentally permit the traffic on some hosts, but they are created by container
networking and may be removed by it; this design does not rely on them.

`templates/proxy/verify-proxy.ps1` gains a check that a UDP listener is present on
`<host-ip>:53`, so a missing responder is diagnosable rather than presenting as
mysterious guest-side resolution failures.

### 7. Where the numbered setup scripts run (**assumption — needs confirmation**)

Decision 4 has a consequence that the two-adapter setup currently hides, and it
must be resolved before Phase 2 is planned in detail.

The SMB share carrying the numbered scripts is served over the
`configamatron-internal` network and is deliberately scoped to that adapter
(`usage-hyper-v.md:57`, "never expose it on the external NIC"). Today the guest
holds **both** adapters at once, so it has internet via NAT *and* the share via
the Internal switch simultaneously. That is what lets
`01-apt-packages.sh` / `02-install-pnpm.sh` / `03-install-tools.sh` — which live
on the share but download from the internet — work at all.

With one adapter active at a time, those two resources are never available
together:

- **NAT phase:** internet, but the share is unreachable.
- **Isolated phase:** the share, but internet only *through the proxy*.

**Assumption taken for this spec:** the numbered scripts run in the **isolated
phase**, with their downloads flowing through the Envoy proxy. The NAT phase is
reduced to OS installation plus writing the static network config by hand — a
single file, which needs no share access.

This is coherent with the project's design (the proxy is the sanctioned egress
path) but it is a **behavior change with real risk**: today those installs go
direct via NAT and never touch the allowlist. Routing them through the proxy means
the allowlist must cover the Ubuntu archives, the npm registry, and every tool
download endpoint `03-install-tools.sh` reaches. Allowlist gaps that are invisible
today would become setup failures.

Alternatives, if that assumption is rejected:

- **(b) Temporarily expose the share on the Default Switch during the NAT phase.**
  Keeps installs on the direct path, at the cost of briefly serving SMB on the NAT
  network — which the current docs explicitly warn against.
- **(c) Deliver the scripts into the guest by another channel during the NAT
  phase** (ISO, `virtio`/Enhanced Session copy, git clone over NAT). Keeps installs
  direct and the share internal-only, at the cost of a clunkier procedure.
- **(d) Retain the two-adapter setup solely for the install window.** Reintroduces
  the resolver race that decision 4 exists to eliminate, and would bring
  `60-dns-override.yaml` back. Not recommended.

## Phases

One spec, one plan, implemented sequentially. The phases are execution structure,
not separate cycles: no phase needs external sign-off before the next begins,
with the single exception of the real-guest checkpoint noted after Phase 3.

**Phase 1 — Host responder and firewall.** `dnsResponder.ts`, `runProxy.ts`
wiring, the UDP/53 firewall rule, the `verify-proxy.ps1` check. Purely additive:
no guest changes, guests keep working on their in-guest responders throughout.
Fully verifiable on the host without a VM.

**Phase 2 — Setup procedure revision.** Rework `usage-hyper-v.md` (and the guest
docs that reference it) to the single-adapter, NAT-then-switch flow, with the host
readiness step moved ahead of the guest scripts. **Depends on decision 7 being
confirmed**, which determines where the numbered scripts run and therefore what
the procedure says.

**Phase 3 — Ubuntu guest.** Delete the in-guest DNS/DNAT/route layer; the static
netplan file becomes the whole network configuration.

**Phase 4 — Windows guest.** Delete the `dns-responder` project and its wiring;
point the adapter's DNS at the host. Behaviourally a no-op for the guest — same
answers, different source — making it the lowest-risk phase.

**Manual checkpoint after Phase 3.** The guest-side phases cannot be verified
automatically: the VM test harness simulates the topology via WSL rather than
exercising a real Hyper-V guest. A real Ubuntu guest must be taken through the
full flow — NAT phase, static config written, shutdown, adapter reassigned, boot,
`curl` to an allow-listed domain, `apt-get update` — before Phase 4 begins.

Ordering rationale: Phase 1 must land before any guest depends on it, and the
host responder must be *proven reachable from a guest* before Phase 3 removes the
in-guest fallback. A guest whose DNS query is silently dropped by the firewall has
no resolver and no DNAT fallback, and recovery requires console access.

## Implementation changes

### Host

- **`src/runProxy/dnsResponder.ts`** (new) — `startDnsResponder` /
  `DnsResponderHandle` / `close()`, per decisions 1–3. Packet construction and
  `answerFor` policy kept as separate, independently testable units.
- **`src/commands/runProxy.ts`** — start the responder alongside the gateway when
  forwarding is enabled, using the same resolved IP; fail loudly on bind error;
  close it on shutdown. Log the DNS listener alongside the existing gateway
  listen line.
- **`templates/proxy/host-allow-vm-inbound.ps1`** — add the interface-scoped
  inbound UDP/53 rule; remove the stale-rule cleanup; update the header comment
  (which currently explains why the UDP/53 rule was removed).
- **`templates/proxy/verify-proxy.ps1`** — add the `<host-ip>:53` UDP listener
  check.

### Ubuntu guest (`templates/vm-shared/pre-scripts/`)

- **`dnsmasq-stub.conf`** — delete.
- **`configamatron-egress.service`** — delete. Both DNAT rules and the guarded
  default-route install go with it; nothing needs redirecting once names resolve
  to the host.
- **`60-dns-override.yaml`** — delete (decision 4).
- **`nn-configure-network.sh`** — drop the `dnsmasq` install, the stub-config
  copy, the egress unit templating/enable, the interface-discovery block, and the
  netplan-override install. What remains is CA trust (system store,
  `NODE_EXTRA_CA_CERTS`, Firefox policy) — the network portion reduces to the
  static config written during the NAT phase.
- **`verify-config.sh`** — update checks that assert DNAT rules, `dnsmasq`, and
  the placeholder resolution; assert instead that names resolve to the host IP.

### Windows guest (`templates/vm-shared-windows/pre-scripts/`)

- **`dns-responder/`** — delete the project (including the checked-in `obj/`
  build output).
- **`nn-configure-network.ps1`** — remove the `responder-config.txt` write and the
  Scheduled Task registration; replace the loop that points every up adapter at
  `127.0.0.1` with a single `Set-DnsClientServerAddress` on the Internal-switch
  interface pointing at the host IP.
- Remove the `isDnsResponderBuildArtifact` build wiring and any packaging that
  ships the responder into the share.

### Tests

- **`tests/unit/`** — new table-driven tests for the responder: A answers, AAAA →
  NOERROR/no-answer, non-A qtypes, RD preservation, malformed input, and the
  compression pointer. These are pure byte-array assertions. Update
  `templates.test.ts` where it asserts `60-dns-override.yaml` content
  (`use-dns` / passthrough) — those assertions are deleted with the file.
- **`tests/vm/`** — the harness currently models a NAT network plus a gateway-less
  **DHCP** network with an in-guest resolver. It is re-modeled toward a
  gateway-less **static** network with the resolver on the harness "host" side.
  Assertions that change: the `dnsmasq` stub answering the placeholder and the
  `dnsmasq` service being active (`vm.test.ts:111-126`, `:198`), both DNAT-rule
  assertions (`:123-126`, `:403-405`), and the `dig ... @127.0.0.1` placeholder
  check (`:407-408`). These become: names resolve to the host IP, and no DNAT
  rules exist.

  This is the largest and least certain piece of the work. It is carried in the
  guest phases rather than split out, because the assertions are guest-specific
  and a harness change alone cannot be validated.

## Documentation changes

- **`usage-hyper-v.md`** — the substantive rewrite. Replace the two-adapter setup
  (`Add a second network adapter` / `remove the temporary Default Switch adapter`)
  with the single-adapter NAT-then-reassign flow. Move the host firewall and
  `run-proxy` startup ahead of the guest scripts (decision 5). Document writing
  and validating the static config before shutdown, and the Hyper-V console as
  the recovery path. Keep the "one host IP threads through everything" framing,
  which is unchanged and now also covers DNS.
- **`usage-windows-vm.md`** — update the guest flow for the new phase boundary;
  remove the in-guest DNS responder steps.
- **`README.md`** — update the numbered-script flow and any guest-network
  description that references the DNAT/stub model.
- **`technical-notes.md`** — rewrite the guest-networking sections: DNS is now a
  host responsibility; the DNAT layer is gone. Update the testing "fidelity gaps"
  paragraph, which currently forward-references this effort.
- **`docs/investigations/2026-07-22-host-side-dns-consolidation.md`** — mark
  resolved, pointing at this spec and at the port-53 investigation. Its "Key
  unverified risk" section is now answered.

## Verification

- `pnpm test` must pass — the full pipeline in `package.json`: `format:check`,
  `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration`
  (needs Docker).
- `pnpm test:vm` must pass with the re-modeled harness.
- On the host, with `run-proxy` running: `Get-NetUDPEndpoint -LocalPort 53` shows
  the responder on `<host-ip>:53` coexisting with the ICS wildcard, and
  `Resolve-DnsName -Name <any-name> -Server <host-ip>` returns `<host-ip>`.
- `verify-proxy.ps1` passes, including the new DNS listener check.
- Repo-wide grep confirms no live references remain to `dnsmasq`,
  `configamatron-egress`, `60-dns-override`, `ConfigamatronDnsResponder`, or
  `isDnsResponderBuildArtifact` outside `docs/superpowers/**`,
  `docs/honist-v/**`, `docs/investigations/**`, and `legacy/**`.
- **Manual, real Ubuntu guest** (the Phase 3 checkpoint): full flow through
  adapter reassignment and boot; `curl` to an allow-listed domain succeeds;
  `apt-get update` succeeds; `resolvectl status` shows the host IP as the only
  DNS server; no iptables NAT rules present.
- **Manual, real Windows guest**: same connectivity checks; no
  `ConfigamatronDnsResponder` scheduled task present.

## Success criteria

- Exactly one fake DNS responder exists in the project, and it runs on the host
  under `run-proxy`.
- Both guests' network configuration reduces to static IP, `nameserver =
  <host-ip>`, and proxy CA trust. No in-guest DNS service, no DNAT rules, no
  default-route hack, no DHCP-DNS suppression.
- Guests never have more than one network adapter active.
- Guest traffic reaches the proxy with SNI intact, exactly as the Windows guest
  achieves today; the Ubuntu and Windows network models are identical.
- A host server on an arbitrary port is reachable from a guest by name at
  `<host-ip>:<port>` — the capability this unblocks, even though exposing
  specific services is follow-on work.
- The full verification pipeline passes, and both manual guest checkpoints pass.

## Follow-on work

- **Host-served names.** Now unblocked but not designed here. Under the current
  model every name already resolves to the host, so a host service on a
  non-conflicting port is reachable once a firewall rule permits it. The open
  questions are how services on **80/443** are distinguished from names that
  should be proxied upstream (Envoy would route by SNI/Host to a local backend),
  and how those rules are configured. Worth its own cycle.
- **Reversible network isolation.** Achieved by reassigning the VM adapter between
  the Default Switch and `configamatron-internal`, paired with a guest-side switch
  between DHCP and static configuration. This spec makes it the same mechanism as
  setup, but builds no toggle.
- **TCP/53.** Add only if a resolver is observed falling back to TCP.

## Risks

- **Setup-time installs may move onto the proxy path** (decision 7). If the
  assumption there stands, `apt-get`, pnpm, and tool downloads stop going direct
  via NAT and start traversing the Envoy allowlist during setup. Allowlist gaps
  that are currently invisible would surface as setup failures. This is the
  highest-uncertainty item in the spec and should be settled before Phase 2 is
  planned.
- **The VM test harness re-modeling is the least certain piece.** It currently
  emulates a DHCP-based gateway-less network; moving it to a static network with a
  host-side resolver may surface WSL networking constraints comparable to the
  existing `ignoredPorts=67` workaround for the Default Switch's DHCP bind.
- **Misconfigured static config strands the guest.** Mitigated by validating
  before shutdown and by documenting console recovery — but the failure mode is
  real and the recovery is manual.
- **Host process liveness is now a guest dependency.** Accepted per decision 5,
  mitigated by the `verify-proxy.ps1` check and the fatal-on-bind-failure
  behavior.
