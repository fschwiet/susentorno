# 03: New prerequisite checks: Hyper-V, Docker Compose, jq, and non-Windows hosts

Parent: [spec](../spec.md)

**What to build:** Some prerequisites are documented in `testing.md` but not checked anywhere. Check them, so both the preflight and the tiers catch them:

- **Hyper-V available**, for `host-network` and `guest`: the Hyper-V Virtual Machine Management service (`vmms`) exists and is running.
- **Docker Compose available**, for `proxy-stack` and `guest`: `docker compose version` exits 0.
- **`jq` on PATH**, for `cli`: optional. When `jq` is absent, the entry is _skipped with a reason_, matching the `cli` tests that already self-skip without it. This introduces the "skip with reason" outcome for prerequisite entries. In the preflight it surfaces as a skipped test (via Vitest's context skip). In a tier's `globalSetup` a skipped entry is not a failure.

Also, Windows-only checks (elevation, Hyper-V, node firewall) fail on a non-`win32` platform with a message saying the tier needs a Windows Hyper-V host. They do not pass or skip.

**Blocked by:** 02

**Status:** resolved

- [x] The preflight shows a Hyper-V entry under `host-network` and `guest`, and a Docker Compose entry under `proxy-stack` and `guest`.
- [x] With `vmms` stopped or absent, the Hyper-V entry fails with a message naming the fix.
- [x] With `jq` off PATH, the `cli` group shows the `jq` entry as skipped with a reason. With `jq` present, it passes.
- [x] `pnpm test:host-network`, `pnpm test:proxy-stack`, and `pnpm test:guest` fail fast on the new checks.
- [x] On a non-Windows host (for example, inside a susentorno Linux guest), each Windows-only entry fails with the "needs a Windows Hyper-V host" message instead of an opaque PowerShell error.
- [x] `testing.md`'s prerequisites table agrees with the checks.

## Manual verification (2026-09-27)

- **Prepared host** (elevated PowerShell, Hyper-V, Docker Desktop with Compose, `jq`, `ssh-agent`): `pnpm test:preflight` passed all 13 entries, including `host-network > Hyper-V available`, `proxy-stack > Docker Compose available`, `guest > Hyper-V available`, `guest > Docker Compose available`, and `cli > jq on PATH`.
- **`jq` off PATH** (WinGet Links dir removed from `PATH`): `cli > jq on PATH` reported skipped with "`jq` is not on PATH, so the cli tests that run the real `jq` will skip. Install `jq` to run them."
- **`vmms` stopped** (no VMs present; restarted afterward): the preflight failed exactly `host-network > Hyper-V available` and `guest > Hyper-V available` with "... (vmms) is Stopped. Start it (elevated PowerShell) and re-run: Start-Service vmms". `pnpm test:host-network` and `pnpm test:guest` each failed in `globalSetup` via `runPrerequisites` with the same message, before any test or image build.
- **Docker Compose missing** (a `docker.bat` shim first on `PATH` that fails only `docker compose`): the preflight failed exactly `proxy-stack > Docker Compose available` and `guest > Docker Compose available`; `pnpm test:proxy-stack` failed in `globalSetup` with the same message.
- **Non-Windows host** (simulated by overriding `process.platform` to `linux` in the preflight worker via a temporary setup file): `elevated shell`, `Hyper-V available`, and `node.exe not blocked by Windows Firewall` each failed with "This tier needs a Windows Hyper-V host; this host's platform is linux." Not run inside a real Linux guest.
- On the prepared host: `pnpm test:cli` 35 passed, 1 skipped; `pnpm test:host-network` 4 passed; `pnpm test:proxy-stack` 63 passed; `pnpm test:guest` 4 files passed, 1 skipped (`SUSENTORNO_WINDOWS_ISO` unset; ticket 04 makes it required), 32 tests passed, 14 skipped.
