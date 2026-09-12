# Transparent interception, with network isolation as the real boundary

The guest reaches the proxy transparently — every DNS name resolves to the host, and the guest connects to the host on `:80`/`:443` with SNI/Host intact — rather than through any configured proxy. We do **not** use `HTTP_PROXY`/`HTTPS_PROXY` because an untrusted guest need not honor them, and we do **not** run a `CONNECT` forward proxy because not every tool honors one and credential injection would have to be rebuilt around it. The security boundary is **network isolation**: the guest's single active adapter is on a Hyper-V Internal switch with no general Internet route, while the host firewall confines access to ports 80, 443, 53, 67, and SMB on the Internal-switch address. Rules are scoped to both the interface and destination address except for DHCP broadcast on `:67`; strong-host receive and IP forwarding must remain disabled so an allowed port cannot become a path to another address on the multi-homed host. In-guest DNS and routing are convenience, not the guarantee.

An Internal switch does not isolate its attached guests from one another. Every guest sharing one can reach the same guest-facing host services and may reach its peers, so mutually untrusted guests require distinct isolation names and host networks.

## Consequences

- Host-side firewall enforcement is asserted, not assumed: rules are scoped to the Internal-switch address and the specific ports, and `run-hosting` is admitted through a **dedicated private copy of `node.exe`** so the firewall's program-scoped rule can't be inherited by any other use of a shared interpreter.
- DHCP is deliberately the exception to destination-address scoping because clients without an address send to the limited broadcast address; its rule remains interface-scoped. The verifier separately fails if `WeakHostReceive` or forwarding would let the guest pivot to another host address.
- This is why resolving every name to the host IP is safe (see [[host-side-dns-and-dhcp]]) — the host firewall does not expose the host's other services to the guest.
- Because the boundary is the adapter, switching a guest between isolated and NAT networks is a pure host-side adapter reassignment with no guest-side change.
- The isolation name is also an authorization boundary for unauthenticated host-run services ([[host-run-mcp-servers]]), not merely a naming convenience.
