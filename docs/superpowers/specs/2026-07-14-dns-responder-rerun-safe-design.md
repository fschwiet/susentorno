# Rerun-safe DNS responder publish in `07-setup-network.ps1`

Date: 2026-07-14

## Problem

`templates/vm-shared-windows/07-setup-network.ps1` provisions the Windows VM's
DNS redirect: it publishes the bundled `ConfigamatronDnsResponder.exe`,
registers it as a startup Scheduled Task (`RestartCount 999`, runs as SYSTEM),
starts it, and points the active adapter's DNS at `127.0.0.1`. Everything
after the publish step is already rerun-safe — `Register-ScheduledTask -Force`
overwrites the task definition, `Set-Content` overwrites the config file, and
`Set-DnsClientServerAddress` is a plain overwrite.

The one genuine gap is the publish step itself:

```powershell
dotnet publish (Join-Path $scriptDir 'dns-responder') -c Release -o $installDir
```

If the VM was already provisioned by a prior run of this script, the
scheduled task's process is still running `ConfigamatronDnsResponder.exe` out
of `$installDir`. Windows locks an executable file while a process is running
it, so `dotnet publish` writing a new copy of that same exe into the same
directory fails with a file-in-use error. Unlike winget/dotnet-tool install
failures elsewhere in this kit, this isn't a harmless "already done" no-op —
it can leave a partial or stale publish output, which the script then
re-registers and starts regardless.

## Approach

Stop the running responder before publishing, so `dotnet publish` always
targets an unlocked directory. A brief DNS outage while the old process exits
and the new one starts is acceptable for this kit (VM re-provisioning, not a
live production resolver).

Rejected: publishing to a staging directory and swapping files in after a
stop, which shrinks the outage window to a file copy instead of the whole
publish. Not worth the added complexity (a second directory to manage, a copy
step) for a re-run path that isn't outage-sensitive.

## Design

### `templates/vm-shared-windows/07-setup-network.ps1`

Add a stop-and-wait guard at the top of the script, before the existing
"Publish the shipped C# catch-all DNS responder" step:

```powershell
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
```

Notes on the specific error-handling choices:

- `Get-ScheduledTask -ErrorAction SilentlyContinue` — a first-ever run has no
  task yet; this must not halt the script (`$ErrorActionPreference = 'Stop'`
  turns a non-terminating cmdlet error into a script-ending one otherwise).
- `Stop-ScheduledTask -ErrorAction SilentlyContinue` — Task Scheduler errors if
  asked to stop a task that isn't currently running (e.g. a box rebooted since
  the task last exited). That's a legitimate state here, not a failure.
- The poll loop waits for the *process* to exit, not just for
  `Stop-ScheduledTask` to return — the cmdlet signals the stop but doesn't
  guarantee the file handle is released by the time it returns. A 10s ceiling
  avoids hanging forever if the process is somehow stuck; if it's hit, the
  subsequent `dotnet publish` fails loudly with its usual file-in-use error
  rather than the script silently proceeding on stale output.

Everything after this guard is unchanged: `dotnet publish` now always sees an
unlocked directory, and `Register-ScheduledTask -Force` /
`Start-ScheduledTask` bring the freshly published binary back up. The task's
`RestartCount 999` restart-on-failure doesn't fight this — a manual
`Stop-ScheduledTask` isn't a failure exit, so nothing tries to relaunch the
old process mid-swap.

## Testing

No Windows VM e2e harness exists (`tests/vm/` is Linux-only), so this is
manual: re-run `07-setup-network.ps1 <host-ip>` twice in a row on the same
provisioned VM without a reboot in between, and confirm the second run
completes without a `dotnet publish` file-in-use error and DNS resolution
through the responder still works afterward.

The existing unit test
(`tests/unit/templates.test.ts`, "windows DNS redirect wires responder to the
host IP and adapter DNS") only asserts on stable substrings
(`Register-ScheduledTask`, `ConfigamatronDnsResponder`, etc.) that this change
doesn't touch, so it needs no update.

## Success criteria

- Re-running `07-setup-network.ps1 <host-ip>` on an already-provisioned VM
  (no reboot) completes without a `dotnet publish` file-in-use error.
- The responder ends up running the freshly published binary, not a stale
  or partial one.
- First-ever run (no existing task) is unaffected.
