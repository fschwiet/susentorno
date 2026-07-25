# Verifier Script Defects Implementation Plan

**Goal:** Fix the four verifier-script defects in
`docs/honist-v/specs/2026-07-25-verifier-script-defects-design.md`, so each
verifier reports the truth instead of a misleading pass/fail.

**Architecture:** No new files, no shared abstractions. Each fix is a
self-contained edit to one of three existing PowerShell/bash scripts
(`templates/proxy/verify-proxy.ps1`, `templates/vm-shared-windows/verify-config.ps1`,
`templates/vm-shared/verify-config.sh`), validated by copying the edited
template into the local `.configamatron` environment (which is gitignored,
generated content — see `src/initEnv.ts:86-91`) and running the real script
against a live target: the Windows host itself, the `sus-windows` Hyper-V
guest, or (after the checkpoint below) an Ubuntu guest.

**Tech Stack:** PowerShell 5.1 (Windows scripts), POSIX `sh`/bash (Linux
script), Docker CLI, curl.

## Global Constraints

- Edit the canonical files under `templates/`, never the generated copies
  under `.configamatron/` or an SMB share — those are overwritten by
  `configamatron init` and are not tracked by git.
- No unit tests are being added for this work (an explicit scope decision
  during design review) — every task's test cycle is "edit template → sync
  the one changed file into the live environment → run the real script →
  read its PASS/FAIL/WARN output", not an automated test suite.
- Every task's validation must show the actual PASS/FAIL/WARN line(s) the
  script prints, not just "the exit code was 0".
- Commit only the `templates/` file(s) touched by each task. Never commit
  anything under `.configamatron/`.

---

## Prerequisite: start the proxy

Tasks 1–2 need a running Envoy container to inspect and to fetch through.
This only needs to be done once.

- [ ] **Step 1: Confirm the environment is already provisioned**

Run: `Test-Path C:\code\configamatron\.configamatron\proxy\ca\cert.pem`
Expected: `True` (the CA and secrets already exist in this checkout, so
`run-proxy` can start directly — no `configamatron generate-ca` needed).

- [ ] **Step 2: Start run-proxy in the background**

Run (from `C:\code\configamatron`, leave it running — it's a foreground
process that owns the container lifecycle, but the container itself keeps
running if the process is later stopped):

```powershell
cd C:\code\configamatron
pnpm cli run-proxy
```

Run this in a background terminal/job. Wait for its log line
`run-proxy: gateway listening on 127.0.0.1, <ip> :80/443` before continuing.

- [ ] **Step 3: Confirm the envoy container is up**

Run: `docker ps --filter 'label=com.docker.compose.project=configamatron' --format '{{.Names}} {{.Status}}'`
Expected: one line containing `configamatron-envoy-blue` (or `-green`) and
`Up`.

---

## Task 1: `verify-proxy.ps1` — ownership cross-check (Fix 1)

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1:181-191` (between the existing
  "envoy container running" check and the port-listening loop)

**Interfaces:**

- Consumes: `$envoy` (array of `"<name> <status>"` strings, already computed
  at line 181), `$proxyDir` (already computed at line 157), the existing
  `Add-Pass`/`Add-Fail` helpers.
- Produces: nothing consumed by later tasks — this check either passes
  silently or exits the script.

- [ ] **Step 1: Insert the ownership cross-check**

In `templates/proxy/verify-proxy.ps1`, find:

```powershell
$envoy = & docker ps `
    --filter 'label=com.docker.compose.project=configamatron' `
    --format '{{.Names}} {{.Status}}' 2>$null | Where-Object { $_ -match 'envoy' }
if ($envoy -match 'Up') { Add-Pass "envoy container running ($(($envoy | Select-Object -First 1).Trim()))" }
else { Add-Fail 'envoy container running' "no running configamatron envoy container ('$envoy') -- run 'configamatron run-proxy'" }

foreach ($port in 80, 443) {
```

Replace it with:

```powershell
$envoy = & docker ps `
    --filter 'label=com.docker.compose.project=configamatron' `
    --format '{{.Names}} {{.Status}}' 2>$null | Where-Object { $_ -match 'envoy' }
if ($envoy -match 'Up') { Add-Pass "envoy container running ($(($envoy | Select-Object -First 1).Trim()))" }
else { Add-Fail 'envoy container running' "no running configamatron envoy container ('$envoy') -- run 'configamatron run-proxy'" }

# A running envoy container's name is global (Docker doesn't namespace by
# checkout), so finding one running says nothing about which environment it
# belongs to. Cross-check by inspecting its bind mounts: envoy.yaml is always
# mounted from <environment>\.configamatron\proxy\envoy.yaml, so that mount's
# parent directory identifies the owning environment. Checked for every
# matching container, since docker-compose.yml defines both a blue and a
# green envoy service and either or both can be running during a transition.
$envoyNames = @($envoy | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
if ($envoyNames.Count -gt 0) {
    $resolvedExpected = Resolve-Path $proxyDir -ErrorAction SilentlyContinue
    $expectedProxyDir = if ($resolvedExpected) { $resolvedExpected.Path.TrimEnd('\') } else { $proxyDir.TrimEnd('\') }

    foreach ($name in $envoyNames) {
        $mountsJson = & docker inspect --format '{{json .Mounts}}' $name 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $mountsJson) {
            Add-Fail "envoy container '$name' ownership" 'docker inspect failed -- could not read its mounted config'
            continue
        }

        $mounts = $mountsJson | ConvertFrom-Json
        $configMount = $mounts | Where-Object { $_.Destination -eq '/etc/envoy/envoy.yaml' -and $_.Type -eq 'bind' } | Select-Object -First 1
        if (-not $configMount) {
            Add-Fail "envoy container '$name' ownership" 'no bind mount found at /etc/envoy/envoy.yaml -- cannot verify which environment this container belongs to'
            continue
        }

        $actualProxyDir = Split-Path -Parent $configMount.Source
        $resolvedActual = Resolve-Path $actualProxyDir -ErrorAction SilentlyContinue
        $actualProxyDirResolved = if ($resolvedActual) { $resolvedActual.Path.TrimEnd('\') } else { $actualProxyDir.TrimEnd('\') }

        if ($actualProxyDirResolved -ieq $expectedProxyDir) {
            Add-Pass "envoy container '$name' belongs to this environment ($expectedProxyDir)"
        } else {
            Add-Fail "envoy container '$name' belongs to this environment" "its config is mounted from '$actualProxyDirResolved', not '$expectedProxyDir' -- this Envoy belongs to a different environment; run this script from that environment instead"
            Write-Host ''
            Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
            exit 1
        }
    }
}

foreach ($port in 80, 443) {
```

- [ ] **Step 2: Sync the edited script into the live environment**

```powershell
Copy-Item C:\code\configamatron\templates\proxy\verify-proxy.ps1 C:\code\configamatron\.configamatron\proxy\verify-proxy.ps1 -Force
```

- [ ] **Step 3: Run it against the matched environment and confirm PASS**

```powershell
cd C:\code\configamatron
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1
```

Expected: a new line `PASS  envoy container 'configamatron-envoy-blue' belongs
to this environment (...)` (or `-green`, whichever is running) appears in the
"Environment & Docker" section, and the script continues into "Credential
secret", "Live proxy behavior", etc. as before.

- [ ] **Step 4: Reproduce the original bug and confirm the new FAIL**

Set up a decoy environment directory that looks like a real one (has the
three files the earlier "config file present" loop checks for) but isn't the
one `run-proxy` is actually serving:

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\configamatron-decoy-env\.configamatron\proxy\ca" | Out-Null
'decoy' | Set-Content "$env:TEMP\configamatron-decoy-env\.configamatron\proxy\docker-compose.yml"
'decoy' | Set-Content "$env:TEMP\configamatron-decoy-env\.configamatron\proxy\envoy.yaml"
'decoy' | Set-Content "$env:TEMP\configamatron-decoy-env\.configamatron\proxy\ca\cert.pem"
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1 -EnvDir "$env:TEMP\configamatron-decoy-env"
```

Expected: `PASS environment present`, `PASS config file ... present` (x3),
`PASS docker daemon reachable`, `PASS envoy container running`, then
`FAIL  envoy container 'configamatron-envoy-blue' belongs to this environment
-- its config is mounted from 'C:\code\configamatron\.configamatron\proxy',
not '<decoy path>' -- this Envoy belongs to a different environment; run this
script from that environment instead`, then the script exits (the final
summary line prints and the process exits 1) **without** reaching "Credential
secret" or any later section. Compare this against the old behavior described
in `docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md` §1 — the
misleading "SDS secret matches current host credential -- token drift" FAIL
must not appear at all now, because the script never reaches that section.

- [ ] **Step 5: Clean up the decoy directory**

```powershell
Remove-Item -Recurse -Force "$env:TEMP\configamatron-decoy-env"
```

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/verify-proxy.ps1
git commit -m "fix: verify-proxy.ps1 cross-checks envoy container ownership before trusting its config"
```

---

## Task 2: `verify-proxy.ps1` — pypi.org URL swap (Fix 4, host portion)

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1:228` (already renumbered after
  Task 1's insertion — search for the text below rather than the line
  number)

**Interfaces:**

- Consumes: `Invoke-CurlCode` (already defined; unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Swap the URL**

Find:

```powershell
$allow443 = Invoke-CurlCode @('--resolve', 'pypi.org:443:127.0.0.1', '--max-time', '30', 'https://pypi.org/simple/')
```

Replace with:

```powershell
$allow443 = Invoke-CurlCode @('--resolve', 'pypi.org:443:127.0.0.1', '--max-time', '30', 'https://pypi.org/')
```

- [ ] **Step 2: Sync and rerun**

```powershell
Copy-Item C:\code\configamatron\templates\proxy\verify-proxy.ps1 C:\code\configamatron\.configamatron\proxy\verify-proxy.ps1 -Force
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1
```

Expected: `PASS  allow-listed passthrough :443 pypi.org -> 200` in the "Live
proxy behavior" section, on this run and (if you rerun immediately) on a
second run — there should no longer be any scenario where this line can read
`code=200 curlExit=28`.

- [ ] **Step 3: Commit**

```bash
git add templates/proxy/verify-proxy.ps1
git commit -m "fix: verify-proxy.ps1 tests passthrough with a small pypi.org page instead of the 44MB /simple/ index"
```

---

## Task 3: `verify-config.ps1` — DNS-based host-IP discovery (Fix 3)

**Files:**

- Modify: `templates/vm-shared-windows/verify-config.ps1:15-29`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `$HostIp` may now be set by discovery even when the `-HostIp`
  parameter was omitted; every check below "Host IP" in this script already
  reads `$HostIp`, so no other code needs to change.

- [ ] **Step 1: Move DNS-server discovery ahead of the Host IP section**

Find:

```powershell
$PLACEHOLDER = 'sk-ant-oat-SANDBOX-PLACEHOLDER'
Section 'Host IP'
if ($HostIp) { Ok "using host IP $HostIp" } else { Bad 'host IP supplied' 'pass the Internal-switch host IP' }
```

Replace with:

```powershell
$PLACEHOLDER = 'sk-ant-oat-SANDBOX-PLACEHOLDER'

# The DHCP-assigned DNS server is a reliable stand-in for "the host IP" on
# this branch's host-side-DNS design: the host serves both DNS and the
# gateway from the same address. Reusing it here (rather than picking among
# possibly-multiple default routes by metric) avoids a whole class of
# ambiguity a route-based discovery would have to resolve.
$dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique

Section 'Host IP'
if ($HostIp) {
  Ok "using host IP $HostIp"
} elseif ($dnsServers.Count -eq 1) {
  $HostIp = $dnsServers[0]
  Ok "discovered host IP $HostIp from the DHCP-assigned DNS server"
} else {
  Bad 'host IP determinable' "pass -HostIp explicitly -- found $($dnsServers.Count) DHCP-assigned DNS server(s) ('$($dnsServers -join ', ')'), need exactly 1 to discover unambiguously"
}
```

- [ ] **Step 2: Remove the now-duplicate `$dnsServers` line**

Find (further down, in the "Host DHCP/DNS (05)" section):

```powershell
Section 'Host DHCP/DNS (05)'
$dnsServers = Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique
if ($HostIp -and $dnsServers -contains $HostIp) { Ok "resolver points at the host ($HostIp)" } else { Bad "resolver points at the host ($HostIp)" "got '$($dnsServers -join ', ')'" }
```

Replace with:

```powershell
Section 'Host DHCP/DNS (05)'
if ($HostIp -and $dnsServers -contains $HostIp) { Ok "resolver points at the host ($HostIp)" } else { Bad "resolver points at the host ($HostIp)" "got '$($dnsServers -join ', ')'" }
```

(`$dnsServers` is now computed once, above the "Host IP" section, and reused
here — this is also what makes discovery and the supplied-`-HostIp`
assertion consistent, per the design doc's Fix 3.)

- [ ] **Step 3: Sync into the share and ask for a guest run**

```powershell
Copy-Item C:\code\configamatron\templates\vm-shared-windows\verify-config.ps1 C:\code\configamatron\.configamatron\vm-shared-windows\verify-config.ps1 -Force
```

On the `sus-windows` guest (via its console/RDP session — this cannot be
driven from the host shell), run, with **no argument**:

```powershell
cd \\192.168.67.1\vm-shared-windows
.\verify-config.ps1
```

Expected: `PASS  discovered host IP 192.168.67.1 from the DHCP-assigned DNS
server` as the first line under "Host IP", and the same 100% pass result
already observed with `.\verify-config.ps1 192.168.67.1` (the explicit-IP
form). Report the full output back before continuing.

- [ ] **Step 4: Commit**

```bash
git add templates/vm-shared-windows/verify-config.ps1
git commit -m "fix: verify-config.ps1 discovers the host IP instead of requiring it, matching the docs and the .sh script"
```

---

## Task 4: `verify-config.ps1` — pypi.org URL swap + exit-code check (Fix 4, Windows-guest portion)

**Files:**

- Modify: `templates/vm-shared-windows/verify-config.ps1` (the "Live egress"
  section)

**Interfaces:**

- Consumes: `HttpCode` (already defined; unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Swap the URL and capture the curl exit code**

Find:

```powershell
$c = HttpCode 'https://pypi.org/simple/' 30
if ($c -and [int]$c -lt 400) { Ok "allow-listed :443 pypi.org -> $c" } else { Bad 'allow-listed :443 pypi.org' "code=$c" }
```

Replace with:

```powershell
$c = HttpCode 'https://pypi.org/' 30
$pypiExit = $LASTEXITCODE
if ($c -and [int]$c -lt 400 -and $pypiExit -eq 0) { Ok "allow-listed :443 pypi.org -> $c" } else { Bad 'allow-listed :443 pypi.org' "code=$c curlExit=$pypiExit" }
```

(`HttpCode`'s last statement is the `curl.exe` call, so `$LASTEXITCODE` right
after calling it still reflects curl's own exit code — nothing else native
runs in between.)

- [ ] **Step 2: Sync into the share and ask for a guest run**

```powershell
Copy-Item C:\code\configamatron\templates\vm-shared-windows\verify-config.ps1 C:\code\configamatron\.configamatron\vm-shared-windows\verify-config.ps1 -Force
```

On the `sus-windows` guest, run:

```powershell
cd \\192.168.67.1\vm-shared-windows
.\verify-config.ps1 192.168.67.1
```

Expected: `PASS  allow-listed :443 pypi.org -> 200` under "Live egress", with
no other lines changed. Report the full output back before continuing.

- [ ] **Step 3: Commit**

```bash
git add templates/vm-shared-windows/verify-config.ps1
git commit -m "fix: verify-config.ps1 tests passthrough with a small pypi.org page and asserts curl actually succeeded"
```

---

## Task 5: Windows-side regression pass

**Files:** none (verification only).

- [ ] **Step 1: Full rerun of `verify-proxy.ps1`**

```powershell
cd C:\code\configamatron
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1
```

Confirm every section's PASS/FAIL/WARN counts match what they were before
this plan started, plus the new ownership PASS from Task 1 and the pypi.org
PASS from Task 2. No new FAILs anywhere.

- [ ] **Step 2: Full rerun of `verify-config.ps1` on `sus-windows`**

On the guest, with no argument:

```powershell
cd \\192.168.67.1\vm-shared-windows
.\verify-config.ps1
```

Confirm 100% pass, including the discovered-IP line from Task 3 and the
pypi.org line from Task 4. Report the full output back.

- [ ] **Step 3: Stop or leave run-proxy running**

If you're continuing straight to the Ubuntu VM in this same session, leave
`run-proxy` running (the Ubuntu guest's own "Live egress" checks need it).
Otherwise, `Ctrl-C` the `pnpm cli run-proxy` process — the container itself
stays up per its own documented behavior.

---

## >>> CHECKPOINT: switch to the Ubuntu VM here <<<

Everything above this line is verifiable from the Windows host and the
`sus-windows` guest, and should be done and committed before continuing.

Everything below needs the Ubuntu guest to actually run `verify-config.sh`
against. **Stop here and switch to the Ubuntu VM manually before starting
Task 6.**

---

## Task 6: `verify-config.sh` — `getent ahostsv4` fix (Fix 2a)

**Files:**

- Modify: `templates/vm-shared/verify-config.sh:121`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `$resolved`, used two lines below (unchanged).

- [ ] **Step 1: Swap `getent hosts` for `getent ahostsv4`**

Find:

```bash
resolved="$(getent hosts example.com 2>/dev/null | awk '{print $1}' | head -n1)"
```

Replace with:

```bash
resolved="$(getent ahostsv4 example.com 2>/dev/null | awk '{print $1}' | head -n1)"
```

- [ ] **Step 2: Sync into the share and run on the Ubuntu guest**

From the host (or wherever `.configamatron/vm-shared` is mounted from):

```bash
cp templates/vm-shared/verify-config.sh .configamatron/vm-shared/verify-config.sh
```

On the Ubuntu guest:

```bash
bash verify-config.sh <host-ip>
```

Expected: `PASS  names resolve to the host (<host-ip>)` under "Host DNS (05)".

- [ ] **Step 3: Commit**

```bash
git add templates/vm-shared/verify-config.sh
git commit -m "fix: verify-config.sh reads the A record with ahostsv4 instead of relying on AAAA absence"
```

---

## Task 7: `verify-config.sh` — anchored resolver match (Fix 2b)

**Files:**

- Modify: `templates/vm-shared/verify-config.sh:128-132`

**Interfaces:**

- Consumes: `$host_ip` (already computed earlier in the script; unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the substring grep with exact-token matching**

Find:

```bash
if [ -n "$host_ip" ] && resolvectl dns 2>/dev/null | grep -q "$host_ip"; then
  ok "resolver points at the host ($host_ip)"
else
  bad 'resolver points at the host' "resolvectl dns: $(resolvectl dns 2>/dev/null | tr '\n' ' ')"
fi
```

Replace with:

```bash
resolver_match=0
if [ -n "$host_ip" ]; then
  while IFS= read -r line; do
    servers="${line#*:}"
    for tok in $servers; do
      if [ "$tok" = "$host_ip" ]; then
        resolver_match=1
      fi
    done
  done <<EOF
$(resolvectl dns 2>/dev/null)
EOF
fi
if [ "$resolver_match" = 1 ]; then
  ok "resolver points at the host ($host_ip)"
else
  bad 'resolver points at the host' "resolvectl dns: $(resolvectl dns 2>/dev/null | tr '\n' ' ')"
fi
```

(`resolvectl dns` prints lines like `Global: 192.168.67.1` or
`Link 2 (eth0): 192.168.67.1 8.8.8.8` — everything after the first colon is
one or more whitespace-separated server addresses. `${line#*:}` strips the
prefix up to and including the first colon; the `for tok in $servers` loop
then relies on normal shell word-splitting to check each address as a whole
token, so `192.168.67.1` no longer matches inside `192.168.67.164`.)

- [ ] **Step 2: Sync and run on the Ubuntu guest**

```bash
cp templates/vm-shared/verify-config.sh .configamatron/vm-shared/verify-config.sh
```

On the guest:

```bash
bash verify-config.sh <host-ip>
```

Expected: `PASS  resolver points at the host (<host-ip>)` under "Host DNS
(05)".

- [ ] **Step 3: Manually confirm the false-positive case is closed**

On the guest, simulate the substring-collision scenario without changing the
guest's real resolver config:

```bash
host_ip="192.168.67.1" resolvectl_dns_output="Link 2 (eth0): 192.168.67.164" bash -c '
  resolver_match=0
  while IFS= read -r line; do
    servers="${line#*:}"
    for tok in $servers; do
      if [ "$tok" = "$host_ip" ]; then
        resolver_match=1
      fi
    done
  done <<EOF
$resolvectl_dns_output
EOF
  echo "resolver_match=$resolver_match"
'
```

Expected: `resolver_match=0` (a resolver of `.164` must not match `.1` even
though `.1` is a substring of `.164`). Then confirm the multi-server case
still matches:

```bash
host_ip="192.168.67.1" resolvectl_dns_output="Link 2 (eth0): 192.168.67.1 8.8.8.8" bash -c '
  resolver_match=0
  while IFS= read -r line; do
    servers="${line#*:}"
    for tok in $servers; do
      if [ "$tok" = "$host_ip" ]; then
        resolver_match=1
      fi
    done
  done <<EOF
$resolvectl_dns_output
EOF
  echo "resolver_match=$resolver_match"
'
```

Expected: `resolver_match=1`.

- [ ] **Step 4: Commit**

```bash
git add templates/vm-shared/verify-config.sh
git commit -m "fix: verify-config.sh matches the resolver address exactly instead of by substring"
```

---

## Task 8: `verify-config.sh` — pypi.org URL swap (Fix 4, Ubuntu portion)

**Files:**

- Modify: `templates/vm-shared/verify-config.sh:184`

**Interfaces:**

- Consumes: `curl_code` (already defined; unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Swap the URL**

Find:

```bash
c="$(curl_code 30 https://pypi.org/simple/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed passthrough :443 pypi.org -> $c" || bad 'allow-listed passthrough :443 pypi.org' "code=$c curlExit=$?"
```

Replace with:

```bash
c="$(curl_code 30 https://pypi.org/)" && [ "$c" -lt 400 ] 2>/dev/null && ok "allow-listed passthrough :443 pypi.org -> $c" || bad 'allow-listed passthrough :443 pypi.org' "code=$c curlExit=$?"
```

(No change needed to the exit-code gating here — this script already chains
`curl_code ... &&`, so a timed-out transfer already fails this check today;
only the Windows guest had that gap, fixed in Task 4.)

- [ ] **Step 2: Sync and run on the Ubuntu guest**

```bash
cp templates/vm-shared/verify-config.sh .configamatron/vm-shared/verify-config.sh
```

On the guest:

```bash
bash verify-config.sh <host-ip>
```

Expected: `PASS  allow-listed passthrough :443 pypi.org -> 200` under "Live
egress".

- [ ] **Step 3: Commit**

```bash
git add templates/vm-shared/verify-config.sh
git commit -m "fix: verify-config.sh tests passthrough with a small pypi.org page instead of the 44MB /simple/ index"
```

---

## Task 9: Final full regression check

**Files:** none (verification only).

- [ ] **Step 1: Full rerun of `verify-config.sh` on the Ubuntu guest**

```bash
bash verify-config.sh <host-ip>
```

Confirm 100% pass — every check from before this plan started, plus the
`ahostsv4`, resolver, and pypi.org fixes from Tasks 6–8.

- [ ] **Step 2: Re-confirm the two Windows-side verifiers are still clean**

Re-run `verify-proxy.ps1` (host) and `verify-config.ps1` (on `sus-windows`,
no argument) one more time now that all four defects are fixed everywhere,
and confirm both are 100% pass with no regressions from any of the nine
tasks above.

- [ ] **Step 3: Update the handoff doc**

`docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md` describes all
four defects as open. Add a line near the top noting they were fixed by this
plan, referencing the design doc and this plan's filename, so a future reader
doesn't re-discover the same four issues.

```bash
git add docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md
git commit -m "docs: mark verifier-script-defects handoff as resolved"
```
