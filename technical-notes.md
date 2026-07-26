# Technical notes

Maintainer and background material. Day-to-day setup lives in [README.md](README.md).

## Maintaining the allow list

`current-allow-list.txt` (repo root, source controlled) is the default allow list that `configamatron init` copies into every new environment. To refresh it from an upstream network policy file:

```
configamatron import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` in the current directory by default (`-o` to override). Run it in a checkout of this repository and commit the result. It is a maintenance command — not part of environment setup — and it never touches an environment's own `proxy/allowlist.txt` (edit that file directly for per-environment changes — a running `configamatron run-proxy` picks the edit up live).

## Environment model

- The working directory owns the environment: every command (except `init` and `import-sbx-network-policy`) operates on `<cwd>/.configamatron` and exits 1 if it is missing. There is no parent-directory search.
- There is no upgrade path for `.configamatron` folders. Rebuild from scratch: delete the folder and re-run the setup commands. Previously generated CA material can be restored into `proxy/ca/` before running `generate-ca` — a valid pair is reused, an invalid one fails loudly (key material is never overwritten).
- The compose project name is pinned (`name: configamatron` in `proxy/docker-compose.yml`), so `docker compose up` for any environment replaces the running proxy container instead of colliding with it on ports 80/443. Running the test suite does the same. This is deliberate: one proxy at a time, and switching environments (or recovering after tests) is just re-running `configamatron run-proxy` in the environment directory.
- The VM placeholder credential (`vm-shared/credentials.json`) is derived from the host's real `~/.claude/.credentials.json` at init time: `accessToken` becomes `sk-ant-oat-SANDBOX-PLACEHOLDER` (the exact value the proxy's gate.lua swaps for the real token), `refreshToken` becomes `sandbox-placeholder-refresh-token`, `expiresAt` is set far in the future, and every other field passes through so the file matches the account's real shape. The file is written with LF line endings.

## How the proxy works

Envoy runs in Docker on the host and is the VM's only network path. Allow-listed hosts are either passed through by SNI (TLS) / Host header (port 80), or TLS-terminated for credential injection: requests presenting the placeholder Authorization header get the real bearer token injected from a file-based SDS secret; anything else is rejected before reaching the upstream. `run-proxy` owns the proxy end to end: it builds `envoy.yaml` from the allowlist, writes the SDS secret from the host credential, and force-recreates the container whenever the token rotates or the allowlist changes (reissuing the leaf certificate when the TLS-terminated host set changes — the root CA from `generate-ca` is never touched).

Design history (reference only, not updated):

- `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md`
- `docs/superpowers/specs/2026-07-05-run-proxy-credential-monitor-design.md`
- `docs/superpowers/specs/2026-07-05-configamatron-environments-design.md`

### Access logging

Every Envoy path writes a machine-parseable access-log line to the container's stdout: `CFGM|<path-id>|<start-time>|<server-name>|<authority>|<response-code-details>`, where `path-id` is `term`, `pass`, `http`, or `deny443`. Blocked `:443` connections are caught by `listener_443`'s `default_filter_chain`, which routes to the endpoint-less `blackhole` cluster (dropping the connection) after logging the rejected SNI as `deny443`. `run-proxy` parses these lines and maps them to friendly tags in its inline log stream (each host+handling printed once); port-80 allow-vs-block is disambiguated by response-code details (`direct_response` = the default-deny 403). The access-log format never includes the `Authorization` header, so injected tokens never reach the logs.

## VM networking details

Guests run **DHCP only**. `run-proxy` serves both DHCP and DNS on the Hyper-V Internal-switch adapter IP:

- **DHCP** hands out an address from an in-memory lease table, with the host as both router (option 3) and DNS (option 6). A given guest normally lands on the same address, and a lease is re-adopted rather than rejected if `run-proxy` restarts while the guest still holds it.
- **DNS** answers every A query with the host IP, and every other qtype with NOERROR and no answer records so callers fall back to A rather than concluding the name does not exist.

Because names already resolve to the host, guests connect straight to the proxy with SNI intact. There is no DNAT layer, no in-guest resolver, and no default-route hack — all three were deleted when DNS moved to the host, so `05-configure-network.sh` now only installs the CA. See `docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`.

Both services bind the **specific** adapter IP rather than `0.0.0.0`, which is what lets them coexist with the ICS wildcard `0.0.0.0:53` holder; do not "simplify" either bind. A bind failure is fatal and loud, because a silently-absent listener strands every guest on the switch.

Consequences worth knowing: the guest needs `run-proxy` running before it boots, and if it is not, recovery is unattended but bounded by the client's retry timer — a Windows guest that has fallen back to a `169.254.x.x` self-assigned address can take ~5 minutes to pick up a lease once the server appears. Nothing host-side shortens this.

## Testing

`pnpm test` runs, in fail-fast order: format check, lint, typecheck, unit tests, build, cli tests (against `dist/cli.js`), and proxy-stack tests. The proxy-stack tests build this repository's own gitignored `.configamatron` (using `tests/fixtures/credentials.json`, never your real credential file) and bring the Envoy stack up against a mock upstream on transient ports. Docker must be running; no VM or real credential is required. The suite replaces any running proxy container, but never touches another environment's files.

`pnpm test:guest` (not part of `pnpm test`) boots a QEMU/KVM Ubuntu guest inside WSL2 and runs the real script from `/mnt/vm-shared/pre-scripts/` against the same Envoy stack the proxy-stack tests use, published at a harness-owned bridge IP. It covers the NAT-phase setup, the switch to gateway-less DHCP plus reboot, and a fresh guest coming up on the isolated network — asserting in each case that the guest is configured by its **lease alone** and that the deleted layer stays deleted (no in-guest dnsmasq, no DNAT rules, the default route arriving via DHCP). See `docs/superpowers/specs/2026-07-06-vm-e2e-test-harness-design.md`.

**Stop `run-proxy` before running this suite.** Both manage the same docker-compose Envoy stack, and the suite _replaces_ any running proxy container — so the two clobber each other: the suite's Envoy is torn down underneath it (its reachability guard then reports `000` and blames Docker WSL integration), and `run-proxy` is left serving `:80`/`:443` with no backend, which silently costs a live VM its egress while leaving DHCP and DNS working. A `globalSetup` guard now fails fast when both loopback ports are already served, rather than letting the symptom surface far from its cause. Start `run-proxy` again afterwards.

This layer deliberately does **not** exercise the production DHCP/DNS servers: those are Windows-targeted TypeScript, and running them under WSL would test Linux socket behaviour instead. The harness keeps its own dnsmasq on the bridge, standing in for `run-proxy` by handing out the same options — and because `guest.sh` derives every guest's SSH address from that lease file, it is also the control channel for the whole suite. `build-image.sh` stamps the inputs baked into the golden image and rebuilds when they change, so a cached image is never silently reused after the seed is edited.

One-time WSL setup: `wsl.exe -u root bash <repo>/tests/guest/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). WSL must use **mirrored networking** (`%USERPROFILE%\.wslconfig`: `[wsl2] networkingMode=mirrored`) — the gateway is a plain Windows loopback listener, reachable from WSL only in that mode — and `[experimental] ignoredPorts=67` must exempt the DHCP port from mirrored port sharing, since Windows' Hyper-V Default Switch DHCP already holds port 67 and dnsmasq needs a wildcard bind (RFC 2131 fixes the port; `bind-interfaces` scopes only DNS sockets). Both requirements are enforced by fail-fast guards in `tests/guest/guest.test.ts`'s `beforeAll`; changes take effect after `wsl --shutdown` (Docker Desktop restarts too). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/guest/<timestamp>/`. See `docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md`.

Residual fidelity gaps vs. a real Hyper-V VM: the guest is an Ubuntu _cloud_ image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→gateway-less switch keeps one subnet (production changes subnets); and the harness's dnsmasq stands in for the production TypeScript DHCP/DNS servers, so Windows-specific binding and firewall behaviour are covered only by the manual checkpoint (see the validation results in `docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md`). To match Desktop's NetworkManager-only networking, the golden image **masks systemd-networkd** — the cloud image ships it enabled with a match-all dracut `.network`, and two renderers fighting over one link is what the historical `LinkBusy` failures came from. The seed netplan declares a DHCP match-all ethernet: an installed system has an installer-created per-NIC profile, and without an equivalent here the image would fall back to NetworkManager's implicit "Wired connection 1" instead.

## VM egress goes through run-proxy's host forwarder

Docker Desktop's published-port relay (WSL2 backend) accepts connections arriving on the Hyper-V Internal-switch interface slowly and unreliably, while loopback connections to the same Envoy ports are instant. So `docker-compose` publishes Envoy on `127.0.0.1` only, and `run-proxy` runs a byte-transparent TCP forwarder on the Internal-switch adapter IP that pipes `:80`/`:443` to `127.0.0.1`. Forwarding is active only while `run-proxy` runs (which is required anyway for token freshness). Disable it with `--no-forward`; override the bind IP with `--forward-listen <ip>`. See docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md.
