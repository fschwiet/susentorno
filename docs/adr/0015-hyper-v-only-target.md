# Hyper-V on Windows is the only supported host and hypervisor

The project targets a Windows host with Hyper-V as its sole hypervisor. It began on VMware Workstation with an aspiration that the host side remain OS-agnostic, but shifted because the required nested isolation is a capability Hyper-V provides. Supporting both platforms would preserve abstractions the product could not verify with equal fidelity.

## Consequences

- The forwarder, DNS, DHCP, host-network orchestration, firewall rules, and test harness deliberately use Windows and Hyper-V semantics.
- Defaults such as `vEthernet (susentorno-internal)` and specific-address socket binding are product assumptions rather than portable fallbacks.
