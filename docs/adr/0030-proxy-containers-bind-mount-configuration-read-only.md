# Proxy containers bind-mount their configuration read-only

Each Envoy color is brought up with a single force-recreating `docker compose up`. The compose template bind-mounts the rendered `envoy.yaml`, `gate.lua`, the `ca/` directory and the `secrets/` directory read-only at their container paths. This supersedes [[proxy-containers-receive-configuration-by-copy]] (ADR 0029).

ADR 0029 copied the configuration in to avoid Docker Desktop's file-sharing prompts on the Hyper-V backend. That backend is no longer supported because it disturbs other applications on the host. Docker Desktop must use the **WSL 2 backend**, where bind mounts never prompt. susentorno documents this requirement but does not detect the backend or change Docker Desktop's settings.

The root CA private key lives in `.susentorno/ca-private/key.pem`, outside every directory the proxy stack mounts (and outside the VM-shared directories), so no mount can expose it to Envoy. Envoy only needs the leaf certificate and key and the upstream trust bundle, which stay in `proxy/ca`. `generate-ca` moves a key found at the old location (`proxy/ca/key.pem`); `run-hosting` never moves it and refuses to start while only the old location holds a key.

## Considered Options

- **Keep the copy path.** Rejected: it costs seven Docker CLI calls per bring-up instead of one, on every start, credential refresh and policy-reload swap, plus a staging folder and an allowlist to maintain, and buys nothing on the WSL 2 backend.
- **Revert to bind mounts and leave the key in `proxy/ca`.** Rejected: the key would be visible inside the internet-facing Envoy container, and it can sign certificates for any host a guest trusts.

## Consequences

- A running container sees host writes to its mounted configuration, but a change still reaches Envoy only through a fresh color ([[blue-green-container-swap-for-restarts]]).
- The `susentorno.environment` label and `verify-proxy.ps1`'s label-based ownership check remain.
