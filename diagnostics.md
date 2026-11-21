# Diagnostics

Diagnosing issues with an environment or guest setup, and maintaining the allow list, auth list, and block list.

## Verifying an environment

Read-only diagnostic scripts report whether the proxy stack and a guest are set up correctly. None of them change any state; each prints a `PASS`/`FAIL`/`WARN` line per check and exits non-zero if anything failed.

- **Host (proxy stack):** from the environment directory, with the proxy stack up, run `.susentorno\proxy\verify-proxy.ps1`.
- **Ubuntu guest:** inside the VM, run `/mnt/vm-shared-linux/verify-config.sh [host-ip]`. Pass `<host-ip>` from `setup-machine.md` to assert the rules point at it; omit it to have the script discover and report the IP from the installed rules.
- **Windows guest:** inside the VM, run the diagnostic straight from the share: `powershell -NoProfile -ExecutionPolicy Bypass -File \\<internal-switch-host-ip>\vm-shared-windows\verify-config.ps1`. It is a read-only check, not a setup step, and `susentorno setup-guest-windows` has already left the guest a share credential for that address. It discovers the host when exactly one IPv4 DNS server is configured; add `-HostIp <host-ip>` to check an explicit address. It checks that the configured resolver is the host and that names resolve to the host. The `-ExecutionPolicy Bypass` applies to that one process only.

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
- `AUTH REJECTED` — a TLS-terminated host answered 401. Unlike the tags above, it prints on every occurrence. It usually means upstream refused the injected host token, though a request the guest sent with no credential at all also lands here.

## Credential refresh lines

`run-hosting` keeps each host credential (`claude`, `codex`) fresh by watching its file and, 3 minutes before expiry (`--refresh-window`), nudging that CLI on the host to refresh. Clock times on these lines are UTC, like the access-log lines.

- `claude: token expires 01:32:05Z, in 7h59m` — startup: the expiry of the token the proxy is serving.
- `claude: nudging the CLI to refresh (...)`, then `claude: nudge succeeded; waiting up to 2m0s for the refreshed token` — a nudge fired and the CLI exited cleanly. Success means only that the CLI ran; the refresh has landed once the restart line below appears.
- `claude: nudge failed: <stderr> (attempt n/3)` or `claude: token was not refreshed within 2m0s of the nudge (attempt n/3)` — a failed attempt. Exhausting `--max-attempts` stops `run-hosting`.
- `restarting proxy — claude credentials changed (expiry 17:32:05Z → 01:32:05Z; after a run-hosting nudge)` — the refresh followed a nudge. `no nudge pending` instead means the file changed from outside `run-hosting`, such as running `claude` on the host yourself.

A guest that reports "Login expired · Please run /login" around a rotation is worth checking against these lines: `AUTH REJECTED` lines for `api.anthropic.com` near a `restarting proxy` line point at the window while the proxy still served the previous token.

## A terminated destination returns 503

The proxy verifies every TLS-terminated upstream's certificate — both that it chains to the **upstream trust bundle** and that it carries a DNS SAN matching the destination hostname. A failure surfaces to the guest as a 503, and the reason is on the `CFGM|` access-log line: `%RESPONSE_CODE_DETAILS%` carries Envoy's TLS error text and `%RESPONSE_FLAGS%` shows the upstream failure.

Two causes are far more likely than the rest:

- **The origin's certificate does not cover the name being dialled.** Check the SANs the origin actually serves against the hostname in `auth-list.txt`.
- **An ambient interception CA never reached the bundle.** On a machine behind a TLS-intercepting proxy, the interceptor's CA must be in the host's trust store for the proxy to accept it. Compare the ambient count on `run-hosting`'s startup line — `upstream trust bundle: N public roots (node vX) + M ambient = ...` — against expectation. `M` of 0 on a machine you know is intercepted means the CA is not in `LocalMachine\Root` or `CurrentUser\Root` where the enumeration looks.

## Maintaining the allow list, auth list, and block list

`templates/proxy/allow-list.txt`, `templates/proxy/auth-list.txt`, and `templates/proxy/block-list.txt` are the source-controlled default network policy that `susentorno init` copies into every new environment. To refresh the allow list and auth list from an upstream network policy file:

```
susentorno import-sbx-network-policy <policy-file>
```

It writes `templates/proxy/allow-list.txt` and `templates/proxy/auth-list.txt` relative to the current directory by default (`--allow-output`/`--auth-output` to override). The `templates/proxy/` directory must already exist. It never touches `templates/proxy/block-list.txt` or an environment's own `proxy/{allow-list,auth-list,block-list}.txt`; edit those directly for per-environment changes. A running `susentorno run-hosting` picks up an edit to any of the three live files. Run the import command from the root of this repository and commit the result; it is a maintenance command, not part of environment setup.

To try enabling some new part of the web without editing `allow-list.txt` up front, run `susentorno run-hosting --skip-allow-list`, use whatever you need, and watch for `ALLOW OPEN` lines — each one is a `domain:port` you can add to `allow-list.txt` before turning the flag back off.
