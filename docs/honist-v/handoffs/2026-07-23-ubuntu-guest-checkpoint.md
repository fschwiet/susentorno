# Handoff: Ubuntu guest checkpoint (host-side DNS consolidation)

**Written:** 2026-07-23
**Branch:** `host-side-dns`
**Blocked on:** a real Ubuntu guest under Hyper-V. Everything that could be done
without one is done.

## What this is

The host-side DNS consolidation (plan:
`docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md`) is implemented
through Task 19's documentation. Both guests' in-guest DNS/DNAT/route layers are
deleted; `run-proxy` now serves DHCP and DNS from the host.

The **Windows** guest was validated end to end on real hardware. The **Ubuntu**
guest half is written but **has never been run**. That is what remains.

## State of the branch

```
9744811  fix: serve DNS from the harness bridge in gateway-less mode (+ this handoff)
a4376e9  docs: close the host-side DNS consolidation investigation
1866e3d  test: fail fast when run-proxy is holding the Envoy stack
b0b03b1  docs: single-adapter DHCP flow for the Ubuntu guest        (Task 19, docs half)
20e894f  test: model the host-resolver topology in the VM harness   (Task 18)
0d2e691  feat: remove the in-guest Ubuntu DNS, DNAT and route layer (Task 17)
47651a5  fix: assert the credential gate's current pass-through contract
a810ee5  docs: record A6 validation results from the Windows checkpoint (Task 16)
```

Both suites were green at `9744811`: `pnpm test`, and `pnpm test:vm` at **22
passed / 22**. So the Ubuntu guest-side changes *do* have automated coverage —
what they lack is a run against a real Hyper-V guest.

Getting there took three fixes to the harness, all leftovers from the old
in-guest-resolver topology, and worth knowing about if you touch `net.sh`:
`port=0` had dnsmasq serving DHCP with **DNS disabled** while advertising itself
as the resolver; no `no-resolv` meant AAAA queries were forwarded to WSL's real
resolver, so an "isolated" guest received genuine public addresses; and the
assertions used `getent hosts`, which lists AAAA first and so compared against an
IPv6 address (all four call sites now use `ahostsv4`).

> **If you follow plan Task 18 again, note it is internally inconsistent.** Step 1
> adds the resolve-to-host catch-all to the `hostonly` branch only, but step 2
> puts a `BRIDGE_IP` resolution assertion in the S1/NAT-phase block, which runs in
> `gateway` mode and forwards upstream. S1 now asserts the opposite — that names
> resolve for real and *not* to the bridge — which is what the real Windows guest
> did on the Default Switch.

## The environment

| | |
|---|---|
| Environment dir | `c:\vm-isolated\.configamatron` |
| Run `run-proxy` from | `c:\vm-isolated` |
| Internal switch | `configamatron-internal` |
| Host IP | `192.168.67.1/24` |
| DHCP pool | `192.168.67.10` – `.209` |
| Ubuntu share | `\\192.168.67.1\vm-shared` |
| Share account | `configamatron-share` |
| Default Switch host IP | `172.22.208.1/20` (regenerates across **host** reboots — re-check it) |

Two operational rules learned the hard way:

- **`run-proxy` must be running before the guest boots.** It is the guest's only
  DHCP server and only resolver.
- **Stop `run-proxy` before `pnpm test:vm`.** They both manage the same
  docker-compose Envoy stack and clobber each other. There is now a `globalSetup`
  guard that fails fast on this, but it is easier to just stop it first.

## What remains

### 1. Run the Ubuntu manual checkpoint (plan Task 19, step 4)

Full flow: guest on **Default Switch** → run the numbered scripts (direct
internet, share mounted) → shut down → reassign the **single** adapter to
`configamatron-internal` → boot with `run-proxy` already running.

The guest stays on **DHCP throughout**; there is no static IP and no netplan
drop-in any more. See `usage-hyper-v.md` section 5.

Then, in the guest:

```bash
ip -4 addr                        # address in 192.168.67.10-.209
ip -4 route show default          # default via 192.168.67.1, proto dhcp
resolvectl status                 # DNS = 192.168.67.1, and only that
getent hosts example.com          # -> 192.168.67.1
sudo iptables -t nat -S OUTPUT    # no DNAT rules
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com
sudo apt-get update
bash /mnt/vm-shared/verify-config.sh 192.168.67.1
```

Expected: an address from the pool, the host as default route and sole resolver,
names resolving to the host, no NAT rules, `curl` returning an HTTP status (a
**4xx is success** — it means transport worked), `apt-get update` succeeding, and
`verify-config.sh` reporting no failures.

### 2. Verify `verify-config.sh` actually runs

**This is the highest-risk item and deserves attention beyond a pass/fail
glance.** `templates/vm-shared/verify-config.sh` was substantially rewritten in
Task 17 and has only ever been **syntax-checked** (`bash -n`). It has never been
executed against anything.

What changed, and therefore what is most likely to be wrong:

- **Host-IP discovery was rewritten.** It used to parse the DNAT rules; those are
  gone, so it now reads the DHCP-supplied default route:
  `ip -4 route show default | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -n1`.
  If that sed does not match the real route format, every downstream check
  degrades — the script reports `host IP determinable` FAIL and then compares
  against an empty `host_ip`.
- **Three checks were inverted** to assert the deleted layer is *absent*: no
  in-guest dnsmasq, no DNAT rules, no `configamatron-egress.service`.
- **Two new positive checks**: `getent hosts example.com` resolves to the host,
  and `resolvectl dns` mentions the host. The `resolvectl dns` grep is a plain
  substring match and is the most likely to be brittle.
- Unchanged and expected to still pass: CA trust, `NODE_EXTRA_CA_CERTS`, git
  `sslBackend`, placeholder credential, live egress.

Run it and read every line, not just the summary count.

### 3. Record the results

Append to the spec's validation-results section, alongside the Windows
checkpoint already recorded there:

`docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`
→ "Validation results — Phase 4 checkpoint (2026-07-23)" is the model to follow.

Record failures as failures. Then:

```bash
git add usage-hyper-v.md docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md
git commit -m "docs: record the Ubuntu guest checkpoint result"
```

Also update `docs/investigations/2026-07-22-host-side-dns-consolidation.md`,
whose Outcome section currently ends with "**Not yet closed:** the Ubuntu guest
half has been implemented but never run on a real Ubuntu VM."

## Things to know before you start

**A 4xx from `api.anthropic.com` is success.** It means DNS resolved to the
proxy, TLS completed against the proxy CA, and the request was transported. We
are testing transport, not authorization.

**`Resolve-DnsName`-style AAAA confusion does not apply on Linux**, but the
underlying behaviour does: the responder returns NOERROR with **zero answer
records** for AAAA and every non-A qtype, deliberately, so callers fall back to
A. Do not read an empty AAAA answer as a failure.

**Recovery after an out-of-order boot is slow but automatic.** If the guest boots
before `run-proxy` is up it will self-assign an APIPA address and then pick up a
lease on its own once the server appears. On Windows that took **4m55s**, bounded
by the client's retry timer rather than by anything host-side. Linux DHCP clients
back off differently and this has not been measured — worth timing.

**One pre-existing failure is expected and unrelated**, if you run the Windows
verifier: nothing. That one was fixed in `47651a5`. But note the same
credential-gate assertion exists in `templates/vm-shared/verify-config.sh` and
**was** updated — it now probes `/v1/models` and asserts `>= 400`, because `/`
answers 404 regardless of credential and so cannot distinguish a rejected
credential from an injected one.

## What is deliberately NOT in scope

- Re-validating the Windows guest. Done, recorded in the spec.
- The `run-proxy` DHCP/DNS servers themselves. Validated on Windows; the Ubuntu
  run exercises the same servers from a different client.

## Known gaps worth fixing if you have appetite

Carried forward from the Windows checkpoint, none blocking:

1. **The DHCP server logs nothing per-transaction.** ACK-vs-NAK is not observable
   from the host, so the restart-adoption result rests on behaviour rather than
   direct evidence. A one-line log on ACK / NAK / adoption would make the next
   checkpoint self-evidencing.
2. **Firewall confinement depends on an unasserted host setting.** See
   `docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`
   — the suggested fixes are `-LocalAddress` scoping on the allow rules (except
   DHCP `:67`, which is broadcast) and asserting strong-host + no-forwarding in
   `verify-proxy.ps1`.
3. **`usage-windows-vm.md`** was never revisited for the single-adapter flow
   (plan Task 15 step 4 was only partly applied).
