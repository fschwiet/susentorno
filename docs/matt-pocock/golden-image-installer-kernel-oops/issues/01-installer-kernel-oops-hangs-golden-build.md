# 01: Ubuntu 26.04 installer kernel oops can hang the guest tier's golden image build

**Status:** needs-triage

**What happened:** On 2026-09-26 a full `pnpm test` (elevated, Windows 11 Pro 10.0.26200 host, first golden build on that machine) failed in the `guest` tier's global setup, before any guest test ran:

```
Error: goldenImage: build VM did not power off; see C:\code\susentorno\.image-cache\golden-build-serial.log
 ❯ waitForOff tests/guest/hyperv/goldenImage.ts:117:9
 ❯ ensureGoldenImage tests/guest/hyperv/goldenImage.ts:183:5
 ❯ Object.setup tests/guest/globalSetup.ts:28:3
```

The serial log showed the live installer's kernel oopsing in overlayfs while Subiquity was applying its autoinstall config, right after the Mirror step. The installer then hung, and `waitForOff` hit its 45-minute deadline. An immediate rerun of `pnpm test:guest` on the same commit and machine rebuilt the image cleanly and passed. So this is intermittent, not deterministic.

The failing commit was `f85d8a9` (codex real-account-id work). That change doesn't touch the golden image build, the autoinstall config, or the ISO.

**Evidence** (from `.image-cache/golden-build-serial.log`; the next build overwrites that file, so the key lines are kept here):

```
start: subiquity/Mirror/cmd-apt-config: curtin command apt-config
finish: subiquity/Mirror/cmd-apt-config: curtin command apt-config
[ 2458.169321] BUG: unable to handle page fault for address: ffffffffc0815f50
[ 2458.180263] Oops: Oops: 0000 [#1] SMP NOPTI
[ 2458.181427] CPU: 1 UID: 0 PID: 3280 Comm: ubuntu-drivers Not tainted 7.0.0-14-generic #14-Ubuntu PREEMPT(lazy)
[ 2458.184076] Hardware name: Microsoft Corporation Virtual Machine/Virtual Machine, BIOS Hyper-V UEFI Release v4.1 09/25/2025
[ 2458.189283] RIP: 0010:ovl_iterate_merged+0x1d8/0x2b0 [overlay]
...
[ 2474.490586] Oops: general protection fault, probably for non-canonical address 0xccccccccccccccfd: 0000 [#2] SMP NOPTI
 ovl_iterate+0xd3/0x120 [overlay]
 wrap_directory_iterator+0x4f/0x80
 shared_ovl_iterate+0x15/0x30 [overlay]
 iterate_dir+0xc1/0x2a0
 __x64_sys_getdents64+0x76/0x140
```

- ISO: `https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso` (`tests/guest/hyperv/imageCache.ts`). Live kernel `7.0.0-14-generic`.
- Build VM: 2 vCPUs, 4 GiB startup memory, `Default Switch`, Secure Boot off (`ensureGoldenImage` in `tests/guest/hyperv/goldenImage.ts`).
- The faulting process was `ubuntu-drivers`, doing a `getdents64` over the live session's overlay root.

**Questions to investigate:**
- Is this a known 26.04 / 7.0 kernel overlayfs bug? Is a fixed point-release ISO or kernel available?
- The autoinstall user-data sets no `drivers:` section, so Subiquity runs `ubuntu-drivers` by default. Would `drivers: { install: false }` (or an equivalent) stop Subiquity invoking `ubuntu-drivers` during the install, avoiding the crash path? Check whether Subiquity still calls it just to list drivers.
- Should `waitForOff` fail fast when the serial log shows a kernel `Oops`/`BUG`, rather than waiting the full 45 minutes? That wouldn't fix the flake, but it would make it much cheaper and point straight at the cause.
- How often does it happen? Repeated forced golden builds (`ensureGoldenImage(..., { force: true })`) would give a rough rate.
