# Investigation: specific-IP UDP service binds on Windows — DNS (`:53`) and DHCP (`:67`)

**Date:** 2026-07-22
**Status:** Complete for the host-side questions. One question (guest-originated
broadcast) is explicitly left open — see "What was NOT tested".

This note is written to be **project-agnostic**. It records a general Windows
networking question, the experiments run to answer it, and what each one
actually demonstrated. Nothing here depends on the particular application that
prompted the question.

## The question

On Windows, a service (commonly the **Internet Connection Sharing / "SharedAccess"**
service, which backs Hyper-V's Default Switch NAT) frequently holds a **wildcard**
UDP bind on `0.0.0.0:53`.

If you want to run your *own* DNS responder on one specific interface — say the
host adapter of a Hyper-V **Internal** virtual switch — you need to know:

1. Can a socket bind `<specific-ip>:53` while another process holds `0.0.0.0:53`?
2. If the bind succeeds, **which socket actually receives** packets addressed to
   `<specific-ip>:53` — yours, or the wildcard holder's?

Question 2 is the one that matters. A successful `bind()` proves nothing on its
own; the OS still has to prefer your socket when delivering a datagram.

## Environment

- Windows 11 Pro, 10.0.26200
- Hyper-V enabled, with both a Default Switch (NAT) and a user-created
  **Internal** switch
- The Internal switch's host adapter had a static IPv4 of `192.168.67.1/24`
- Tests were run from a **non-elevated** PowerShell session

## Test 1 — Who holds `:53`, and on which address?

```powershell
Get-NetUDPEndpoint -LocalPort 53 | Select LocalAddress,LocalPort,OwningProcess
Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -eq <pid> } |
    Select Name,DisplayName,State
```

**Result:**

| LocalAddress | LocalPort | OwningProcess |
|---|---|---|
| `0.0.0.0` | 53 | 4864 (`svchost`) |

PID 4864 resolved to the service **`SharedAccess` — "Internet Connection Sharing (ICS)"**.

Two incidental observations worth recording:

- There was **no TCP listener on port 53 at all** (`Get-NetTCPConnection -LocalPort 53
  -State Listen` returned nothing). ICS's DNS proxy was UDP-only here.
- ICS's **DHCP** bind on `:67` was *not* wildcard — it was specific to the
  Default Switch address (`172.17.224.1:67`). So ICS is inconsistent about this:
  wildcard for DNS, specific for DHCP. Do not assume one from the other.

**Demonstrated:** a real wildcard `0.0.0.0:53` holder was present, so the
experiment below is meaningful rather than vacuous.

## Test 2 — Attempt the binds

A small script attempted three binds, closing each socket immediately:

```powershell
$ip = [System.Net.IPAddress]::Parse('192.168.67.1')

function Try-Bind {
    param($proto, $addr, $port)
    try {
        $type = if ($proto -eq 'udp') { [System.Net.Sockets.SocketType]::Dgram }
                else { [System.Net.Sockets.SocketType]::Stream }
        $prot = if ($proto -eq 'udp') { [System.Net.Sockets.ProtocolType]::Udp }
                else { [System.Net.Sockets.ProtocolType]::Tcp }
        $s = New-Object System.Net.Sockets.Socket(
            [System.Net.Sockets.AddressFamily]::InterNetwork, $type, $prot)
        $s.Bind((New-Object System.Net.IPEndPoint($addr, $port)))
        "OK    $proto $($addr):$port -> bound as $($s.LocalEndPoint)"
        $s.Close()
    } catch {
        "FAIL  $proto $($addr):$port -> $($_.Exception.InnerException.SocketErrorCode)"
    }
}

Try-Bind 'udp' $ip 53
Try-Bind 'tcp' $ip 53
Try-Bind 'udp' ([System.Net.IPAddress]::Any) 53   # control
```

**Result:**

```
OK    udp 192.168.67.1:53  -> bound as 192.168.67.1:53
OK    tcp 192.168.67.1:53  -> bound as 192.168.67.1:53
FAIL  udp 0.0.0.0:53       -> AddressAlreadyInUse
```

**Demonstrated:**

- A **specific-IP** UDP bind on `:53` succeeds while a wildcard holder is active,
  with no `SO_REUSEADDR` and **without Administrator rights**.
- The same is true for TCP.
- The third case is the **control**, and it is what makes the first two
  meaningful: a wildcard bind *does* collide and fail with
  `AddressAlreadyInUse`. This rules out the boring explanations — the wildcard
  holder is genuinely there, port 53 is genuinely contended, and specific-IP
  binding is genuinely the thing that escapes the conflict.

This is a real behavioural difference from Linux, where binding `0.0.0.0:53`
first will normally block a later specific-IP bind on the same port unless
`SO_REUSEADDR`/`SO_REUSEPORT` is in play.

## Test 3 — End-to-end: does the specific socket actually get the packets?

Binding is not receiving. To answer question 2, a minimal DNS responder was bound
to `192.168.67.1:53`. It answers **every** A query with a fixed IPv4 address and
returns `NOERROR` with **no answer records** for any other qtype (so callers fall
back from AAAA to A rather than hanging).

Response construction, for the record:

- Echo the query's 2-byte transaction ID
- Flags `0x8180` (QR=1, RD=1, RA=1, RCODE=0)
- `QDCOUNT=1`; `ANCOUNT=1` for A queries, `0` otherwise; `NSCOUNT=ARCOUNT=0`
- Echo the question section verbatim
- For A: name compression pointer `0xC00C`, type `A`, class `IN`, TTL 60,
  RDLENGTH 4, then the 4 answer bytes

It was then queried from the host:

```powershell
Resolve-DnsName -Name example.com             -Server 192.168.67.1 -Type A -DnsOnly -NoHostsFile
Resolve-DnsName -Name totally-made-up.invalid -Server 192.168.67.1 -Type A -DnsOnly -NoHostsFile
Resolve-DnsName -Name example.com             -Server 192.168.67.1 -Type AAAA -DnsOnly -NoHostsFile
```

**Result:**

```
Name                     Type TTL IPAddress
----                     ---- --- ---------
example.com                 A  60 192.168.67.1

totally-made-up.invalid     A  60 192.168.67.1

(AAAA: no records returned)
```

Concurrently, `Get-NetUDPEndpoint -LocalPort 53` showed **both** sockets
coexisting:

| LocalAddress | LocalPort | OwningProcess |
|---|---|---|
| `192.168.67.1` | 53 | 7152 (the test responder) |
| `0.0.0.0` | 53 | 4864 (ICS) |

**Demonstrated:** the **more specific bind wins packet delivery**. Every query
addressed to `192.168.67.1:53` was delivered to the test responder, not to the
ICS wildcard listener — including `example.com`, a name ICS's DNS proxy could
have resolved for real. The fabricated answer coming back (`192.168.67.1`, and
for a `.invalid` name that has no real resolution) is the proof that our socket,
not ICS, served the query.

### A useful false negative along the way

The first run of the responder returned `Bad DNS packet` to every query. The
cause was a scripting bug, not a networking one: in PowerShell, an array slice
like `$buf[12..$n]` produces `System.Object[]`, which `List[byte].AddRange`
refuses, so the answer section was silently dropped while the header still
claimed `ANCOUNT=1`. The fix was an explicit cast, `[byte[]]($buf[12..$n])`.

This is worth recording because the failure was still *informative*: receiving a
malformed reply at all proved our socket — not ICS — was the one being handed
the packets. A wrong answer from the right socket is a different signal than no
answer at all, and the distinction is what let the networking question be
answered before the bug was fixed.

## Test 4 — The same question for DHCP (`:67`), plus broadcast delivery

Running a DHCP server on a specific interface raises a second, harder question.
DNS queries are **unicast** to the server's address, but a DHCP client that has no
address yet sends `DISCOVER` from `0.0.0.0` to the **limited broadcast** address
`255.255.255.255`. So it is not enough to bind `<ip>:67` — the socket must also
*receive broadcast traffic*.

On Linux this is the reason DHCP servers bind `INADDR_ANY` (or use
`SO_BINDTODEVICE`): a socket bound to a specific unicast address does not receive
packets addressed to a broadcast address.

Three binds were probed, then a listener was bound to `192.168.67.1:67` and a
second socket — with `SO_BROADCAST` set and **pinned to the same interface IP** so
packets left via that adapter — sent probes to three destinations on port 67.

```powershell
# Sender pinned to the internal-switch IP so the packet leaves that adapter
$tx.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket,
    [System.Net.Sockets.SocketOptionName]::Broadcast, $true)
$tx.Bind((New-Object System.Net.IPEndPoint($hostIp, 0)))
# ... SendTo 255.255.255.255:67, 192.168.67.255:67, 192.168.67.1:67
```

**Result:**

```
=== Part 1: can we bind :67 at all? ===
OK    bind 192.168.67.1:67
OK    bind 0.0.0.0:67

=== Part 2: does a specific-IP bind receive broadcast to :67? ===
  RECEIVED  limited broadcast 255.255.255.255
  RECEIVED  subnet broadcast 192.168.67.255
  RECEIVED  unicast 192.168.67.1 (control)
```

**Demonstrated:**

- `<specific-ip>:67` binds cleanly. Note the contrast with Test 1: the same ICS
  service that holds DNS on **wildcard** `0.0.0.0:53` holds DHCP on a **specific**
  address (`172.17.224.1:67`). Because that bind is specific, even `0.0.0.0:67`
  was still bindable here. Do not generalize one port's binding style from
  another's, even within the same service.
- **A socket bound to a specific unicast address received both limited broadcast
  and subnet broadcast traffic.** This is the key finding, and it differs from
  Linux. It means a DHCP server on Windows does not need a wildcard bind to hear
  clients that have no address yet.
- The unicast case is the control, confirming the listener was live and the
  send path worked; without it, two "RECEIVED" lines would not distinguish
  "broadcast was delivered" from "the test was measuring something else."

**Important limitation on this result** — see the next section. The sender was on
the **same host** as the listener and pinned to that host's own interface address.
A real DHCP client is a separate machine broadcasting from `0.0.0.0` across a
virtual switch, which is a different arrival path. This test removes the
categorical objection ("Windows won't deliver broadcast to a specific bind") but
does not prove the real path works.

## What was NOT tested

- **Inbound reachability from another machine.** All queries above originated on
  the host itself (source address `192.168.67.1`). A guest VM querying across the
  Internal switch traverses **Windows Firewall**, which these tests did not
  exercise.

  The relevant context found on this host: the Internal-switch adapter was
  categorized **`Public`**, all three firewall profiles were **enabled**, and
  `DefaultInboundAction` was `NotConfigured` — which resolves to **block**.
  Inbound UDP 53 from a guest should therefore be expected to require an explicit
  allow rule, ideally scoped with `-InterfaceAlias` to the Internal adapter.

  (Note: some `HNS Container Networking - DNS (UDP-In)` rules for UDP 53 on
  profile `Any` were already present from container networking. These might
  incidentally permit the traffic, but relying on rules another component created
  and may remove is not advisable — create an explicit, interface-scoped rule.)

- **Guest-originated broadcast across a virtual switch.** This is the most
  significant gap. Test 4 established that a specific-IP bind receives broadcast,
  but the sender was a process on the same host, pinned to that host's own
  interface address. A DHCP client on another machine sends from source `0.0.0.0`
  to `255.255.255.255`, arriving at the host from across the virtual switch. That
  path was not exercised, and it is the one that matters for actually serving
  DHCP.

  A cheap way to close this without writing a DHCP server: bind a **passive
  listener** to `<ip>:67` that logs any datagram it receives, then boot a
  DHCP-configured client on the network and observe whether a `DISCOVER` arrives.
  The client will fail to get an address — nothing is answering — but arrival of
  the packet is the whole question.

- **Behaviour when the wildcard holder starts second.** Only "wildcard first,
  specific second" was tested. The reverse ordering, and what happens across an
  ICS restart while the specific socket is held, are unknown.

- **Elevation.** Both binds succeeded unelevated; whether any environment policy
  would change that was not explored.

## Conclusions

1. On Windows, a specific-IP bind to `<ip>:53` **coexists** with a wildcard
   `0.0.0.0:53` holder, for both UDP and TCP, without special socket options and
   without Administrator rights.
2. Packets addressed to `<ip>:53` are delivered to the **specific** socket. The
   wildcard holder does not intercept them.
3. Therefore an ICS/Default-Switch DNS proxy holding `0.0.0.0:53` is **not** an
   obstacle to running your own responder on a dedicated interface IP. No need to
   disable or reconfigure ICS.
4. The remaining practical obstacle is **Windows Firewall**, not port ownership.
   Plan for an explicit inbound allow rule scoped to the interface.
5. The same holds for DHCP on `:67`, with the additional and more surprising
   finding that **a specific-IP bind on Windows receives broadcast traffic** —
   so a DHCP server does not need a wildcard bind. This is a genuine
   platform difference from Linux. It is demonstrated only for a same-host
   sender; the cross-machine path remains open (see above).
6. Binding style is **per-port, not per-service**: the same ICS service held
   `:53` on wildcard and `:67` on a specific address. Probe each port you care
   about rather than inferring.

## Reproducing

The two scripts used (a bind prober and a minimal all-A DNS responder) are
straightforward to recreate from the excerpts above. Sequence:

1. `Get-NetUDPEndpoint -LocalPort 53` — confirm a wildcard holder exists.
2. Run the bind prober — expect OK/OK/FAIL as above. The FAIL is the control;
   if it succeeds, there was no wildcard holder and the test proves nothing.
3. Start the responder on `<ip>:53`, query it with `Resolve-DnsName -Server <ip>`,
   and confirm the fabricated answer comes back.
4. Stop the responder and re-check `Get-NetUDPEndpoint -LocalPort 53` to confirm
   you left the port as you found it.
