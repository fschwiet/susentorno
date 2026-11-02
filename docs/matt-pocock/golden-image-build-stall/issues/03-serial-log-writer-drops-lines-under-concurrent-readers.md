# 03: The serial log writer drops lines silently when another process holds the file

**Status:** ready-for-agent

**Category:** bug

**Blocked by:** None (can start immediately).

## What happened

On 2026-11-01 a `pnpm check` guest-tier run failed with `build VM did not power off`. The failure evidence from [issues/02](02-cheaper-golden-build-failures.md) showed a genuine installer stall at `start: subiquity/Mirror/apply_autoinstall_config`: the console screenshot matched the serial log line for line, the VM was Running at 16% CPU, and no kernel failure appeared in the log.

An immediate rerun of `pnpm test:guest` passed (5 files, 74 tests; the Ubuntu golden build finished in about 16 minutes). But that run's `test-results/golden-build/ubuntu/current/serial.log` is only 478 bytes and ends 13 s into kernel boot:

```
[   13.344754] tun: Universal TUN/TAP device driver, 1.6
[   13.383641] PPP generic driver version 2.4.2
```

The installer clearly kept running, so the serial log lost everything after early boot.

During that run a diagnostic loop (not part of the harness) ran `grep` on `serial.log` every 5 s. Every attempt over 30 minutes failed with `Device or resource busy` (a Windows sharing violation as reported by Git Bash). After the build VM was removed, the file was readable again and no serial-reader process was still running. What held the file the whole time was not identified.

## Why the writer is fragile

`startSerialLog` (`tests/guest/hyperv/serialLog.ts`) runs a Windows PowerShell loop that calls `Add-Content` once per serial line, under `$ErrorActionPreference = 'SilentlyContinue'`:

- Each `Add-Content` reopens the file. If any other process has it open in a conflicting share mode at that moment, the write fails.
- `SilentlyContinue` throws that line away without any trace. The log looks like it just stopped.
- The per-line open/close is also a contention window for readers. The sharing violations above are consistent with that, though a 30-minute unbroken lock is not fully explained by it.

## Why it matters

- **The kernel-failure fast fail from issues/02 can go blind.** `waitForOff` (`tests/guest/hyperv/goldenImage.ts`) reads `serial.log` every 15 s via `readSerialLog`, which returns `''` on any read error. If the file is locked, or the writer has silently dropped the relevant lines, `findKernelFailure` sees nothing and the build waits out the full 45 minutes, which is the cost issues/02 set out to remove.
- **The serial log is trusted as evidence.** The 10-26 diagnosis spent effort telling "installer hung" from "serial reader lost output". A writer that drops lines silently brings back that ambiguity.
- **Every guest VM uses the same writer.** `testGuest.ts` calls `startSerialLog` for each role VM too.

## Not known

- Whether the diagnostic `grep` loop caused the loss, or whether it happens without any outside reader. Before this run, the failed 11:23 run's log (54 KB) was written fine up to the stall with only the harness reading it.
- What held the file for 30 minutes (the writer, Defender, or something else). A `handle.exe` or Process Monitor capture during a run would answer this.

## Fix

- Open the log once per writer process with `[System.IO.File]::Open(path, Append, Write, FileShare.ReadWrite)`, wrap it in a `StreamWriter` with `AutoFlush = $true`, and write each line through that handle. Readers such as `readSerialLog` and humans can then open the file at any time without blocking the writer.
- Do not swallow write errors silently. When a write fails, the writer records a marker line in the log itself, so a truncated log can be told apart from a quiet VM.
- `readSerialLog` logs once when the file is unreadable (as opposed to empty), so a blind `findKernelFailure` check is visible.
- The pipe reconnect loop (`while ($true)` around `Connect(5000)`) must keep working once the file handle lives outside the per-connection `try`.
- The public signature of `startSerialLog` is unchanged; `testGuest.ts` also calls it for every role VM.

## Acceptance

- [ ] A test that does not need Hyper-V drives the writer script with a local Node named-pipe server while another process reads the file repeatedly. No lines are lost.
- [ ] A write failure produces a visible marker in the log (test by holding the file with an exclusive lock).
- [ ] The reconnect loop still works after the pipe disconnects and reconnects.
- [ ] A forced Ubuntu golden build, run while the log is polled from another process, leaves a complete serial log through `finish: subiquity/Mirror/apply_autoinstall_config` and beyond.
- [ ] Role-VM serial logs under `test-results/guest/<timestamp>/` still work.
- [ ] Follow `testing.md` for tier placement; do not add assertions on script template text.

## Out of scope

- The intermittent Mirror-step stall from the same 2026-11-01 session (the pinned mirror in commit 02c0bd6 targets it). Its live cause (network path from the nested build VM to the mirror) was not reproduced. If it recurs, inspect the live VM as described in the [hand-off](../handoff.md).
- Identifying what held the file for 30 minutes.
