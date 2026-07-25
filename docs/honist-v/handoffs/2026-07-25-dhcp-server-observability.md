# Handoff: DHCP server observability

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Blocked on:** nothing. Pure addition to `run-proxy`, verifiable by unit test.

## What this is

`run-proxy`'s DHCP server logs nothing per-transaction. It announces the listener
at startup and then goes silent:

```
run-proxy: DHCP server listening on 192.168.67.1:67 (router and DNS -> 192.168.67.1, mask 255.255.255.0)
```

ACK versus NAK is therefore **not observable from the host**. Carried forward from
the Windows checkpoint (2026-07-23) as known gap 1.

## Why it still matters after two checkpoints

The lease-adoption result — that a guest holding an address gets its REQUEST
**ACKed with a full lease rather than NAKed** when `run-proxy` restarts with an
empty lease table — rests on *inferred* behaviour: the address was retained and the
lease extended by exactly `leaseSeconds`. That is strong evidence, but it is not
the ACK itself.

**The Ubuntu checkpoint (2026-07-24) partly compensated, from the client side.**
NetworkManager's journal records the offer, the ACD wait and the bind with
millisecond timestamps, and it was enough to characterise both paths precisely:

- clean boot with `run-proxy` already up — transaction opened `23:31:22.187`,
  lease offered **1.4 ms** later, bound `23:31:22.332` after conflict detection
- out-of-order boot — four 45 s retries, then a **five-minute quiet gap**, then an
  immediate bind once retried

So the client log is now the better instrument, and a host-side log is no longer
the *only* available evidence. It is still worth adding, for two reasons the client
log cannot cover:

1. **A NAK is a host-side decision.** The client journal shows the outcome, not
   why the server chose it. Debugging a client-interop problem in the field means
   reasoning about pool state, identity hashing and adoption from the host.
2. **Not every client has a readable journal.** The Windows guest's
   `Lease Obtained` field is coarse (whole seconds) and there is no equivalent
   narrative.

## Suggested fix

One line on each of ACK, NAK and adoption — enough to make the next checkpoint
self-evidencing rather than inferential. Include the client identifier, the address
and which branch was taken, so an adoption is distinguishable from a fresh
allocation in the log alone.

Keep it quiet enough to leave on: a DHCP client renews at T1 (half the 3600 s
lease), so a steady-state guest produces roughly one line every 30 minutes.

## What NOT to conclude from this gap

The DHCP server itself is **validated**. Full DORA to an address-less client,
renewal in place for the full 3600 s, adoption across a restart with an empty
table, unattended recovery from a late host start, and address stability across
all of it — confirmed against a real Windows client and re-confirmed from a
different client stack on Ubuntu, including the exact-same reissued address.

This is an observability gap, not a correctness one. Do not reopen decision 5.
