# Isolate guests on a Hyper-V Internal switch served by the host

Hyper-V is the only supported VM platform, and isolated guests use a gateway-less Internal switch rather than retaining a general Internet route. `run-proxy` binds that switch's host address and supplies the constrained network edge—DHCP points the guest's router and DNS at the host, DNS maps accepted queries to that same proxy address, and TCP 80/443 enter Envoy—so arbitrary guest applications cannot route around policy enforcement.

## Considered Options

Earlier designs installed DNS and iptables machinery inside Ubuntu guests and assumed VMware host-only networking. Those designs were overtaken because they duplicated behavior per guest platform and left enforcement dependent on guest configuration.
