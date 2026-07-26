# Apply proxy changes by a blue/green container swap, not hot-reload

Every change that Envoy reads only at startup — a credential rotation or an allow-list edit — is applied by bringing up a second, idle Envoy container (blue/green), health-gating it on its own admin `/ready`, atomically flipping the forwarder's target to it, then draining and stopping the old one. New connections never hit a dead listener; connections already open on the old color are drained up to a timeout. Both colors run an identical Envoy internally on 443/80/9901 and differ only in the loopback ports they publish, which `run-proxy` allocates per swap.

## Considered Options

- **File-based SDS `watched_directory` hot-reload (no restart).** Impossible here: inotify does not cross the Docker Desktop bind mount on Windows, so Envoy never re-reads the secret file — confirmed empirically.
- **REST SDS hot-reload (Envoy polls `run-proxy` over HTTP).** Verified working, but **rejected on security grounds**: it requires `run-proxy` to serve the raw bearer token on a container-reachable port, which is exactly the exposure this proxy exists to prevent.
- **Full dynamic xDS (file LDS/CDS/SDS).** A large, higher-risk rewrite for a benefit blue/green already delivers.

## Consequences

- Two Envoy containers cannot both bind the same host port, so zero-downtime *requires* the stable-front indirection that [[loopback-publish-with-node-forwarder]] already provides — the forwarder is the swap point.
- Credential rotations are automatic and unschedulable, so an occasional dropped connection was unacceptable; this is why restarts had to become zero-downtime rather than just fast.
