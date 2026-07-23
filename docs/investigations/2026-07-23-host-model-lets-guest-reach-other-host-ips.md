# Investigation: a guest reaching the host's *other* IPs via an allowed port

**Date:** 2026-07-23
**Status:** Complete for the host-side questions. The exploit path is **not**
reachable in the configuration observed here; this note records why, what it
depends on, and how to stop depending on it.

This note is written to be **project-agnostic**. It describes a general Windows
networking exposure that applies to any setup where a guest is confined to one
adapter of a multi-homed host and reaches host services through a small set of
firewall-allowed ports. Nothing here depends on the particular application that
prompted the question.

## The setup this concerns

A common isolation pattern:

- A multi-homed Windows host. One adapter faces an **isolated** network the guest
  lives on (e.g. the host adapter of a Hyper-V **Internal** virtual switch, at
  `<host-internal-ip>`). Other adapters face other networks — a NAT/Default-Switch
  adapter, a Wi-Fi/LAN adapter, etc. — each with its **own** host IP.
- The guest is meant to reach the host **only** on that isolated adapter, and
  only on a few ports, opened by an inbound-allow firewall rule.
- Some of those host services bind a **specific** address (`<host-internal-ip>:port`)
  rather than the wildcard `0.0.0.0:port`, often deliberately, so they can
  coexist with another wildcard holder on the same port (see the companion note
  on specific-IP `:53`/`:67` binds).

The intended mental model is: "the guest can talk to `<host-internal-ip>` on the
allowed ports, and nothing else." This note examines whether that model actually
holds, and what it rests on.

## The concern (what could go wrong if the host binding model changed)

Firewall allow rules of the common form

```
New-NetFirewallRule -Direction Inbound -Protocol UDP -LocalPort 53 `
    -InterfaceAlias "<isolated adapter>" -Action Allow
```

match on **(arrival interface, protocol, port)**. They carry **no `-LocalAddress`
condition**, so they permit a packet to *any* host IP on that port, as long as it
arrives on the isolated interface. The firewall does not, by itself, restrict the
traffic to `<host-internal-ip>`.

That leaves the destination-IP restriction to the OS's **host model**:

- Under the **strong host model** (`Weak Host Receives : disabled`), the stack
  accepts a received packet **only if its destination IP is assigned to the
  interface it arrived on.** A packet addressed to some *other* host IP that
  arrives on the isolated interface is dropped before any listener or firewall
  service-match sees it.
- Under the **weak host model** (`Weak Host Receives : enabled`), the host accepts
  a packet for **any** of its local IPs regardless of arrival interface. Combined
  with the host being the guest's default gateway, the guest can then address the
  host's *other* IPs and have them answered.

If the isolated adapter were ever set to weak-host-receive (or inter-interface
forwarding were enabled), the guest could send to `<some-other-host-ip>:<allowed
port>` and reach the host there. And which **service** answers is then decided by
the socket **bind**, not the firewall:

- **Wildcard binds** (`0.0.0.0:port`) answer on every host IP — so the guest
  reaches the *same* service on a different IP. Usually benign, but it does defeat
  any attempt to expose a service on one adapter only.
- **Specific binds** (`<host-internal-ip>:port`) do **not** answer on other IPs.
  So a packet to a *different* host IP on the same port either finds nothing (RST /
  no reply) **or falls through to a different listener** — a `0.0.0.0:port` holder,
  or a service specifically bound to that other IP. That is the vulnerability: the
  guest reaches a **different service than the one the port was opened for.**

### The concrete worst case

The sharpest instance combines a specific bind with a wildcard fallback on the
same port:

- The intended service binds `<host-internal-ip>:53` (specific).
- Another service — on Windows, commonly **ICS / "SharedAccess"** — holds
  `0.0.0.0:53` (wildcard).

A DNS query to `<host-internal-ip>:53` reaches the intended responder. But a query
to a **different** host IP on `:53` falls through to the **wildcard holder** — a
real **recursive resolver with internet reach**. Because UDP 53 is allowed on the
isolated interface *regardless of destination IP*, a weak-host host would let the
guest use that resolver directly:

- It bypasses a responder whose entire job may be to answer names a certain way
  (e.g. pinning everything to a proxy).
- A recursive resolver that reaches the internet is a ready-made **DNS
  egress/exfiltration channel** that sidesteps whatever egress control the
  intended path enforces — even on a host that otherwise cannot route the guest
  anywhere.

The same shape applies to any port where a specific intended bind coexists with a
wildcard `0.0.0.0:port` holder (e.g. a stray `0.0.0.0:80/443` web service).

## Observations about the configuration seen here

Measured on the host (read-only queries). These are what make the exploit path
**not** currently reachable — and equally, what it silently depends on.

### The isolated adapter is strong-host and non-forwarding

```
netsh interface ipv4 show interface "<isolated adapter>"
  ...
  Forwarding          : disabled
  Weak Host Sends     : disabled
  Weak Host Receives  : disabled
```

`Weak Host Receives : disabled` is the strong host model. A packet arriving on the
isolated interface whose destination is a *different* host IP is dropped by the
stack. With `Forwarding : disabled` it is not routed onward either. So a guest on
that interface can reach the host **only at the isolated adapter's own IP** — the
intended model holds.

`Get-NetIPInterface -AddressFamily IPv4` showed **`Forwarding : Disabled` on every
interface**, and every adapter checked (including the NAT/Default-Switch adapter)
also reported strong-host `Weak Host Receives : disabled`.

Note this is the **Windows default** (Vista and later default to the strong host
model for both sends and receives). So the property is real, but it is inherited
from a default rather than asserted by this project.

### The firewall rules are interface-scoped, not address-scoped

The inbound-allow rules that open the guest's ports are scoped with
`-InterfaceAlias` (to the isolated adapter) and **no `-LocalAddress`**. They match
by arrival interface + port only. This is correct and sufficient *given* the
strong host model, but it means the firewall is **not** the thing constraining
traffic to `<host-internal-ip>` — the host model is.

### At least one intended service uses a specific bind alongside a wildcard holder

The environment has a service bound to `<host-internal-ip>:53` coexisting with a
wildcard `0.0.0.0:53` holder (ICS). This is by design — the specific bind is how
the two coexist — but it is exactly the ingredient that turns a weak-host
misconfiguration into the "different service on a different IP" exposure above.

### Net assessment

The guest→other-host-IP pivot is **not exploitable as configured**: strong host
receive + no forwarding on the isolated adapter drops it. But the guarantee rests
entirely on two host-networking settings that this project neither sets nor checks
— `Weak Host Receives` and `Forwarding` on the isolated adapter. A future change
(an ICS/RRAS reconfiguration, a manual `netsh ... set interface ...
weakhostreceive=enabled`, a networking component toggling forwarding) could flip
either **silently**, and nothing in the setup or its verification would notice.

## Suggested fix — stop relying on the host-model assumption

The exposure is a **defense-in-depth gap**, not an active hole. The goal is to make
the confinement hold **independently** of the host model, and to make the
dependency **checked** rather than assumed. Two complementary changes:

### 1. Scope the firewall allow rules to the destination address

Add a `-LocalAddress <host-internal-ip>` condition to each inbound-allow rule, so
the firewall permits the allowed ports **only** when the packet is addressed to the
isolated host IP:

```powershell
New-NetFirewallRule -DisplayName "<name>" -Direction Inbound -Protocol UDP `
    -LocalPort 53 -InterfaceAlias "<isolated adapter>" `
    -LocalAddress <host-internal-ip> -Action Allow
```

With this, even if the host model were weakened, a packet the guest addresses to a
*different* host IP would no longer match the allow rule and would fall to the
default inbound **block**. This closes the path at the firewall regardless of
host-model or forwarding state, and it costs nothing when the host model is already
strong.

Caveats to weigh per port:

- The isolated host IP must be **stable / known** when the rule is written. If the
  isolated adapter's address is assigned dynamically, resolve it first (the setup
  already reads it to report the host IP) and pass it in.
- **DHCP (`:67`) is the exception.** A client with no address broadcasts `DISCOVER`
  from `0.0.0.0` to `255.255.255.255`; those datagrams are **not** addressed to the
  host's unicast IP, so a `-LocalAddress <host-internal-ip>` condition would drop
  them. Leave the `:67` rule interface-scoped only, or additionally allow the
  broadcast destination. Do **not** blindly apply `-LocalAddress` to every rule.

### 2. Assert the host-model invariant in the verifier

Make the assumption explicit and fail loudly if it ever changes. In the project's
existing host verification step, check the isolated adapter and require:

```powershell
$n = netsh interface ipv4 show interface "<isolated adapter>"
# expect: "Weak Host Receives : disabled" and "Forwarding : disabled"
```

or via the typed API:

```powershell
(Get-NetIPInterface -InterfaceAlias "<isolated adapter>" -AddressFamily IPv4).Forwarding
# expect: Disabled
```

Report `FAIL` (not `WARN`) if either the isolated adapter reports weak-host receive
or any inter-interface forwarding is enabled, since both re-open the pivot. This
turns "safe because of a default we never set" into a **checked, enforced
property** — the same philosophy the DHCP/DNS work already applies to "bind failure
is fatal and loud."

Doing **both** is belt-and-suspenders: (1) removes the exposure at the firewall
even under a weak host model; (2) surfaces the underlying misconfiguration so it
gets fixed at the source rather than only masked.

## What was NOT tested

- **A live weak-host demonstration.** The host was strong-host throughout, so the
  pivot was reasoned about, not reproduced. To demonstrate it, one would set
  `netsh interface ipv4 set interface "<isolated adapter>" weakhostreceive=enabled`
  and, from the guest, send to `<some-other-host-ip>:53` and observe the wildcard
  holder answering. Not done here — deliberately, to avoid weakening the host.
- **Whether ICS/RRAS reconfiguration actually flips these settings in practice.**
  The concern is that it *could*; the frequency and exact triggers were not
  characterized.
- **`-LocalAddress` interaction with the broadcast DHCP path**, beyond noting that
  it would break it. The `:67` rule was not re-tested with the address condition
  added.

## Conclusions

1. Interface-scoped inbound-allow rules constrain **which interface and port**, not
   **which host IP**. On a multi-homed host they do not, alone, confine a guest to
   the isolated adapter's address.
2. The confinement to `<host-internal-ip>` is provided by the **strong host model**
   (`Weak Host Receives : disabled`) plus **no inter-interface forwarding** on the
   isolated adapter — both observed here, both Windows defaults, **neither set nor
   checked** by the project.
3. If the host model were weakened, a guest could reach the host's *other* IPs on
   the allowed ports, and — because intended services use **specific** binds while
   a **wildcard** holder (ICS) sits behind the same port — could land on a
   **different service**, the standout case being a real recursive resolver on
   `:53` usable as a DNS egress channel.
4. The fix is to stop depending on the assumption: **scope allow rules with
   `-LocalAddress`** (except the broadcast-dependent `:67`), and **assert
   strong-host + no-forwarding in the verifier**. The first removes the exposure
   regardless of host model; the second makes the dependency visible if it ever
   changes.
