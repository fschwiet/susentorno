# Transparent interception, with network isolation as the real boundary

The guest reaches the proxy transparently — every DNS name resolves to the host, and the guest connects to the host on `:80`/`:443` with SNI/Host intact — rather than through any configured proxy. We do **not** use `HTTP_PROXY`/`HTTPS_PROXY` (the agent inside the guest cannot be trusted to honor them) and we do **not** run a `CONNECT`/forward proxy (it would require reworking Envoy's TLS-termination + injection to work over `CONNECT`, and not every tool honors a system proxy). The actual security boundary is **network isolation**: the guest's single active network adapter is on an isolated Hyper-V Internal switch whose only reachable node is the host, and the host firewall confines inbound traffic to the allowed ports (80/443/53/67 + SMB) on the Internal-switch address. In-guest DNS/routing config is *routing convenience, not the guarantee* — a compromised guest that rewrites its own DNS still cannot escape.

## Consequences

- Host-side firewall enforcement is asserted, not assumed: rules are scoped to the Internal-switch address and the specific ports, and `run-proxy` is admitted through a **dedicated private copy of `node.exe`** so the firewall's program-scoped rule can't be inherited by any other use of a shared interpreter.
- This is why resolving every name to the host IP is safe (see [[host-side-dns-and-dhcp]]) — the host firewall does not expose the host's other services to the guest.
- Because the boundary is the adapter, switching a guest between isolated and NAT networks is a pure host-side adapter reassignment with no guest-side change.
