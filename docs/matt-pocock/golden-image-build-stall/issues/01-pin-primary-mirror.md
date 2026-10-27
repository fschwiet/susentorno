# 01: Pin the golden build's primary apt mirror explicitly instead of relying on Subiquity's default list

**Status:** ready-for-agent

**Blocked by:** None (can start immediately).

## Background

The guest tier's golden Ubuntu build stalled because Subiquity's default `apt.geoip: true` swapped in a country mirror (`co.archive.ubuntu.com`) that the build host could not reach. See [the hand-off's `## Comments`](../handoff.md#comments) for the diagnosis. The fix that shipped adds this to the autoinstall user-data in `tests/guest/autoinstall.ts` (`buildUserData`):

```yaml
apt:
  geoip: false
```

That works: a full forced golden build passed with it, the installer log showed `Mirror checking successful`, and the target's sources were `http://archive.ubuntu.com/ubuntu/` and `http://security.ubuntu.com/ubuntu/`. Two things are still left to undocumented Subiquity behaviour:

- The [autoinstall reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html) does not say whether a user-supplied `apt` section is merged with Subiquity's default apt config or replaces it. The default is `mirror-selection.primary: [country-mirror, archive.ubuntu.com (amd64/i386), ports.ubuntu.com (others)]`, `fallback: abort`, `geoip: true`. The fix relies on the merge happening and on `geoip: false` making Subiquity skip the `country-mirror` candidate.
- In the passing run, the installer log contained `Will check next candidate mirror after 10 seconds` before `Mirror checking successful`. So a first candidate was still tried and rejected, costing at least 10 s. This is probably the `country-mirror` entry; that is inferred, not verified.

## What to build

Make the primary mirror explicit in `buildUserData`, so the build no longer depends on how Subiquity merges defaults or treats `country-mirror` with geoip off:

```yaml
apt:
  geoip: false
  mirror-selection:
    primary:
      - uri: "http://archive.ubuntu.com/ubuntu"
```

- Keep `geoip: false`. It is harmless, and it records the intent if someone later drops the explicit list.
- Decide whether to also set `fallback` explicitly. The reference contradicts itself on the default: the prose says `offline-install`, the default block says `abort`. `abort` is probably what the harness wants, since a failed build should fail loudly rather than produce an offline image whose late-commands' `apt-get` then fails. Record the choice in the code comment.
- Update the assertion in `tests/unit/guest/autoinstall.test.ts`: it currently checks `expect(ai.apt).toEqual({ geoip: false })`.
- The golden stamp hashes the user-data (`computeGoldenStamp` in `tests/guest/hyperv/goldenStamp.ts`), so every cached golden image rebuilds once. There is no need to bump `BUILD_ALGORITHM_VERSION`.

## Acceptance

1. The unit test asserts the new `apt` shape, and `pnpm test:unit` passes.
2. A forced golden build completes through `ensureGoldenImage` → `waitForOff`. Run `pnpm test:guest` from an elevated shell, or call `ensureGoldenImage(exec, keys, { force: true })` from a throwaway Vitest file under `test-results/`. Budget about 30 minutes.
3. While the build VM is running, confirm on the live installer (see below) that:
   - `/var/log/installer/subiquity-server-debug.log` shows `Mirror checking successful` **without** a preceding `Will check next candidate mirror` line;
   - `/target/etc/apt/sources.list.d/*.sources` lists `archive.ubuntu.com` / `security.ubuntu.com`.

## Notes for whoever picks this up

- **The serial log is a poor progress signal.** After the Mirror step, a healthy install prints nothing on serial for 10+ minutes while curtin installs packages and runs `unattended-upgrades` in the target. Judge the build by `waitForOff` returning (the VM powers itself off, after about 26 minutes in the passing run), not by serial silence.
- **Shell on the live installer:** tty2 autologs in as `ubuntu-server` with passwordless `sudo`. You can drive it from the host without vmconnect:
  - Get the VM's `Msvm_Keyboard` (`Get-CimAssociatedInstance` from `Msvm_ComputerSystem`). Send Alt+F2: `PressKey 0x12`, `TypeKey 0x71`, `ReleaseKey 0x12`. Then Enter.
  - Type commands one key at a time with `TypeKey` virtual-key codes, holding Shift (`0x10`) for uppercase letters and shifted symbols. `TypeText` garbled the input and toggled Caps Lock; `TypeKey 0x14` toggles it back.
  - Read the output with `GetVirtualSystemThumbnailImage` at 640x480. That is legible; the 320x240 that `tests/guest/hyperv/vmScreenshot.ts` uses is not.
- **Seeing the build VM's traffic:** `pktmon start --capture` on the host shows its HTTP requests, including the `Host:` header, and Envoy's responses. The build VM's DNS answers every name with the host's Envoy (`192.168.67.1`) on this kind of host.
