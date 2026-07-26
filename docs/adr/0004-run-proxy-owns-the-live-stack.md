# Let run-proxy own and replace the complete live proxy stack

`run-proxy` is a foreground supervisor for config generation, credential propagation, logging, host forwarding, DNS/DHCP, and Envoy lifecycle rather than a collection of independently operated commands. Envoy configuration changes use a blue-green container swap behind a stable in-process gateway, with readiness checked before cutover and old connections drained afterward, because neither filesystem secret reload nor an in-place container restart provides reliable, interruption-free updates.

## Consequences

The supervisor must treat shutdown and startup failure as coordinated stack events, and the fixed Compose/container identity means starting another environment deliberately replaces the prior environment's proxy.
