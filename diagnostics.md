# Diagnostics

Diagnosing issues with an environment or guest setup, and maintaining the allow list, auth list, and block list.

## Verifying an environment

Read-only diagnostic scripts report whether the proxy and a guest are set up correctly. None of them change any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run `.susentorno\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** inside the VM, run `/mnt/vm-shared-linux/verify-config.sh [host-ip]`.
- **Windows guest:** from the mounted `vm-shared-windows` share, run `.erify-config.ps1` or `.erify-config.ps1 -HostIp <host-ip>`.

## Watching proxy traffic

`susentorno run-hosting` streams how the proxy handled each host. Each line shows `domain:port`, and each host/handling pair is printed once.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough
- `ALLOW HTTP` — :80, allowed
- `ALLOW MCP` — :443, routed to a host-run MCP server
- `ALLOW OPEN` — passed through because `--skip-allow-list` was set
- `BLOCK TLS` — :443, no allow-list match
- `BLOCK HTTP` — :80, not allow-listed (403)
- `BLOCK LIST` — denied because the host matched `block-list.txt`; skip mode does not override this

## Maintaining the allow list, auth list, and block list

`current-allow-list.txt`, `current-auth-list.txt`, and `current-block-list.txt` are the default files copied by `susentorno init`. `susentorno import-sbx-network-policy <policy-file>` refreshes the first two; use `--allow-output` and `--auth-output` to override their paths. It never changes the block list.

Edit an environment’s `proxy/{allow-list,auth-list,block-list}.txt` directly; a running `run-hosting` picks up edits to any of the three. To discover hosts without editing the allow list first, run `susentorno run-hosting --skip-allow-list` and record `ALLOW OPEN` lines.
