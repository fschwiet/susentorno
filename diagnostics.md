# Diagnostics

Diagnosing issues with an environment or guest setup, and maintaining the allow list, auth list, and block list.

## Verifying an environment

Read-only diagnostic scripts report whether the proxy stack and a guest are set up correctly. None of them change any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy stack):** from the environment directory, with the proxy stack up, run `.susentorno\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** inside the VM, run `/mnt/vm-shared-linux/verify-config.sh [host-ip]`. Pass `<host-ip>` from `setup-machine.md` to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
- **Windows guest:** from the mounted `vm-shared-windows` share, run `.\verify-config.ps1` to discover the host when exactly one IPv4 DNS server is configured, or `.\verify-config.ps1 -HostIp <host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host.

## Watching proxy traffic

`susentorno run-hosting` streams how the proxy stack handled each host, inline with its own status lines. Each line shows `domain:port` so it can be pasted directly into `allow-list.txt` or `auth-list.txt`. Each host/handling pair is printed once; tracking resets when an allow-list, auth-list, or block-list edit restarts the proxy and survives credential-rotation restarts.

- `ALLOW CRED` — :443, TLS-terminated, real token injected
- `ALLOW PASS` — :443, SNI passthrough (guest's own TLS)
- `ALLOW HTTP` — :80, allowed
- `ALLOW MCP` — :443, routed to a host-run MCP server
- `ALLOW OPEN` — not on the allow list, auth list, or block list; passed through only because `run-hosting` was started with `--skip-allow-list`
- `BLOCK TLS` — :443, no allow-list match (connection dropped)
- `BLOCK HTTP` — :80, not allow-listed (403)
- `BLOCK LIST` — denied specifically because the host matched an entry in `block-list.txt` (`--skip-allow-list` does not override this)

## Maintaining the allow list, auth list, and block list

`current-allow-list.txt`, `current-auth-list.txt`, and `current-block-list.txt` (repo root, source controlled) are the default allow list, auth list, and block list that `susentorno init` copies into every new environment. To refresh the allow list and auth list from an upstream network policy file:

```
susentorno import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` and `current-auth-list.txt` in the current directory by default (`--allow-output`/`--auth-output` to override). It never touches `current-block-list.txt` or an environment's own `proxy/{allow-list,auth-list,block-list}.txt`; edit those directly for per-environment changes. A running `susentorno run-hosting` picks up an edit to any of the three live files. Run the import command in a checkout of this repository and commit the result; it is a maintenance command, not part of environment setup.

To try enabling some new part of the web without editing `allow-list.txt` up front, run `susentorno run-hosting --skip-allow-list`, use whatever you need, and watch for `ALLOW OPEN` lines — each one is a `domain:port` you can add to `allow-list.txt` before turning the flag back off.
