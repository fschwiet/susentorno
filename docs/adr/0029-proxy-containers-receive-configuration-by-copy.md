# Proxy containers receive their configuration by copy, not bind mount

Each Envoy color container is created, has the environment's proxy configuration (`envoy.yaml`, `gate.lua`, `ca/` without the root CA key `ca/key.pem`, and `secrets/`) copied into its own filesystem with `docker cp`, and only then started. No host path is bind-mounted. Bind mounts made Docker Desktop's Hyper-V backend prompt for a file-sharing grant for every new environment directory, including each test run's `test-results/.susentorno`. `docker cp` streams over the Docker API, so file sharing never applies, and it behaves the same on the WSL 2 backend. The host's `.susentorno/proxy` remains the single source of truth; a container holds a snapshot taken when it was created, which is all [[blue-green-container-swap-for-restarts]] ever relied on, since every change is already applied by recreating a color.

## Considered Options

- **Have susentorno add the environment to Docker Desktop's `FilesharingDirectories`.** Rejected: that setting lives in Docker's undocumented `settings-store.json`, needs a Docker Desktop restart that interrupts unrelated containers, and could break with any Docker update.
- **One named volume shared by both colors.** Rejected: inotify works inside a Linux volume, so the running color would hot-reload secrets while a sync is in progress and could see a half-written directory, which silently changes the blue/green contract.
- **A named volume per color, refilled before each bring-up.** Works, but adds a volume lifecycle (clearing stale files, removal) for no benefit over a fresh container filesystem.

## Consequences

- A container no longer reveals its environment through a bind-mount source, so it carries a label naming its environment directory, and `verify-proxy.ps1` checks ownership through that label.
- The root CA key no longer sits inside the internet-facing Envoy container; Envoy only ever needed the leaf certificate and key.
- A host edit to the proxy configuration reaches Envoy only at the next color bring-up, as before.
