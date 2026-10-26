# Apply proxy changes by a blue/green container swap, not hot-reload

Every proxy configuration change — a credential rotation or network-policy edit — is applied by bringing up a second, idle Envoy container (blue/green), health-gating it on its own admin `/ready`, atomically flipping the forwarder's target to it, then draining and stopping the old one. New connections never hit a dead listener; connections already open on the old color are drained up to a timeout. Both colors run an identical Envoy internally on 443/80/9901 and differ only in the loopback ports they publish, which `run-hosting` allocates per swap.

## Considered Options

- **File-based SDS `watched_directory` hot-reload (no restart).** Rejected: it covers only secrets, while network-policy edits change static listeners and clusters in `envoy.yaml` and still need a restart, so it would add a second update path beside blue/green. Each container holds a configuration snapshot taken at creation ([[proxy-containers-receive-configuration-by-copy]]), so hot-reload would also mean writing files into a running container.
- **REST SDS hot-reload (Envoy polls `run-hosting` over HTTP).** Verified working, but **rejected on security grounds**: it requires `run-hosting` to serve the raw bearer token on a container-reachable port, which is exactly the exposure this proxy exists to prevent.
- **Full dynamic xDS (file LDS/CDS/SDS).** A large, higher-risk rewrite for a benefit blue/green already delivers.

## Consequences

- Two Envoy containers cannot both bind the same host port, so zero-downtime *requires* the stable-front indirection that [[loopback-publish-with-node-forwarder]] already provides — the forwarder is the swap point.
- Credential rotations are automatic and unschedulable, so an occasional dropped connection was unacceptable; this is why restarts had to become zero-downtime rather than just fast.
