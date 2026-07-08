# Verify Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two read-only diagnostic scripts — a host-side `verify-proxy.ps1` and a VM-side `verify-config.sh` — that verify the Envoy proxy is working and the VM's isolation config is in place, printing per-check PASS/FAIL/WARN diagnostics.

**Architecture:** Both scripts are environment templates, copied into `.configamatron` by `configamatron init`'s existing recursive `cpSync` — no CLI/TypeScript wiring is needed. Each script observes only (no state changes), prints one verdict line per check with the observed value on failure, and exits non-zero if any check FAILs. Their automated test coverage is the existing `tests/unit/templates.test.ts` "ships every template file" list; the script *behavior* is verified by hand against a real environment (and mirrors assertions already in `tests/vm/vm.test.ts`).

**Tech Stack:** PowerShell 5.1+ (host, matches `host-allow-vm-inbound.ps1`), Bash (VM, matches the `01`–`07` numbered scripts), `curl.exe`/`curl`, Vitest for the template-presence test.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-07-verify-scripts-design.md`. Every task's requirements implicitly include it.
- **File placement:** host script at `templates/proxy/verify-proxy.ps1`; VM script at `templates/vm-shared/verify-config.sh`. Non-numbered names (diagnostics, not setup steps).
- **Line endings:** `.gitattributes` normalizes `templates/**` to `text eol=lf`. Write both scripts with LF endings (the Write tool does this by default). Do not introduce CRLF.
- **Formatting/lint:** `templates/` is in `.prettierignore`, so the scripts are **not** covered by `pnpm format:check` or `pnpm lint`. The gate for the script-shipping tasks is `pnpm test:unit`.
- **Placeholder access token** (must match `gate.lua` and `sanitizeCredentials.ts`): `sk-ant-oat-SANDBOX-PLACEHOLDER`.
- **DNS stub answer** (from `dnsmasq-stub.conf`): every name resolves to `203.0.113.1`.
- **SDS secret path/format:** `.configamatron/proxy/secrets/sds-secret.yaml`, containing the line `inline_string: "Bearer <token>"`.
- **Host credential path:** `~/.claude/.credentials.json`, JSON with `.claudeAiOauth.accessToken`.
- **Live-probe policy:** allow-listed egress probes (`archive.ubuntu.com` :80, `pypi.org` :443) are allowed; the billable credential success call to `api.anthropic.com` is **skipped**; the credential path is proven by a wrong-`Authorization` request that `gate.lua` rejects locally with `403`.
- **Compose identity:** project `configamatron`, service `envoy` (from `templates/proxy/docker-compose.yml`).

---

### Task 1: Host verification script (`verify-proxy.ps1`)

**Files:**
- Create: `templates/proxy/verify-proxy.ps1`
- Modify: `tests/unit/templates.test.ts` (add the new file to `expectedTemplateFiles`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a standalone script. No importable symbols.

- [ ] **Step 1: Add the failing template-presence assertion**

In `tests/unit/templates.test.ts`, add `'proxy/verify-proxy.ps1'` to the `expectedTemplateFiles` array (put it next to `'proxy/host-allow-vm-inbound.ps1'`):

```typescript
  'proxy/host-allow-vm-inbound.ps1',
  'proxy/verify-proxy.ps1',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- templates`
Expected: FAIL — the "ships every template file" case reports `proxy/verify-proxy.ps1` does not exist.

- [ ] **Step 3: Create `templates/proxy/verify-proxy.ps1`**

Write this exact content (LF line endings):

```powershell
#requires -Version 5.1
<#
Read-only diagnostics for the host-side Envoy proxy. Run from the environment
directory (the folder that owns .configamatron) while the proxy is up:

    powershell -ExecutionPolicy Bypass -File .configamatron\proxy\verify-proxy.ps1

Prints one PASS/FAIL/WARN line per check, with the observed value on failure.
Exits non-zero if any check FAILs. WARN is advisory and never fails the run.

Makes real outbound requests to allow-listed hosts (archive.ubuntu.com, pypi.org)
but never spends a real credential: the injection path is checked structurally
(SDS secret freshness) and via a wrong-Authorization request that gate.lua
rejects locally with 403.
#>
[CmdletBinding()]
param(
    [string]$EnvDir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
$script:warn = 0

function Write-Section($name) { Write-Host ''; Write-Host "== $name ==" }
function Add-Pass($msg) {
    $script:pass++; Write-Host "  PASS  $msg" -ForegroundColor Green
}
function Add-Fail($msg, $detail) {
    $script:fail++
    if ($detail) { Write-Host "  FAIL  $msg -- $detail" -ForegroundColor Red }
    else { Write-Host "  FAIL  $msg" -ForegroundColor Red }
}
function Add-Warn($msg, $detail) {
    $script:warn++
    if ($detail) { Write-Host "  WARN  $msg -- $detail" -ForegroundColor Yellow }
    else { Write-Host "  WARN  $msg" -ForegroundColor Yellow }
}

# Run curl.exe and return the observed HTTP status code plus the process exit code.
function Invoke-CurlCode {
    param([Parameter(Mandatory)][string[]]$CurlArgs)
    $code = & curl.exe -s -o NUL -w '%{http_code}' @CurlArgs 2>$null
    return [pscustomobject]@{ Code = "$code".Trim(); Exit = $LASTEXITCODE }
}

$proxyDir = Join-Path $EnvDir '.configamatron\proxy'
$caCert   = Join-Path $proxyDir 'ca\cert.pem'
$sdsFile  = Join-Path $proxyDir 'secrets\sds-secret.yaml'

Write-Section 'Environment & Docker'

if (-not (Test-Path $proxyDir)) {
    Add-Fail "environment present" "no proxy dir at $proxyDir -- run this from the environment directory"
    Write-Host ''
    Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
    exit 1
}
Add-Pass "environment present ($proxyDir)"

foreach ($f in @('docker-compose.yml', 'envoy.yaml', 'ca\cert.pem')) {
    $p = Join-Path $proxyDir $f
    if (Test-Path $p) { Add-Pass "config file $f present" }
    else { Add-Fail "config file $f present" "missing $p" }
}

& docker info *> $null
if ($LASTEXITCODE -eq 0) { Add-Pass 'docker daemon reachable' }
else { Add-Fail 'docker daemon reachable' 'docker info exited non-zero -- is Docker running?' }

$envoy = & docker ps `
    --filter 'label=com.docker.compose.project=configamatron' `
    --filter 'label=com.docker.compose.service=envoy' `
    --format '{{.Names}} {{.Status}}' 2>$null
if ($envoy -match 'Up') { Add-Pass "envoy container running ($($envoy.Trim()))" }
else { Add-Fail 'envoy container running' "no running configamatron_envoy container ('$envoy') -- run 'configamatron run-proxy'" }

foreach ($port in 80, 443) {
    $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listen) { Add-Pass "host port $port listening" }
    else { Add-Fail "host port $port listening" 'no listener found' }
}

Write-Section 'Credential secret (structural, no API call)'

$hostCred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
if (-not (Test-Path $sdsFile)) {
    Add-Fail 'SDS secret present' "missing $sdsFile -- run 'configamatron run-proxy'"
}
elseif (-not (Test-Path $hostCred)) {
    Add-Warn 'SDS secret freshness' "cannot compare: no host credential at $hostCred"
}
else {
    try {
        $token = (Get-Content $hostCred -Raw | ConvertFrom-Json).claudeAiOauth.accessToken
        $sds = Get-Content $sdsFile -Raw
        if ($token -and $sds.Contains("Bearer $token")) {
            Add-Pass 'SDS secret matches current host credential'
        }
        else {
            Add-Fail 'SDS secret matches current host credential' 'token drift -- run-proxy is serving a stale token; restart it'
        }
    }
    catch {
        Add-Fail 'SDS secret freshness' "could not compare tokens: $($_.Exception.Message)"
    }
}

Write-Section 'Live proxy behavior'

$allow80 = Invoke-CurlCode @('--resolve', 'archive.ubuntu.com:80:127.0.0.1', '--max-time', '20', 'http://archive.ubuntu.com/')
if ($allow80.Exit -eq 0 -and [int]($allow80.Code) -lt 400) { Add-Pass "allow-listed :80 archive.ubuntu.com -> $($allow80.Code)" }
else { Add-Fail 'allow-listed :80 archive.ubuntu.com' "code=$($allow80.Code) curlExit=$($allow80.Exit)" }

$block80 = Invoke-CurlCode @('--resolve', 'not-allow-listed.example.com:80:127.0.0.1', '--max-time', '20', 'http://not-allow-listed.example.com/')
if ($block80.Code -eq '403') { Add-Pass 'blocked :80 -> 403 (default deny)' }
else { Add-Fail 'blocked :80 default deny' "expected 403, got code=$($block80.Code) curlExit=$($block80.Exit)" }

$allow443 = Invoke-CurlCode @('--resolve', 'pypi.org:443:127.0.0.1', '--max-time', '30', 'https://pypi.org/simple/')
if ($allow443.Exit -eq 0 -and [int]($allow443.Code) -lt 400) { Add-Pass "allow-listed passthrough :443 pypi.org -> $($allow443.Code)" }
else { Add-Fail 'allow-listed passthrough :443 pypi.org' "code=$($allow443.Code) curlExit=$($allow443.Exit)" }

$block443 = Invoke-CurlCode @('--resolve', 'blocked.example.com:443:127.0.0.1', '--max-time', '20', 'https://blocked.example.com/')
if ($block443.Exit -ne 0) { Add-Pass "blocked :443 connection dropped (curlExit=$($block443.Exit))" }
else { Add-Fail 'blocked :443 connection dropped' "expected a connection failure, but curl succeeded (code=$($block443.Code))" }

$gate = Invoke-CurlCode @('--cacert', $caCert, '--resolve', 'api.anthropic.com:443:127.0.0.1', '-H', 'Authorization: Bearer not-the-placeholder', '--max-time', '20', 'https://api.anthropic.com/')
if ($gate.Code -eq '403') { Add-Pass 'credential gate: wrong Authorization -> 403 (rejected locally, no token spent)' }
else { Add-Fail 'credential gate wrong-auth' "expected 403 from gate.lua, got code=$($gate.Code) curlExit=$($gate.Exit)" }

Write-Section 'VM reachability'

$rule = Get-NetFirewallRule -DisplayName 'Envoy Sandbox Proxy (VM inbound)' -ErrorAction SilentlyContinue
if ($rule) { Add-Pass 'host-only inbound firewall rule present' }
else { Add-Warn 'host-only inbound firewall rule present' "not found -- run host-allow-vm-inbound.ps1 (as admin) once the VM is host-only" }

$cfg = Get-NetIPConfiguration -InterfaceAlias 'VMware Network Adapter VMnet1' -ErrorAction SilentlyContinue
$hostIp = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
if ($hostIp) { Add-Pass "VMnet1 host IP: $hostIp (use as <host-ip> in VM setup)" }
else { Add-Warn 'VMnet1 host IP' 'no IPv4 on VMware Network Adapter VMnet1 -- is the host-only adapter up?' }

Write-Host ''
Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- templates`
Expected: PASS — "ships every template file" now finds `proxy/verify-proxy.ps1`.

- [ ] **Step 5: Manual behavior check (optional, needs a live environment)**

If a real environment with the proxy up is available, from the environment directory run:
`powershell -ExecutionPolicy Bypass -File .configamatron\proxy\verify-proxy.ps1`
Expected: mostly PASS lines and a `N passed, 0 failed, K warnings` footer; a stopped proxy should produce FAILs on the Docker/live sections. No behavioral test is automated — this is operator verification only.

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/verify-proxy.ps1 tests/unit/templates.test.ts
git commit -m "feat(proxy): add host-side verify-proxy.ps1 diagnostic"
```

---

### Task 2: VM verification script (`verify-config.sh`)

**Files:**
- Create: `templates/vm-shared/verify-config.sh`
- Modify: `tests/unit/templates.test.ts` (add the new file to `expectedTemplateFiles`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a standalone script. No importable symbols.

- [ ] **Step 1: Add the failing template-presence assertion**

In `tests/unit/templates.test.ts`, add `'vm-shared/verify-config.sh'` to `expectedTemplateFiles` (put it after `'vm-shared/iptables-rules@.service'`):

```typescript
  'vm-shared/iptables-rules@.service',
  'vm-shared/verify-config.sh',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- templates`
Expected: FAIL — reports `vm-shared/verify-config.sh` does not exist.

- [ ] **Step 3: Create `templates/vm-shared/verify-config.sh`**

Write this exact content (LF line endings):

```bash
#!/usr/bin/env bash
# Read-only diagnostics for the sandbox VM's isolation configuration.
#
# Usage: bash verify-config.sh [host-ip]
#   host-ip  Expected proxy host IP. If omitted, it is discovered from the
#            installed DNAT rules and reported. If given, the installed rules and
#            default route are asserted to match it.
#
# Prints one PASS/FAIL/WARN line per check, with the observed value on failure.
# Exits non-zero if any check FAILs. WARN is advisory and never fails the run.
# Uses sudo for iptables reads. Makes real outbound requests to allow-listed
# hosts but never spends a real credential (wrong-auth to api.anthropic.com is
# rejected locally by gate.lua with 403).

set -uo pipefail # deliberately NOT -e: run every check even after a failure

pass=0
fail=0
warn=0

section() { printf '\n== %s ==\n' "$1"; }
ok() {
  pass=$((pass + 1))
  printf '  PASS  %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  if [ -n "${2:-}" ]; then printf '  FAIL  %s -- %s\n' "$1" "$2"; else printf '  FAIL  %s\n' "$1"; fi
}
adv() {
  warn=$((warn + 1))
  if [ -n "${2:-}" ]; then printf '  WARN  %s -- %s\n' "$1" "$2"; else printf '  WARN  %s\n' "$1"; fi
}

# curl an HTTP(S) URL and echo the observed status code; curl's exit code is left
# in $? for the caller to read.
curl_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$1" "$2"; }

PLACEHOLDER='sk-ant-oat-SANDBOX-PLACEHOLDER'
STUB_IP='203.0.113.1'

section 'Host IP'

nat_dump="$(sudo iptables -t nat -S OUTPUT 2>/dev/null || true)"
dnat_ip="$(printf '%s\n' "$nat_dump" | sed -n 's/.*--dport 443 -j DNAT --to-destination \([0-9.]*\):443.*/\1/p' | head -n1)"
expected_ip="${1:-}"

if [ -n "$expected_ip" ]; then
  host_ip="$expected_ip"
  if [ "$dnat_ip" = "$expected_ip" ]; then
    ok "DNAT target matches requested host IP ($host_ip)"
  else
    bad 'DNAT target matches requested host IP' "requested $expected_ip, rules point at '${dnat_ip:-none}'"
  fi
elif [ -n "$dnat_ip" ]; then
  host_ip="$dnat_ip"
  ok "discovered host IP from DNAT rules: $host_ip"
else
  host_ip=''
  bad 'host IP determinable' 'no DNAT rule found and no host-ip argument given -- has 07-setup-persistence.sh run?'
fi

section 'CA trust (06)'

ca_src='/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt'
if [ -f "$ca_src" ]; then ok 'proxy CA installed'; else bad 'proxy CA installed' "missing $ca_src"; fi

if [ -e '/etc/ssl/certs/configamatron-proxy-certificate-authority.pem' ]; then
  ok 'proxy CA present in system trust bundle'
else
  bad 'proxy CA present in system trust bundle' 'no /etc/ssl/certs symlink -- did update-ca-certificates run?'
fi

node_ca="$(bash -lc 'echo $NODE_EXTRA_CA_CERTS')"
if printf '%s' "$node_ca" | grep -q 'configamatron-proxy-certificate-authority.crt'; then
  ok 'NODE_EXTRA_CA_CERTS set for login shells'
else
  bad 'NODE_EXTRA_CA_CERTS set for login shells' "got '${node_ca:-empty}'"
fi

section 'DNS stub (07)'

if [ "$(systemctl is-active dnsmasq 2>/dev/null)" = 'active' ]; then ok 'dnsmasq active'; else bad 'dnsmasq active' "is-active=$(systemctl is-active dnsmasq 2>/dev/null)"; fi
if [ "$(systemctl is-enabled dnsmasq 2>/dev/null)" = 'enabled' ]; then ok 'dnsmasq enabled at boot'; else bad 'dnsmasq enabled at boot' "is-enabled=$(systemctl is-enabled dnsmasq 2>/dev/null)"; fi

if ! command -v dig >/dev/null 2>&1; then
  adv 'dns resolution checks' 'dig not installed (dnsutils); skipping DNS answer checks'
else
  stub_direct="$(dig +short example.com @127.0.0.1 2>/dev/null | head -n1)"
  if [ "$stub_direct" = "$STUB_IP" ]; then ok "stub answers example.com -> $STUB_IP"; else bad 'stub answers via 127.0.0.1' "got '${stub_direct:-none}', want $STUB_IP"; fi

  stub_eff="$(dig +short example.com 2>/dev/null | head -n1)"
  if [ "$stub_eff" = "$STUB_IP" ]; then ok "stub is the effective resolver (example.com -> $STUB_IP)"; else bad 'stub is the effective resolver' "got '${stub_eff:-none}', want $STUB_IP"; fi
fi

if resolvectl dns 2>/dev/null | grep -q '127.0.0.1'; then
  ok 'resolvectl lists 127.0.0.1 as a resolver'
else
  bad 'resolvectl lists 127.0.0.1 as a resolver' 'netplan DNS override not applied?'
fi

section 'Routing / NAT (07)'

if printf '%s\n' "$nat_dump" | grep -q -- "--dport 443 -j DNAT --to-destination ${host_ip}:443"; then
  ok 'DNAT rule for :443 present'
else
  bad 'DNAT rule for :443 present' "no rule to ${host_ip:-<host-ip>}:443"
fi
if printf '%s\n' "$nat_dump" | grep -q -- "--dport 80 -j DNAT --to-destination ${host_ip}:80"; then
  ok 'DNAT rule for :80 present'
else
  bad 'DNAT rule for :80 present' "no rule to ${host_ip:-<host-ip>}:80"
fi

route="$(ip -4 route show default 2>/dev/null)"
if [ -z "$route" ]; then
  bad 'default route present' 'no default route (host-only mode needs the unit-installed route)'
elif printf '%s' "$route" | grep -q 'proto dhcp'; then
  ok "default route present (DHCP/NAT mode: $(printf '%s' "$route" | head -n1))"
elif [ -n "$host_ip" ] && printf '%s' "$route" | grep -q "via $host_ip"; then
  ok "host-only default route via $host_ip"
else
  adv 'default route present' "unexpected route: $(printf '%s' "$route" | head -n1)"
fi

svc="iptables-rules@${host_ip}.service"
if [ -n "$host_ip" ]; then
  if [ "$(systemctl is-active "$svc" 2>/dev/null)" = 'active' ]; then ok "$svc active"; else bad "$svc active" "is-active=$(systemctl is-active "$svc" 2>/dev/null)"; fi
  if [ "$(systemctl is-enabled "$svc" 2>/dev/null)" = 'enabled' ]; then ok "$svc enabled at boot"; else bad "$svc enabled at boot" "is-enabled=$(systemctl is-enabled "$svc" 2>/dev/null)"; fi
fi

section 'Placeholder credential'

cred="$HOME/.claude/.credentials.json"
if [ ! -f "$cred" ]; then
  bad 'placeholder credential in place' "missing $cred -- copy vm-shared/credentials.json to it"
elif grep -q "$PLACEHOLDER" "$cred"; then
  ok 'credentials.json is the placeholder'
else
  bad 'credentials.json is the placeholder' 'a NON-placeholder token is present in the VM -- a real credential must never live here'
fi

section 'Live egress'

c="$(curl_code 20 http://archive.ubuntu.com/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed :80 archive.ubuntu.com -> $c" || bad 'allow-listed :80 archive.ubuntu.com' "code=$c curlExit=$?"

c="$(curl_code 30 https://pypi.org/simple/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed passthrough :443 pypi.org -> $c" || bad 'allow-listed passthrough :443 pypi.org' "code=$c curlExit=$?"

if curl -s -o /dev/null --max-time 20 https://blocked.example.com/; then
  bad 'blocked :443 connection dropped' 'curl succeeded; expected a connection failure'
else
  ok "blocked :443 connection dropped (curlExit=$?)"
fi

c="$(curl_code 20 http://blocked.example.com/)"
if [ "$c" = '403' ]; then ok 'blocked :80 -> 403 (default deny)'; else bad 'blocked :80 default deny' "expected 403, got $c"; fi

c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: Bearer not-the-placeholder' https://api.anthropic.com/)"
if [ "$c" = '403' ]; then ok 'credential gate: wrong Authorization -> 403 (no token spent)'; else bad 'credential gate wrong-auth' "expected 403 from gate.lua, got $c"; fi

printf '\n%d passed, %d failed, %d warnings\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- templates`
Expected: PASS — "ships every template file" now finds `vm-shared/verify-config.sh`.

- [ ] **Step 5: Syntax-check the script**

Run: `bash -n templates/vm-shared/verify-config.sh`
Expected: no output, exit 0 (no bash syntax errors). If `bash` is unavailable on the host, skip — the VM e2e harness would surface a syntax error.

- [ ] **Step 6: Commit**

```bash
git add templates/vm-shared/verify-config.sh tests/unit/templates.test.ts
git commit -m "feat(vm): add verify-config.sh isolation diagnostic"
```

---

### Task 3: Document the verify scripts in `usage.md`

**Files:**
- Modify: `usage.md` (add a "Verifying an environment" section)

**Interfaces:**
- Consumes: the two scripts created in Tasks 1 and 2 (by path).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the documentation section**

In `usage.md`, insert a new `### Verifying an environment` subsection at the end of the "Isolate and verify" section (immediately before the `### Watching proxy traffic` heading). Content:

```markdown
### Verifying an environment

Two read-only diagnostic scripts report whether the proxy and the VM are set up
correctly. Neither changes any state; each prints a `PASS`/`FAIL`/`WARN` line per
check and exits non-zero if anything failed.

- **Host (proxy):** from the environment directory, with the proxy up, run
  `powershell -ExecutionPolicy Bypass -File .configamatron\proxy\verify-proxy.ps1`.
  It checks Docker and the Envoy container, that ports 80/443 are listening, that
  the injected credential secret matches your current host credential, and that
  live allow/block behavior is correct. It never spends a real token — the
  credential path is proven by a wrong-`Authorization` request the proxy rejects
  locally with `403`.
- **VM (configuration):** inside the VM, run
  `bash /mnt/hgfs/vm-shared/verify-config.sh [host-ip]`. It checks CA trust,
  the dnsmasq stub and resolver, the DNAT rules and default route, the placeholder
  credential, and live allow/block egress. Pass the `<host-ip>` from proxy setup
  to assert the rules point at it; omit it to have the script discover and report
  the IP from the installed rules.

Both make real requests to allow-listed hosts (`archive.ubuntu.com`, `pypi.org`)
and never make the billable call to `api.anthropic.com`.
```

- [ ] **Step 2: Verify formatting passes**

Run: `pnpm format:check`
Expected: PASS (`usage.md` is not in `.prettierignore`, so it must be Prettier-clean; if it reports a diff, run `pnpm format` and re-check).

- [ ] **Step 3: Commit**

```bash
git add usage.md
git commit -m "docs: document the verify-proxy and verify-config scripts"
```

---

## Self-Review

**1. Spec coverage:**
- Placement/distribution (templates copied by init) → Tasks 1 & 2 create the files; no wiring needed (verified: `initEnvironment` recursively copies `vm-shared/` and `proxy/`). Covered.
- Output & exit contract (PASS/FAIL/WARN, observed values, summary footer, non-zero on FAIL) → implemented in both scripts. Covered.
- Live-probe policy incl. wrong-auth→403 substitute and skipping the billable call → both scripts. Covered.
- Host script sections 1–4 (env/Docker, SDS-secret freshness FAIL, live behavior, firewall WARN + host IP) → Task 1. Covered.
- VM script sections 1–5 incl. host-ip discovery/assert, CA trust, DNS stub, routing/NAT, placeholder-credential loud FAIL on non-placeholder, live egress → Task 2. Covered.
- Documentation section in `usage.md` → Task 3. Covered.
- Testing note (don't break template tests) → Tasks 1 & 2 update `expectedTemplateFiles`; the design's decision that `templates.test.ts` uses per-file `existsSync` (not an exhaustive check) means additions are safe. Covered.

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to"/"write tests for the above". Full script bodies are inline. Clear.

**3. Type/name consistency:** Design decisions carried verbatim — SDS-secret mismatch is FAIL (host script), missing firewall rule is WARN (host script), non-placeholder credential is a loud FAIL (VM script). Placeholder token `sk-ant-oat-SANDBOX-PLACEHOLDER`, stub IP `203.0.113.1`, compose project/service `configamatron`/`envoy`, firewall rule name `Envoy Sandbox Proxy (VM inbound)`, and CA filename `configamatron-proxy-certificate-authority.crt` all match the source files. Consistent.
