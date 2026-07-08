# Verify scripts: host proxy + VM configuration — design

Date: 2026-07-07

## Goal

Give an operator two self-contained diagnostic scripts:

- A **host** script that verifies the Envoy proxy is up and behaving correctly.
- A **VM** script that verifies the guest's isolation configuration is in place.

Each script's output *is* the diagnostic: one line per check with a PASS/FAIL/WARN
verdict and, on failure, the actual observed value. Neither script changes any
state — they only observe.

## Non-goals

- Not a replacement for the VM e2e test harness (`pnpm test:vm`); these are
  operator tools that run against a real environment, not CI.
- No repair/remediation. Verification only.
- No billable Anthropic API call and no real credential spent (see "Credential
  gate" below).

## Placement & distribution

Both scripts ship as environment templates and are copied verbatim into
`.configamatron` by `configamatron init` (`initEnvironment` does a recursive
`cpSync` of `templates/vm-shared/` and `templates/proxy/`, so **no code wiring is
required** — a new file in either directory is picked up automatically).

- `templates/proxy/verify-proxy.ps1` → `.configamatron/proxy/verify-proxy.ps1`.
  PowerShell, matching `host-allow-vm-inbound.ps1`. Run from the environment
  directory while the proxy is up.
- `templates/vm-shared/verify-config.sh` → `.configamatron/vm-shared/verify-config.sh`,
  which reaches the guest through the existing read-only share. Bash, matching the
  `01`–`07` numbered scripts. Run inside the VM as
  `bash /mnt/hgfs/vm-shared/verify-config.sh [host-ip]`.

Names are deliberately **not** numbered: these are diagnostics runnable at any
time, not steps in the `01`–`07` setup sequence.

## Output & exit contract (both scripts)

- One line per check: `PASS` / `FAIL` / `WARN` followed by a short label and, on
  non-PASS, the actual observed value (real HTTP code, curl exit code, resolver,
  iptables line, etc.).
- Checks are grouped into labelled sections.
- A summary footer: `N passed, M failed, K warnings`.
- Exit non-zero if any check is `FAIL`. `WARN` is advisory (e.g. NAT-vs-host-only
  nuances) and never fails the run.

## Live-probe policy

Approved scope: **full end-to-end egress probing, minus the billable credential
call.**

- Live egress probes make real outbound requests to allow-listed hosts
  (`archive.ubuntu.com` on :80, `pypi.org` on :443). Harmless but not zero-network.
- The credential-injection **success** path (placeholder `Authorization` →
  `api.anthropic.com` → 200) is **skipped** — it would spend a real token and hit
  Anthropic.
- **Credential gate** substitute: a request to `api.anthropic.com:443` carrying a
  *wrong* `Authorization` header returns `403` from `gate.lua`, which rejects
  locally **before** reaching the upstream. This proves the injection-gating path
  is wired without spending a token or calling Anthropic. This is the same probe
  the VM e2e test uses (`tests/vm/vm.test.ts`, the `wrongAuth → 403` assertion).

Probes use the correct SNI by pointing the real hostname at the proxy:
`curl --resolve <host>:<port>:<proxy-ip>` with `--cacert` set to the environment's
proxy CA (`.configamatron/proxy/ca/cert.pem` on the host; the system trust store
in the VM). On the host `<proxy-ip>` is `127.0.0.1`; in the VM the probes use the
normal path (dnsmasq + DNAT), so no `--resolve` is needed.

## Host script — `verify-proxy.ps1`

Run from the environment directory; talks to Envoy on `127.0.0.1`. Bails early
with a clear message if `.configamatron/proxy` is absent.

Sections:

1. **Environment & Docker**
   - `.configamatron/proxy` present (`docker-compose.yml`, `envoy.yaml`, `ca/cert.pem`).
   - `docker info` succeeds (daemon reachable).
   - The `configamatron` compose project's Envoy container is running.
   - Host ports 80 and 443 are listening.
2. **Credential secret (structural — no API call)**
   - `.configamatron/proxy/secrets/sds-secret.yaml` exists.
   - Its `inline_string: "Bearer <token>"` token matches the host's current
     `~/.claude/.credentials.json` `accessToken`. Mismatch ⇒ FAIL (proxy is
     serving a stale token — `run-proxy` isn't tracking rotation); this is how we
     verify injection is wired and fresh without a live call.
3. **Live proxy behavior** (`curl.exe --resolve … --cacert …`)
   - allow-listed `:80` (`archive.ubuntu.com`) → HTTP `<400`.
   - blocked `:80` (`not-allow-listed.example.com`) → `403` (default-deny).
   - allow-listed passthrough `:443` (`pypi.org/simple/`) → HTTP `<400`.
   - blocked `:443` (`blocked.example.com`) → connection dropped (curl non-zero exit).
   - **credential gate:** wrong `Authorization` to `api.anthropic.com:443` → `403`.
4. **VM reachability**
   - The `host-allow-vm-inbound` firewall rule ("Envoy Sandbox Proxy (VM inbound)")
     exists (`Get-NetFirewallRule`). Absent ⇒ WARN (only needed once the VM is on
     host-only; the operator may not have run it yet).
   - Print the VMnet1 host IP (the `<host-ip>` used in VM setup), when discoverable.

## VM script — `verify-config.sh`

Run inside the guest. Usage: `verify-config.sh [host-ip]`.

- **host-ip discovery:** if the argument is omitted, discover the expected host IP
  from the installed DNAT rule (`iptables -t nat -S OUTPUT`) / the
  `iptables-rules@<ip>.service` unit name, and report the value it found. If the
  argument is given, assert the installed rules/route point at that IP and FAIL on
  mismatch.

Sections:

1. **CA trust** (06)
   - `/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt`
     installed and present in the system bundle.
   - `NODE_EXTRA_CA_CERTS` set in a login shell
     (`bash -lc 'echo $NODE_EXTRA_CA_CERTS'` contains the CA path).
2. **DNS stub** (07)
   - `dnsmasq` service active and enabled.
   - `dig +short example.com @127.0.0.1` → `203.0.113.1`.
   - `resolvectl` resolver includes `127.0.0.1`.
   - Effective `dig +short example.com` (no explicit server) → `203.0.113.1`.
3. **Routing / NAT** (07)
   - Both DNAT rules present: `--dport 443 -j DNAT --to-destination <host-ip>:443`
     and the `:80` equivalent.
   - A default route is present (via `<host-ip>` in host-only mode). Absent ⇒ FAIL;
     a DHCP-supplied route in NAT mode ⇒ PASS with a note.
   - `iptables-rules@<host-ip>.service` active and enabled.
4. **Placeholder credential**
   - `~/.claude/.credentials.json` present and is the placeholder (accessToken ==
     `sk-ant-oat-SANDBOX-PLACEHOLDER`). Missing ⇒ FAIL; a *non*-placeholder token ⇒
     FAIL loudly (a real credential must never live in the VM).
5. **Live egress** (through the real dnsmasq + DNAT path)
   - allow-listed `:80` (`archive.ubuntu.com`) → HTTP `<400`.
   - allow-listed passthrough `:443` (`pypi.org/simple/`) → HTTP `<400`.
   - blocked `:443` (`blocked.example.com`) → connection dropped (curl non-zero exit).
   - blocked `:80` (`blocked.example.com`) → `403`.
   - **credential gate:** wrong `Authorization` to `https://api.anthropic.com/` → `403`.

## Testing

- Both scripts are shell/PowerShell, exercised by hand against a real environment;
  no unit test is planned for the script bodies themselves.
- The VM script's checks mirror the assertions already covered by
  `tests/vm/vm.test.ts`, so the e2e harness remains the automated source of truth
  for the guest configuration; `verify-config.sh` is the operator-facing echo of
  the same checks.
- Adding the two template files must not break existing tests that assert on
  template directory contents — confirm during implementation
  (`pnpm test:unit`, `pnpm test:e2e`).

## Documentation

Add a short "Verifying an environment" section to `usage.md` pointing at both
scripts (host: run from the environment directory; VM: run from the share), and
note that they are read-only diagnostics.
