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
directly in this session (this machine has its own Docker Desktop and full
checkout — Tasks 1-5 need no separate guest console or manual paste-back).
Tasks 6-9 need an actual Ubuntu machine and are executed in a different
session after a push/pull handoff — see the checkpoint below.

**Tech Stack:** PowerShell 5.1 for `verify-proxy.ps1` (declares
`#requires -Version 5.1`); `verify-config.ps1` is written compatibly with
5.1 but doesn't declare the requirement itself. Bash (not just POSIX `sh`) for
`verify-config.sh` — it has a `#!/usr/bin/env bash` shebang and uses
bash-only features (`set -o pipefail`). Docker CLI, curl.

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
- Commit only the `templates/` file(s) touched by each task — this applies to
  Tasks 1-8, which each change exactly one script. Task 9 is the one
  exception: it commits a `docs/` file to record that the handoff's defects
  are resolved, which is a deliberate part of that task, not a violation of
  this rule.

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
    $resolvedExpected = Resolve-Path -LiteralPath $proxyDir -ErrorAction SilentlyContinue
    $expectedProxyDir = if ($resolvedExpected) { $resolvedExpected.Path.TrimEnd('\') } else { $proxyDir.TrimEnd('\') }

    # Every branch below that cannot positively confirm ownership -- an
    # inspect failure, a missing mount, or an actual mismatch -- FAILs and
    # exits immediately, the same as a confirmed mismatch. "Inconclusive" and
    # "wrong" get the same treatment here: if this check can't prove the
    # running Envoy belongs to $EnvDir, every later section's assumption that
    # it does is equally unsafe to build on.
    foreach ($name in $envoyNames) {
        $inspectError = $null
        $mountsJson = & docker inspect --format '{{json .Mounts}}' $name 2>&1
        if ($LASTEXITCODE -ne 0) { $inspectError = ($mountsJson | Out-String).Trim() }
        if ($inspectError -or -not $mountsJson) {
            Add-Fail "envoy container '$name' ownership" "docker inspect failed -- could not read its mounted config: $inspectError"
            Write-Host ''
            Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
            exit 1
        }

        $mounts = $mountsJson | ConvertFrom-Json
        $configMount = $mounts | Where-Object { $_.Destination -eq '/etc/envoy/envoy.yaml' -and $_.Type -eq 'bind' } | Select-Object -First 1
        if (-not $configMount) {
            Add-Fail "envoy container '$name' ownership" 'no bind mount found at /etc/envoy/envoy.yaml -- cannot verify which environment this container belongs to'
            Write-Host ''
            Write-Host "$($script:pass) passed, $($script:fail) failed, $($script:warn) warnings"
            exit 1
        }

        $actualProxyDir = Split-Path -Parent $configMount.Source
        $resolvedActual = Resolve-Path -LiteralPath $actualProxyDir -ErrorAction SilentlyContinue
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

- [ ] **Step 6: Confirm the missing-mount case FAILs and exits**

Add a plain container that matches the `docker ps` filter (same compose
label, name containing `envoy`) but has no bind mounts at all, to exercise
the "no bind mount found" branch:

```powershell
docker run -d --name test-configamatron-envoy-decoy --label com.docker.compose.project=configamatron alpine:3.20 sleep 3600
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1
```

Expected: `FAIL  envoy container 'test-configamatron-envoy-decoy' ownership
-- no bind mount found at /etc/envoy/envoy.yaml -- cannot verify which
environment this container belongs to`, and the script exits before
"Credential secret" — same as the mismatch case in Step 4, confirming this
branch also stops the script rather than falling through.

Clean up:

```powershell
docker rm -f test-configamatron-envoy-decoy
```

- [ ] **Step 7: Confirm both blue and green being up doesn't break the check**

`docker-compose.yml` defines `envoy_blue` and `envoy_green` as separate
services; bring up the sibling color alongside whichever one `run-proxy` is
already running, so both are inspected in the same run:

```powershell
docker compose --project-directory .\.configamatron\proxy -f .\.configamatron\proxy\docker-compose.yml up -d envoy_green
powershell -ExecutionPolicy Bypass -File .\.configamatron\proxy\verify-proxy.ps1
```

Expected: two `PASS  envoy container '...' belongs to this environment (...)`
lines, one for `configamatron-envoy-blue` and one for `configamatron-envoy-green`.

Clean up (only if `run-proxy` isn't actively using the green color — check
its log output before removing):

```powershell
docker compose --project-directory .\.configamatron\proxy -f .\.configamatron\proxy\docker-compose.yml stop envoy_green
docker rm -f configamatron-envoy-green
```

Note: a transient `docker inspect` failure (e.g. the container is removed in
the split second between `docker ps` listing it and `docker inspect` reading
it) is not reproduced here — forcing that exact race reliably isn't
practical, so that branch is covered by code review rather than a live run.

- [ ] **Step 8: Commit**

```bash
git add templates/proxy/verify-proxy.ps1
git commit -m "fix: verify-proxy.ps1 cross-checks envoy container ownership before trusting its config"
```

---

## Task 2: `verify-proxy.ps1` — pypi.org URL swap (Fix 4, host portion)

**Files:**

- Modify: `templates/proxy/verify-proxy.ps1` (the "Live proxy behavior"
  section — Task 1 inserted ~40 lines above this, so search for the text
  below rather than a line number)

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
proxy behavior" section. This removes the specific cold-download timeout
that caused `code=200 curlExit=28` (the page is now 22 kB instead of 44 MB) —
it doesn't guarantee curl can never time out here for some unrelated reason
(network trouble, a slow upstream), just that this particular cause is gone.

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
#
# Wrapped in @(...): with exactly one result, the pipeline below returns a
# bare [string], not a 1-element array. PowerShell strings also expose a
# .Count property (always 1), so ".Count -eq 1" below would still look
# right -- but $dnsServers[0] on a bare string indexes its first *character*
# (a System.Char), not the address, silently corrupting $HostIp. @(...)
# forces array semantics regardless of how many results come back.
$dnsServers = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique)

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

- [ ] **Step 3: Sync and run it, with no argument, in this session**

This environment has its own local copy of `.configamatron\vm-shared-windows`
— no separate guest console or SMB share needed:

```powershell
Copy-Item C:\code\configamatron\templates\vm-shared-windows\verify-config.ps1 C:\code\configamatron\.configamatron\vm-shared-windows\verify-config.ps1 -Force
cd C:\code\configamatron\.configamatron\vm-shared-windows
powershell -ExecutionPolicy Bypass -File .\verify-config.ps1
```

Expected: `PASS  discovered host IP <ip> from the DHCP-assigned DNS server`
as the first line under "Host IP" (whatever DNS server this environment is
actually configured with), and the same pass result already observed when
an explicit `-HostIp` was supplied.

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

- [ ] **Step 2: Sync and run it in this session**

```powershell
Copy-Item C:\code\configamatron\templates\vm-shared-windows\verify-config.ps1 C:\code\configamatron\.configamatron\vm-shared-windows\verify-config.ps1 -Force
cd C:\code\configamatron\.configamatron\vm-shared-windows
powershell -ExecutionPolicy Bypass -File .\verify-config.ps1
```

Expected: `PASS  allow-listed :443 pypi.org -> 200` under "Live egress", with
no other lines changed.

- [ ] **Step 3: Prove the exit-code check actually gates on failure**

The happy-path run above can't show the fix doing anything, since `HttpCode`
already returned 200 with exit 0 before this change too. Test the added
logic directly, independent of any real network timing, by feeding it a
synthetic result that reproduces the original bug's shape (status printed,
then a timeout):

```powershell
$c = '200'; $pypiExit = 28
if ($c -and [int]$c -lt 400 -and $pypiExit -eq 0) { 'WOULD PASS (bug still present)' } else { 'WOULD FAIL (fix works)' }
```

Expected: `WOULD FAIL (fix works)` — confirming the `-and $pypiExit -eq 0`
clause is what actually changed, not just the URL.

- [ ] **Step 4: Commit**

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
this plan started, with two differences: the new ownership PASS(es) from
Task 1 (which didn't exist before), and the pypi.org line still reads PASS
(that check already passed on a healthy run before this plan — Task 2 just
made it stop being flaky on a cold first fetch, it's not a new line). No new
FAILs anywhere.

- [ ] **Step 2: Full rerun of `verify-config.ps1`, no argument**

```powershell
cd C:\code\configamatron\.configamatron\vm-shared-windows
powershell -ExecutionPolicy Bypass -File .\verify-config.ps1
```

Confirm no FAILs anywhere (WARNs are advisory and fine), including the
discovered-IP line from Task 3 and the pypi.org line from Task 4.

- [ ] **Step 3: Push**

```bash
git push
```

The Ubuntu machine continues this plan from Task 6 onward in a separate
session, by pulling this branch — it needs these commits pushed, not just
local. Leave `run-proxy` running if anything on this machine still depends on
it; otherwise `Ctrl-C` the `pnpm cli run-proxy` process (the container itself
stays up per its own documented behavior).

---

## >>> CHECKPOINT: switch to the Ubuntu machine here <<<

Everything above this line is done and pushed from this session. Everything
below needs an actual Ubuntu machine to run `verify-config.sh` against, and
continues in a **separate session**: pull this branch on the Ubuntu machine
and resume this plan at Task 6 using the executing-plans skill.

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
This confirms the check still passes today, but not the actual scenario
`ahostsv4` exists for (a real AAAA record preceding the A record) — the
guest's DNS responder currently answers AAAA with NOERROR and zero records,
so there's no AAAA line to be misled by right now. Reproducing the AAAA-first
case live would mean temporarily reconfiguring the host's DNS responder to
answer AAAA queries, which risks destabilizing the other checks that depend
on it; skip that here and rely on `getent ahostsv4` restricting to the
address family by definition (the same fix already validated for this exact
failure mode in `tests/vm/vm.test.ts`).

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
    case "$line" in
      *:*) ;;
      *) continue ;;
    esac
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
one or more whitespace-separated server addresses. The `case` guard skips
any line with no colon at all, so such a line can't fall through with its
entire content retained in `servers` and accidentally match `$host_ip` as a
bare token. `${line#*:}` then strips the prefix up to and including the
first colon; the `for tok in $servers` loop relies on normal shell
word-splitting to check each address as a whole token, so `192.168.67.1` no
longer matches inside `192.168.67.164`.)

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

Confirm no new FAILs (WARNs are advisory and expected to stay as they were) —
every check that passed before this plan started should still pass, plus the
`ahostsv4`, resolver, and pypi.org fixes from Tasks 6–8.

- [ ] **Step 2: Re-confirm the two Windows-side verifiers are still clean**

Back on the Windows machine from Tasks 1–5, re-run `verify-proxy.ps1` and
`verify-config.ps1` (no argument) one more time now that all four defects are
fixed everywhere, and confirm neither has any new FAILs relative to where
Task 5 left them.

- [ ] **Step 3: Update the handoff doc**

`docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md` describes all
four defects as open. Add a line near the top noting they were fixed by this
plan, referencing the design doc and this plan's filename, so a future reader
doesn't re-discover the same four issues.

```bash
git add docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md
git commit -m "docs: mark verifier-script-defects handoff as resolved"
```
