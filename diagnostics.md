# Diagnostics

Diagnosing issues with an environment or guest setup, and maintaining the allow list.

## Verifying an environment

Read-only diagnostic scripts report whether the proxy and a guest are set up correctly. None of them change any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run `.susentorno\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** inside the VM, run `/mnt/vm-shared-linux/verify-config.sh [host-ip]`. Pass `<host-ip>` (from `setup-machine.md`) to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
- **Windows guest:** from the mounted `vm-shared-windows` share, run `.\verify-config.ps1` to discover the host when exactly one IPv4 DNS server is configured, or `.\verify-config.ps1 -HostIp <host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host.

## Watching proxy traffic

`susentorno run-hosting` streams how the proxy handled each host, inline with its own status lines. Each host/handling pair is printed once; the tracking resets when an allow-list edit restarts the proxy (so you can immediately see how the edited entries are handled) and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (VM's own TLS)
- `ALLOW HTTP` — :80, allowed
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)

## Maintaining the allow list

`current-allow-list.txt` (repo root, source controlled) is the default allow list that `susentorno init` copies into every new environment. To refresh it from an upstream network policy file:

```
susentorno import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` in the current directory by default (`-o` to override). Run it in a checkout of this repository and commit the result. It is a maintenance command — not part of environment setup — and it never touches an environment's own `proxy/allowlist.txt` (edit that file directly for per-environment changes — a running `susentorno run-hosting` picks the edit up live).
