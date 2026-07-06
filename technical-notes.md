# Technical notes

Maintainer and background material. Day-to-day setup lives in [usage.md](usage.md).

## Maintaining the allow list

`current-allow-list.txt` (repo root, source controlled) is the default allow list that `configamatron init` copies into every new environment. To refresh it from an upstream network policy file:

```
configamatron import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` in the current directory by default (`-o` to override). Run it in a checkout of this repository and commit the result. It is a maintenance command — not part of environment setup — and it never touches an environment's own `proxy/allowlist.txt` (edit that file directly for per-environment changes and re-run `configamatron build-envoy-config`).

## Environment model

- The working directory owns the environment: every command (except `init` and `import-sbx-network-policy`) operates on `<cwd>/.configamatron` and exits 1 if it is missing. There is no parent-directory search.
- There is no upgrade path for `.configamatron` folders. Rebuild from scratch: delete the folder and re-run the setup commands. Previously generated CA material can be restored into `proxy/ca/` before running `generate-ca` — a valid pair is reused, an invalid one fails loudly (key material is never overwritten).
- The compose project name is pinned (`name: configamatron` in `proxy/docker-compose.yml`), so `docker compose up` for any environment replaces the running proxy container instead of colliding with it on ports 80/443. Running the test suite does the same. This is deliberate: one proxy at a time, and switching environments (or recovering after tests) is just re-running `configamatron run-proxy` in the environment directory.
- The VM placeholder credential (`vm-shared/credentials.json`) is derived from the host's real `~/.claude/.credentials.json` at init time: `accessToken` becomes `sk-ant-oat-SANDBOX-PLACEHOLDER` (the exact value the proxy's gate.lua swaps for the real token), `refreshToken` becomes `sandbox-placeholder-refresh-token`, `expiresAt` is set far in the future, and every other field passes through so the file matches the account's real shape. The file is written with LF line endings.

## How the proxy works

Envoy runs in Docker on the host and is the VM's only network path. Allow-listed hosts are either passed through by SNI (TLS) / Host header (port 80), or TLS-terminated for credential injection: requests presenting the placeholder Authorization header get the real bearer token injected from a file-based SDS secret; anything else is rejected before reaching the upstream. `run-proxy` owns the secret lifecycle: it writes the SDS secret from the host credential and force-recreates the container whenever the token rotates.

Design history (reference only, not updated):

- `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md`
- `docs/superpowers/specs/2026-07-05-run-proxy-credential-monitor-design.md`
- `docs/superpowers/specs/2026-07-05-configamatron-environments-design.md`

### Access logging

Every Envoy path writes a machine-parseable access-log line to the container's stdout: `CFGM|<path-id>|<start-time>|<server-name>|<authority>|<response-code-details>`, where `path-id` is `term`, `pass`, `http`, or `deny443`. Blocked `:443` connections are caught by `listener_443`'s `default_filter_chain`, which routes to the endpoint-less `blackhole` cluster (dropping the connection) after logging the rejected SNI as `deny443`. The `proxy-logs` command parses these lines and maps them to friendly tags; port-80 allow-vs-block is disambiguated by response-code details (`direct_response` = the default-deny 403). The access-log format never includes the `Authorization` header, so injected tokens never reach the logs.

## VM networking details

`07-setup-persistence.sh` installs two persistent units:

- **dnsmasq** answers the VM's DNS queries locally so name resolution works without outbound DNS; a netplan override pins the VM's resolver to the local stub. See `docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md` and `docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`.
- **iptables-rules@\<host-ip\>.service** DNATs the VM's outbound 80/443 traffic to Envoy on the host and installs a guarded host-only default route at boot (host-only networking hands out no DHCP gateway). See `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`. A live NAT→host-only switch does not re-run the unit: reboot, or `sudo systemctl restart iptables-rules@<host-ip>.service`.

## Testing

`pnpm test` runs, in fail-fast order: format check, lint, typecheck, unit tests, build, e2e tests (against `dist/cli.js`), and integration tests. The integration tests build this repository's own gitignored `.configamatron` (using `tests/fixtures/credentials.json`, never your real credential file) and bring the Envoy stack up against a mock upstream on transient ports. Docker must be running; no VM or real credential is required. The suite replaces any running proxy container, but never touches another environment's files.
