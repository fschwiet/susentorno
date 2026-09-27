# 04: Make the Windows ISO a required, validated guest prerequisite

Parent: [spec](../spec.md)

**What to build:** `SUSENTORNO_WINDOWS_ISO` becomes a required prerequisite of the `guest` tier. A missing or wrong ISO fails the preflight and `pnpm test:guest` in seconds, and the `windowsFresh` role can no longer be silently skipped.

The new `guest` entry checks three things:

- the variable is set;
- the file exists;
- a read-only mount of the ISO shows an `install.wim` image that is x64 and `en-us`.

The ISO is dismounted afterward whether the check passes or fails, and the failure message notes that the check needs an elevated shell. The interpretation of the image metadata is a pure function, separate from the PowerShell invocation.

Once the prerequisite exists, remove the optional behavior:

- The `windowsFresh` role no longer self-skips, and the `guest` `globalSetup` no longer branches on the variable.
- The Windows golden image builder receives the validated ISO path as a parameter, instead of reading the environment variable and checking existence itself.
- There is no opt-out.

**Blocked by:** 02

**Status:** resolved

- [x] Unit tests cover the metadata interpretation: pass for an x64 `en-us` image, and a failure naming the actual architecture and language otherwise (for example, arm64, or an `en-gb` language).
- [x] The existing unit test for the helper that reads `SUSENTORNO_WINDOWS_ISO` is updated for its new role as the prerequisite's input rather than an on/off switch.
- [x] With the variable unset, the preflight's ISO entry fails, and `pnpm test:guest` fails in `globalSetup` before any image build.
- [x] With the variable pointing at a nonexistent file, the ISO entry fails with a message naming the path.
- [x] With a valid ISO, the entry passes, no disk image stays mounted afterward, and `pnpm test:guest` runs `windowsFresh` rather than skipping it.
- [x] ADR-0027 is amended in place. The sentence saying the role self-skips when the variable is unset is rewritten, and a dated note is added: "2026-09-27: the ISO is now required; a skipped `windowsFresh` role went unnoticed in an agentic run".
- [x] In `testing.md`, the `guest` prerequisites row and the `windowsFresh` "opt-in" paragraph say the ISO is required. They also say it should be a local path (not a mapped drive or network share) and restate the disk and first-build costs.

## Manual verification (2026-09-27)

Run from an elevated PowerShell on the prepared host, with `SUSENTORNO_WINDOWS_ISO` set per command.

- **Variable unset:** `pnpm test:preflight` failed exactly `guest > Windows ISO valid` (13 passed) with "SUSENTORNO_WINDOWS_ISO is not set. The guest tier requires it: point it at a local path (not a mapped drive or network share) to an x64 en-us Windows 11 Enterprise evaluation ISO. See testing.md." `pnpm test:guest` failed in `globalSetup` via `runPrerequisites` with the same message, before any image build.
- **Nonexistent file** (`C:\nope\missing.iso`): the entry failed with "SUSENTORNO_WINDOWS_ISO points at 'C:\nope\missing.iso', which does not exist. ..."
- **Not an ISO image** (a small text file named `.iso`): the entry failed with "Could not read the Windows ISO at '...' (PowerShell exited 1): ... Mount-DiskImage ... Mounting the ISO needs an elevated (Administrator) shell; re-run from one if this is an access-denied error."
- **Valid ISO** (the x64 en-us 26200 Enterprise evaluation): all 14 preflight entries passed (`Windows ISO valid` in about 3.7 s), and `Get-DiskImage` reported the ISO not attached afterward.
- **`pnpm test:guest` with the valid ISO:** the first attempt stopped in `globalSetup` because the cached Windows golden image was stale (`certsSha256` changed on this host). That is the existing stale-image guard, not this change. Re-run with `SUSENTORNO_WINDOWS_IMAGE_REBUILD=1`: the image rebuilt, then 5 files passed and 46 tests passed with 0 skipped, including `windowsFresh`. Before this change the run was 4 files passed and 1 skipped, with 32 tests passed and 14 skipped.
