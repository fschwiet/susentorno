# Rerun-safe DNS responder publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `templates/vm-shared-windows/07-setup-network.ps1` safe to re-run on an already-provisioned VM by stopping the running DNS responder before `dotnet publish` overwrites its exe.

**Architecture:** Single-file change. Insert a stop-and-wait guard at the top of the script, before the existing publish step, so `dotnet publish` never targets a locked file. No new files, no new tests (no Windows VM e2e harness exists in this repo — see spec's Testing section).

**Tech Stack:** PowerShell 7 (`pwsh`), Windows Task Scheduler cmdlets (`Get-ScheduledTask`, `Stop-ScheduledTask`).

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-14-dns-responder-rerun-safe-design.md` — implement exactly the guard described there, do not add a staging-directory swap (explicitly rejected in the spec).
- The guard must not error out on a first-ever run, where the `ConfigamatronDnsResponder` scheduled task does not exist yet.
- `$ErrorActionPreference = 'Stop'` is set at the top of this script — any cmdlet call in the new guard that can legitimately fail in a normal rerun state (task absent, task not running) must pass `-ErrorAction SilentlyContinue` explicitly, or it will abort the whole script.
- Poll for the process to actually exit (don't just trust `Stop-ScheduledTask` returning) with a bounded timeout (~10s), per the spec.

---

### Task 1: Add stop-and-wait guard to `07-setup-network.ps1`

**Files:**
- Modify: `templates/vm-shared-windows/07-setup-network.ps1:4-6`

**Interfaces:**
- Consumes: nothing new — no other task/file depends on anything from this one.
- Produces: nothing consumed elsewhere; this is the complete change.

- [ ] **Step 1: Read the current file to confirm line numbers haven't drifted**

Run a Read on `templates/vm-shared-windows/07-setup-network.ps1`. Confirm line 4 is
`$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path` and line 6 is
`# 1) Publish the shipped C# catch-all DNS responder to a stable location.`. If the
line numbers differ, locate the same two lines by content instead.

- [ ] **Step 2: Insert the guard between those two lines**

Use Edit with this exact old_string/new_string (matches the file as of this plan's
writing):

old_string:
```
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) Publish the shipped C# catch-all DNS responder to a stable location.
```

new_string:
```
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Stop any already-running responder first: Windows locks a running exe, so a
# rerun's `dotnet publish` below would fail to overwrite it otherwise. Safe on
# a first-ever run, where the task doesn't exist yet.
$taskName = 'ConfigamatronDnsResponder'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name $taskName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
}

# 1) Publish the shipped C# catch-all DNS responder to a stable location.
```

- [ ] **Step 3: Verify the script still parses as valid PowerShell**

Run:
```
pwsh -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('templates/vm-shared-windows/07-setup-network.ps1', [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { Write-Error $_ }; exit 1 } else { Write-Host 'OK' }"
```
Expected: `OK` printed, exit code 0.

- [ ] **Step 4: Run the existing unit test suite to confirm no regressions**

Run: `pnpm test:unit`
Expected: all tests pass, including
`tests/unit/templates.test.ts > windows DNS redirect wires responder to the host
IP and adapter DNS` — that test only asserts on substrings
(`Register-ScheduledTask`, `ConfigamatronDnsResponder`, `responder-config.txt`,
`Set-DnsClientServerAddress`, `'127.0.0.1'`) that this change doesn't remove, so it
should pass unmodified.

- [ ] **Step 5: Commit**

```bash
git add templates/vm-shared-windows/07-setup-network.ps1
git commit -m "$(cat <<'EOF'
fix: stop running DNS responder before republishing in 07-setup-network.ps1

Windows locks a running exe, so re-running this script on an
already-provisioned VM previously failed at `dotnet publish` with a
file-in-use error. Stop the scheduled task and wait for the process to
exit first.
EOF
)"
```

## Manual verification (not automatable — no Windows VM e2e harness exists)

After this task lands, before considering the fix fully verified: on a VM
already provisioned by a prior run of this kit, run
`07-setup-network.ps1 <host-ip>` twice in a row with no reboot in between.
Confirm the second run completes without a `dotnet publish` file-in-use
error, and that DNS resolution through the responder still works afterward
(matches the design doc's Testing section).
