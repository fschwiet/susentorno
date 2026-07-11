# Technical notes

Maintainer and background material. Day-to-day setup lives in [usage.md](usage.md).

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

Envoy runs in Docker on the host and is the VM's only network path. Allow-listed hosts are either passed through by SNI (TLS) / Host header (port 80), or TLS-terminated for credential injection: requests presenting the placeholder Authorization header get the real bearer token injected from a file-based SDS secret; anything else is rejected before reaching the upstream. `run-proxy` owns the proxy end to end: it builds `envoy.yaml` from the allowlist, writes the SDS secret from the host credential, and force-recreates the container whenever the token rotates or the allowlist changes (reissuing the leaf certificate when the terminate-host set changes — the root CA from `generate-ca` is never touched).

Design history (reference only, not updated):

- `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md`
- `docs/superpowers/specs/2026-07-05-run-proxy-credential-monitor-design.md`
- `docs/superpowers/specs/2026-07-05-configamatron-environments-design.md`

### Access logging

Every Envoy path writes a machine-parseable access-log line to the container's stdout: `CFGM|<path-id>|<start-time>|<server-name>|<authority>|<response-code-details>`, where `path-id` is `term`, `pass`, `http`, or `deny443`. Blocked `:443` connections are caught by `listener_443`'s `default_filter_chain`, which routes to the endpoint-less `blackhole` cluster (dropping the connection) after logging the rejected SNI as `deny443`. `run-proxy` parses these lines and maps them to friendly tags in its inline log stream (each host+handling printed once); port-80 allow-vs-block is disambiguated by response-code details (`direct_response` = the default-deny 403). The access-log format never includes the `Authorization` header, so injected tokens never reach the logs.

## VM networking details

`07-setup-persistence.sh` installs two persistent units:

- **dnsmasq** answers the VM's DNS queries locally so name resolution works without outbound DNS; a netplan override pins the VM's resolver to the local stub. See `docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md` and `docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`.
- **configamatron-egress.service** DNATs the VM's outbound 80/443 traffic to Envoy on the host and installs a guarded host-only default route at boot (host-only networking hands out no DHCP gateway). See `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md` and `docs/superpowers/specs/2026-07-10-configamatron-egress-service-idempotent-design.md`. A live NAT→host-only switch does not re-run the unit: reboot, or `sudo systemctl restart configamatron-egress.service`.

## Testing

`pnpm test` runs, in fail-fast order: format check, lint, typecheck, unit tests, build, e2e tests (against `dist/cli.js`), and integration tests. The integration tests build this repository's own gitignored `.configamatron` (using `tests/fixtures/credentials.json`, never your real credential file) and bring the Envoy stack up against a mock upstream on transient ports. Docker must be running; no VM or real credential is required. The suite replaces any running proxy container, but never touches another environment's files.

`pnpm test:vm` (not part of `pnpm test`) boots a QEMU/KVM Ubuntu guest inside WSL2 and runs the real `06-trust-ca.sh` and `07-setup-persistence.sh` against the same Envoy stack the integration tests use, published at a harness-owned bridge IP. It covers the NAT-phase setup, the switch to gateway-less DHCP plus reboot (boot-time persistence of dnsmasq, the DNAT rules, and the guarded host-only default route), and a fresh gateway-less setup (interface-discovery fallback). See `docs/superpowers/specs/2026-07-06-vm-e2e-test-harness-design.md`.

One-time WSL setup: `wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/vm/<timestamp>/`.

Residual fidelity gaps vs. a real VMware VM: the guest is an Ubuntu _cloud_ image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→host-only switch keeps one subnet (production changes subnets); and open-vm-tools/hgfs sharing remains manual-only. To match Desktop's NetworkManager-only networking, the golden image **masks systemd-networkd** — the cloud image ships it enabled with a match-all dracut `.network`, and it would otherwise own the NIC and block 07's `127.0.0.1` DNS override at the systemd-resolved layer (`LinkBusy`). For the same reason `60-dns-override.yaml` sets `dhcp4: true` explicitly: on a renderer-only base netplan the override is the sole definition of the interface, so without it NetworkManager renders a dead `link-local` profile and never applies the stub nameserver.

## VM egress goes through run-proxy's host forwarder

Docker Desktop's published-port relay (WSL2 backend) accepts connections arriving on the VMware host-only interface slowly and unreliably, while loopback connections to the same Envoy ports are instant. So `docker-compose` publishes Envoy on `127.0.0.1` only, and `run-proxy` runs a byte-transparent TCP forwarder on the host-only adapter IP that pipes `:80`/`:443` to `127.0.0.1`. Forwarding is active only while `run-proxy` runs (which is required anyway for token freshness). Disable it with `--no-forward`; override the bind IP with `--forward-listen <ip>`. See docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md.
