# `run-hosting` owns the whole hosting lifecycle as one long-running command

`run-hosting` is the single foreground command that owns the proxy end to end: it builds `envoy.yaml` from the allow list, writes the SDS secrets, watches both `~/.claude/.credentials.json` and `proxy/allowlist.txt` (event-driven file watchers, not polling), reissues the TLS leaf when the terminated-host set changes, streams the tagged access log inline, runs the guest-facing forwarder, and (later) serves DNS + DHCP. Separate `build-envoy-config` and `proxy-logs` commands were **removed** — their work happens inside `run-hosting`.

## Considered Options

- **Keep logging as a separate `proxy-logs` / `docker compose logs --follow` viewer.** Rejected: it followed the container being destroyed on every credential/allowlist restart and silently went dead. `run-hosting` owns every container recreation, so it re-attaches its own follow and never loses the stream.
- **Keep `build-envoy-config` as a manual step.** Rejected: editing the allow list should take effect live with no separate build/restart command.

## Consequences

- Editing `allowlist.txt` (or a credential rotating) takes effect on the running proxy automatically, with the leaf reissued only when the terminated hosts actually change.
- `run-hosting` must stay running for the guest to have egress — a hard dependency the rest of the design leans on (token freshness, forwarding, and later DNS/DHCP). See [[blue-green-container-swap-for-restarts]], [[loopback-publish-with-node-forwarder]], [[host-side-dns-and-dhcp]].
