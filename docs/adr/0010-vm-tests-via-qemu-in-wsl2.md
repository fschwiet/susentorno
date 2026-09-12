---
status: superseded by ADR-0025
---

# The guest layer was tested in QEMU inside WSL2

The original guest tier used a real QEMU/KVM Ubuntu guest because containers could not reproduce the systemd, netplan, NetworkManager, and DHCP behavior under test. QEMU inside WSL2 was an acceptable interim way to exercise a real guest, but its harness substituted its own DNS, DHCP, and forwarding services and did not exercise the production Hyper-V network path. [[guest-layer-tested-against-real-hyperv]] carries the current decision and closes those fidelity gaps.
