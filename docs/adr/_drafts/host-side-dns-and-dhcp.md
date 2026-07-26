# DNS and DHCP are served by `run-proxy` on the host; the guest is DHCP + CA trust only

`run-proxy` runs a catch-all DNS responder and a DHCP server in-process on the host, bound to the Internal-switch adapter IP. DNS answers **every** A query with the host IP (AAAA → NOERROR/no-answer so callers fall back to A); DHCP hands out an address plus the host as router and DNS from an in-memory lease table. The guest's contract collapses to **DHCP + trust the proxy CA** — every name resolves to the host, the guest connects there with SNI intact, and the entire in-guest DNS/DNAT/route layer is gone.

## Status

accepted (2026-07-22) — supersedes the earlier in-guest networking layer: an Ubuntu dnsmasq stub answering a TEST-NET-3 placeholder plus iptables DNAT and a guarded default route (2026-07-04/05), and a Windows in-guest C# DNS responder (2026-07-13). All of that was deleted.

## Considered Options

- **A separate host DNS process/service, or reusing the compiled C# responder on the host.** Rejected: reintroduces the supervision problem that first pushed DNS into the guests, or keeps a second language for ~40 lines of packet work. `run-proxy` is already a supervised long-lived host process bound to the same adapter.
- **Resolve every name to the host IP** was previously *rejected* (2026-07-05) for fear of exposing the host's own ports to the guest. It is now safe because [[transparent-interception-and-network-isolation-boundary]]'s host firewall confines the guest to the allowed ports on the Internal-switch address.

## Consequences

- Both listeners bind the **specific** adapter IP (not `0.0.0.0`), which lets them coexist with Windows' ICS wildcard `:53`/`:67` holders; a bind failure is fatal and loud.
- Guest network availability now depends on a host process being up: a guest booted before `run-proxy` gets *no* address, and unattended recovery is bounded by the client's DHCP retry timer (~5 min). Accepted; running `run-proxy` as a supervised service is possible follow-on.
- Setup uses one active adapter at a time (NAT phase for OS/tool install, then reassign the same NIC to the Internal switch), so switching networks needs no guest-side change — see [[transparent-interception-and-network-isolation-boundary]].
