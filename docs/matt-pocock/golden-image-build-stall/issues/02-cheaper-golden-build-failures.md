# 02: Make a stalled golden build cheaper to diagnose

**Status:** needs-triage

**Blocked by:** None (can start immediately).

## Problem

When the guest tier's golden Ubuntu build goes wrong, `waitForOff` (`tests/guest/hyperv/goldenImage.ts`) waits the full 45 minutes and then throws `build VM did not power off`, with only the serial log to go on. The [hand-off this came from](../handoff.md) shows what that costs:

- Two runs on 2026-10-26 spent about 90 minutes reaching the same uninformative error.
- `ensureGoldenImage` deletes `golden-build-serial.log` at the start of every build (`rmSync(goldenBuildSerialLogPath, ...)`), so the second failure destroyed the first one's log.
- The [earlier kernel-oops ticket](../../golden-image-installer-kernel-oops/issues/01-installer-kernel-oops-hangs-golden-build.md) had a kernel `Oops`/`BUG:` in the serial log about 40 minutes in, and the harness still waited out the deadline.
- The serial log could not tell "installer hung" from "serial reader lost the pipe". That question was only settled by looking at the VM's console and its network traffic from the host.

## Constraint learned from the diagnosis: serial silence is not a stall

The obvious design, "fail when the serial log hasn't grown for N minutes", fails healthy builds. In a build that went on to succeed (with `apt: { geoip: false }`), the serial log printed `start: subiquity/Mirror/cmd-apt-config` during `Install/install/configure_apt` and then **nothing for over 10 minutes**, while curtin installed packages and ran `unattended-upgrades` inside `/target`. The VM then powered itself off after about 26 minutes. A 4-minute and a 10-minute silence threshold both declared that build stalled.

Signals that did separate a real stall from a quiet healthy install in that session:

- **Network activity of the build VM**, seen on the host: the real stall sent no packets at all. Hyper-V's per-VM network metering, or adapter byte counters, may give this without a packet capture.
- **CPU**: about 0% in the real stall, against 4–16% while installing. CPU is a noisy signal on its own.
- **The live installer's state**: process list and `/var/log/installer/subiquity-server-debug.log`, readable through a tty2 shell. See the notes in [issues/01](01-pin-primary-mirror.md).

## Candidate pieces (to settle in design, not all required)

1. **Keep the previous run's serial log**, for example by rotating it to `golden-build-serial.prev.log` rather than deleting it. This is cheap and independent of the rest.
2. **Fail fast on an unambiguous kernel failure**: a serial line matching `Oops`, `BUG:`, `general protection fault` or `Kernel panic`. That has no false-positive risk from quiet phases.
3. **Capture evidence when the build fails** (at the deadline, or at an early-failure trigger): `Get-VM` state, uptime, CPU and memory; a 640x480 console screenshot (`tests/guest/hyperv/vmScreenshot.ts` uses 320x240, which is unreadable); and, if practical, the tail of `subiquity-server-debug.log` from the live VM.
4. **An early stall trigger that tolerates quiet phases**, if one is worth having. Options include combining serial silence with no network traffic and near-zero CPU over a window, or applying a silence threshold only before Subiquity's `Install` step begins. Weigh the false-red risk against minutes saved: a false red on a healthy build costs a full rebuild.

## Questions for design

- Is piece 4 worth its false-red risk, or do pieces 1–3 deliver most of the value?
- Should failure evidence go next to the serial log in `.image-cache/`, which survives across runs, or into the run's `test-results/` directory?
- Does the Windows golden build (`windowsGoldenImage.ts`) want the same treatment? It already captures screenshots.
