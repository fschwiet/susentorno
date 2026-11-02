# 03: The serial log writer drops lines silently when another process holds the file

**Status:** needs-triage

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

## Candidate fix (to settle in triage)

- Open the log once per writer process with `[System.IO.File]::Open(path, Append, Write, FileShare.ReadWrite)` (or a `FileStream` with `FileShare.Read`), wrap it in a `StreamWriter` with `AutoFlush = $true`, and write each line through that handle. Readers such as `readSerialLog` and humans can then open the file at any time without blocking the writer.
- Stop swallowing write errors silently. At minimum, record a marker line or a separate `serial.errors.log` entry when a write fails, so a truncated log can be told apart from a quiet VM.
- Decide whether `readSerialLog` should tell "file unreadable" apart from "file empty" (for example, log it once), so a blind kernel-failure check is visible.
- Check whether the pipe reconnect loop (`while ($true)` around `Connect(5000)`) keeps working once the file handle lives outside the per-connection `try`.

## Acceptance (draft)

- While the writer runs, another process can read the log repeatedly, and no lines are lost. This needs a test that does not require Hyper-V: for example, drive the writer script with a local named-pipe server written in Node, and read the file concurrently.
- A forced Ubuntu golden build, run while the log is being polled from another process, leaves a complete serial log through `finish: subiquity/Mirror/apply_autoinstall_config` and beyond.
- Role-VM serial logs under `test-results/guest/<timestamp>/` still work.

## Related

- The intermittent Mirror-step stall from the same 2026-11-01 session is not addressed here. Its live cause (network path from the nested build VM to the mirror) was not reproduced. If it recurs, inspect the live VM as described in the [hand-off](../handoff.md).
