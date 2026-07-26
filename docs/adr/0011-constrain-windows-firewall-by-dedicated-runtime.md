# Constrain host firewall access with a dedicated run-proxy runtime

On Windows, forwarded `run-proxy` sessions relaunch through a verified private copy of `node.exe`, and firewall rules bind that executable, the Internal-switch interface/address, and only the required proxy, DNS, and DHCP ports. A generic shared Node executable cannot safely identify `run-proxy` to Windows Firewall—program rules apply to every script hosted by that executable—so the extra host-wide runtime copy is accepted to keep inbound permission narrow and auditable.
