# The guest layer is tested against a real QEMU guest inside WSL2

The guest-side networking and setup layer is tested by running the real, unmodified scripts inside a real QEMU/KVM Ubuntu cloud-image guest, orchestrated from Windows `vitest` through `wsl.exe`, with the guest booted inside WSL2 (nested virtualization). This is `pnpm test:guest`, which is part of the default `pnpm test` pipeline because the guest tier now covers the project's required end-to-end verification. A real guest is required because the regression classes involved — systemd boot ordering, netplan merge under the NetworkManager renderer, DHCP-without-a-gateway lease behavior — cannot be reproduced in a container.

## Considered Options

- **Firecracker microVMs.** Rejected: their value is a minimal rootfs with no full device model, but the scripts under test need full systemd + netplan + a DHCP-configured NIC.
- **Multipass / libvirt.** Rejected: they manage networking themselves, and the gateway-less DHCP lease is precisely the test subject, so it must be fully harness-controlled.

## Consequences

- **WSL2 must run in mirrored networking mode** with `[experimental] ignoredPorts=67` in `.wslconfig`: the gateway/DNS/DHCP are plain Windows listeners reachable from WSL only in mirrored mode, and ICS already holds `:67` so the harness's dnsmasq needs that port exempted from mirrored port sharing. Both are enforced by fail-fast preflight guards in `beforeAll`.
- **Deliberate fidelity boundary.** The harness runs its *own* dnsmasq on the bridge as a stand-in for the production TypeScript DNS/DHCP servers and does **not** run those — they are Windows-targeted, and running them under WSL would test Linux socket behavior instead. The production DNS/DHCP is covered instead by byte-level unit tests plus manual Hyper-V checkpoints (see [[host-side-dns-and-dhcp]]).
- `run-hosting` must be stopped before `pnpm test:guest`: both manage the same docker-compose Envoy stack, and the suite replaces any running proxy container, so a `globalSetup` guard fails fast when both loopback ports are already served.
- The harness's guest model has narrowed over time — it once exercised an in-guest dnsmasq stub, iptables DNAT, and a guarded default route, all since deleted; it now asserts a DHCP-only guest reaches the proxy and that the deleted layer stays deleted.
- **Residual fidelity gaps vs. a real Hyper-V VM.** The guest is an Ubuntu cloud image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→gateway-less switch keeps one subnet (production changes subnets); and Windows-specific binding/firewall behavior is covered only by manual checkpoints. To match Desktop's NetworkManager-only networking, the golden image masks `systemd-networkd` (the cloud image ships it enabled with a match-all dracut `.network`, and two renderers fighting over one link caused the historical `LinkBusy` failures), and the seed netplan declares a DHCP match-all ethernet since, unlike an installer-created per-NIC profile, this image has none.
