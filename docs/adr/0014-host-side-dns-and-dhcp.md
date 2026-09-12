# DNS and DHCP are served by `run-hosting` on the host

`run-hosting` serves catch-all DNS and DHCP on the Internal-switch address. DNS maps every A query to the host and answers AAAA without an address so clients fall back to A; DHCP supplies a guest address plus the host as router and resolver from an in-memory lease table. A guest therefore needs only DHCP configuration and trust in the proxy CA: the former in-guest DNS, DNAT, and guarded-route layer was removed.

## Considered Options

- **Keep DNS in the guest or in a separate host service.** Rejected because `run-hosting` is already the supervised process bound to the guest-facing adapter, and the host firewall makes resolving every name to that address safe ([[transparent-interception-and-network-isolation-boundary]]).

## Consequences

- DNS and DHCP bind the specific Internal-switch address rather than `0.0.0.0`, allowing them to coexist with Windows wildcard listeners. A bind failure is fatal.
- A guest booted before `run-hosting` receives no lease and recovers only on its DHCP client's retry schedule.
- The real-Hyper-V guest tier verifies that the production DHCP server supplies the router and resolver and that the production DNS responder is reachable ([[guest-layer-tested-against-real-hyperv]]).
