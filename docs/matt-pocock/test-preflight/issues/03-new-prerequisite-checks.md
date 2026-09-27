# 03: New prerequisite checks: Hyper-V, Docker Compose, jq, and non-Windows hosts

Parent: [spec](../spec.md)

**What to build:** Some prerequisites are documented in `testing.md` but not checked anywhere. Check them, so both the preflight and the tiers catch them:

- **Hyper-V available**, for `host-network` and `guest`: the Hyper-V Virtual Machine Management service (`vmms`) exists and is running.
- **Docker Compose available**, for `proxy-stack` and `guest`: `docker compose version` exits 0.
- **`jq` on PATH**, for `cli`: optional. When `jq` is absent, the entry is _skipped with a reason_, matching the `cli` tests that already self-skip without it. This introduces the "skip with reason" outcome for prerequisite entries. In the preflight it surfaces as a skipped test (via Vitest's context skip). In a tier's `globalSetup` a skipped entry is not a failure.

Also, Windows-only checks (elevation, Hyper-V, node firewall) fail on a non-`win32` platform with a message saying the tier needs a Windows Hyper-V host. They do not pass or skip.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] The preflight shows a Hyper-V entry under `host-network` and `guest`, and a Docker Compose entry under `proxy-stack` and `guest`.
- [ ] With `vmms` stopped or absent, the Hyper-V entry fails with a message naming the fix.
- [ ] With `jq` off PATH, the `cli` group shows the `jq` entry as skipped with a reason. With `jq` present, it passes.
- [ ] `pnpm test:host-network`, `pnpm test:proxy-stack`, and `pnpm test:guest` fail fast on the new checks.
- [ ] On a non-Windows host (for example, inside a susentorno Linux guest), each Windows-only entry fails with the "needs a Windows Hyper-V host" message instead of an opaque PowerShell error.
- [ ] `testing.md`'s prerequisites table agrees with the checks.
