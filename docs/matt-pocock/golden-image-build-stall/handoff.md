# Hand-off: guest tier golden Ubuntu image build stalls at Subiquity's mirror step

**Status:** needs-triage

Related: [golden-image-installer-kernel-oops/issues/01](../golden-image-installer-kernel-oops/issues/01-installer-kernel-oops-hangs-golden-build.md) describes an intermittent hang at the same point. This is not yet shown to be the same bug (see "Differences from the earlier ticket").

## What happened

On 2026-10-26, `pnpm test:guest` failed twice in a row in global setup, before any guest test ran:

```
Error: goldenImage: build VM did not power off; see C:\code\susentorno\.image-cache\golden-build-serial.log
 ❯ waitForOff tests/guest/hyperv/goldenImage.ts:117:9
 ❯ ensureGoldenImage tests/guest/hyperv/goldenImage.ts:183:5
 ❯ Object.setup tests/guest/globalSetup.ts:25:3
```

- Run 1 was the guest stage of a full `pnpm check`. Run 2 was `pnpm test:guest` alone, about an hour later. Both ran from PowerShell, elevated. Every earlier `pnpm check` stage passed (preflight, format, lint, typecheck, unit, cli, host-network, proxy-stack).
- Each run waited the full 45 minutes in `waitForOff`, so each cost about 45 minutes.
- The commits under test (`b43522e`..`e73ff87`, proxy-config-by-copy) do not touch the golden image build, the autoinstall config, or the ISO. This is a judgement from reading the code, not something verified by running the build on the old commit.
- No golden image existed on this machine at the start of the session. The `.image-cache` contents (keys 11:16, ISO 12:20) predate the session, so a golden build has not been seen to succeed here today.

## Observations

**Serial log** (`.image-cache/golden-build-serial.log`, 897 lines, from run 2 only; run 1's log was deleted by run 2's `rmSync`):

- It ends mid-install:
  ```
  start: subiquity/Mirror/cmd-apt-config: curtin command apt-config
  finish: subiquity/Mirror/cmd-apt-config: curtin command apt-config
  start: subiquity/Mirror/cmd-apt-config: curtin command apt-config
  ```
  with no `finish` for the second `cmd-apt-config`. Run 1's log (seen only as an output tail, before it was deleted) ended one line earlier, right after the first `cmd-apt-config` finished. So both runs stopped logging immediately after the mirror step, at slightly different points.
- The log's last write was about 6 minutes after the VM started (16:31, VM started ~16:25). Nothing was written for the remaining ~39 minutes of the wait.
- The log contains no `Oops`, `BUG:`, `general protection`, or `Call Trace`. The only kernel timestamps in it are early boot (last ones around 36 s).
- Earlier in the same log: `wait_dhcp` finished, and `eth0` was reconfigured several times (`Network/_send_update: CHANGE eth0`). So the VM got an address from the Default Switch.
- Early boot noise (probably unrelated): `_check_bindings_file: failed to read header from /etc/multipath/bindings ... fatal configuration error, aborting`.

**Host** (this machine is itself a Hyper-V VM):

- `Win32_ComputerSystem`: Manufacturer `Microsoft Corporation`, Model `Virtual Machine`, `HypervisorPresent: True`. So the build VM is a nested guest. The session's user also said the host is a VM.
- Windows 11 Enterprise Evaluation 10.0.26300. Total RAM 12.0 GB; free RAM stayed at 5.0 GB or more during run 1 and 7.2 GB or more during run 2. Memory pressure is not the explanation. (An earlier unrelated run of `pnpm check` was killed by Claude Code's low-memory guard; that was before the user added 4 GB.)
- Only one switch exists: `Default Switch` (Internal), host address 172.21.128.1/20. `Get-NetNat` returned nothing.
- Direct TCP from the host (no proxy configured in WinINET, WinHTTP, or environment): `archive.ubuntu.com:80`, `archive.ubuntu.com:443`, `releases.ubuntu.com:443` succeed. `1.1.1.1:443` and `1.1.1.1:53` time out. So egress from this host looks allowlisted, not open. This is an inference from five probes; I did not look at how the network is restricted.
- Docker Desktop (Hyper-V backend) was restarted by the user shortly before run 1.

## Differences from the earlier ticket

| | Earlier ticket (2026-09-26) | This one (2026-10-26) |
| --- | --- | --- |
| Stalls after | Mirror `cmd-apt-config` | Run 1: first `cmd-apt-config` finished. Run 2: second one started, never finished |
| Serial log shows kernel oops | Yes (`ovl_iterate_merged`, `ubuntu-drivers`) | No |
| Log keeps growing | Yes, oops at ~2458 s | No, stops ~6 min in |
| Retry | Passed on immediate rerun | Failed on immediate rerun |
| Host | Windows 11 Pro 10.0.26200 | Windows 11 Enterprise Evaluation 10.0.26300, itself a Hyper-V VM |

The log stopping may mean the installer hung with nothing to print, or the serial pipe reader (`startSerialLog`) stopped receiving. The data cannot tell these apart.

## Hypotheses (none tested)

1. **Nested virtualization.** The installer hangs or faults under Hyper-V-on-Hyper-V. The earlier oops was in the guest kernel, which fits an unstable virtual-hardware layer. Unknown whether the earlier host was nested.
2. **Restricted egress.** `cmd-apt-config` may be waiting on a host that the build VM cannot reach through the Default Switch NAT, which sits behind this host's own restricted edge. DHCP working does not show that DNS or arbitrary outbound TCP works from the VM.
3. **The same overlayfs oops as the earlier ticket,** with the serial reader having stopped before it printed.
4. **Serial pipe loss only.** The install may have progressed and then hung later, or not at all, and the log is just truncated.

## Things to try

`DockerDesktopVM` is Docker Desktop's own backend VM, not the guest tier's VM. The golden build VM is `susentorno-test-golden-build`, created by `ensureGoldenImage` and deleted in its `finally` block, so none exists at rest. To inspect a live one, reproduce the build and look while the build VM is running (it stays up for the 45-minute wait):

1. Start the build with `pnpm test:guest` from an elevated PowerShell. Once `Get-VM susentorno-test-golden-build` exists, check from another elevated shell:
   - `Get-VM susentorno-test-golden-build | Select State, Uptime, CPUUsage, MemoryAssigned, MemoryDemand, Heartbeat`. Idle at ~0% CPU suggests a hang; busy suggests a spin or a slow step.
   - `Get-VMNetworkAdapter -VMName susentorno-test-golden-build | Select IPAddresses` to see whether it holds an address.
   - `vmconnect localhost susentorno-test-golden-build` to see the console directly. The serial log may be missing output the screen has. `tests/guest/hyperv/vmScreenshot.ts` can capture frames too.
   - Check whether the serial named pipe still has a reader (it is `\\.\pipe\susentorno-test-golden-build`). If a second reader can attach and sees new output, the stall is in the harness reader, not the installer.
2. If the console gives a shell in the live installer: `curl -v http://archive.ubuntu.com/ubuntu/` and a DNS lookup, to test hypothesis 2 against the VM's real path.
3. Run `ensureGoldenImage(..., { force: true })` repeatedly (the earlier ticket's idea) on this host and on a non-nested host. Compare the pass rate.
4. Run `pnpm test:guest` on the commit before the proxy-config-by-copy work (`7fed77d`) to confirm the failure does not depend on those four commits. Do this in place; worktrees are disallowed by AGENTS.md.
5. Cheap harness improvements that would make future failures far cheaper to read, regardless of cause:
   - Make `waitForOff` fail early when the serial log has not grown for N minutes, and at that point dump `Get-VM` state, CPU usage, and a screenshot.
   - Keep the previous run's serial log (rename instead of delete) so that a second failure does not destroy the first one's evidence. Run 1's log was lost this way.
   - Also fail fast if the log shows `Oops` or `BUG:`, as the earlier ticket suggests.
6. If hypothesis 3 or 1 holds, the earlier ticket's option of `drivers: { install: false }` in the autoinstall user-data is worth trying (it avoids the `ubuntu-drivers` call that crashed before).

## Not known

- Whether the build VM can reach the internet at all from this host.
- Whether the installer was alive during the 39 silent minutes.
- Whether the same commit builds on a non-nested host. (The earlier ticket suggests it can.)
- What run 1's log looked like beyond its last lines, which I only saw in the output tail.
