# Hyper-V on Windows is the only supported host/hypervisor

The project targets a Windows host with Hyper-V as the sole hypervisor. It began on VMware Workstation with an aspiration that the host side stay OS-agnostic, but shifted to Hyper-V because the nested isolation the project needs is a hard requirement Hyper-V provides, and VMware has since been purged from the living docs, defaults, and tests.

## Status

accepted (2026-07-22) — supersedes the original 2026-07-01 VMware target and its "host should not depend on Windows" non-goal.

## Consequences

- The forwarder, DNS, and DHCP defaults and binding semantics are Windows/Hyper-V specific (e.g. `vEthernet (configamatron-internal)`, specific-IP binds that coexist with ICS), so the host side is no longer portable — a deliberate reversal of the initial goal.
- History and design records under `docs/superpowers/`, `docs/honist-v/`, and `legacy/` retain VMware references intentionally.
