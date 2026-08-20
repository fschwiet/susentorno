# Hand-off: `windowsFresh` guest role implementation

**Plan:** [`docs/honist-v/plans/2026-08-18-windows-guest-test-role.md`](./2026-08-18-windows-guest-test-role.md)
**Status as of:** 2026-08-19, evening. Written because the session has drifted well past the plan's own text — this document is what a fresh reader (human or agent) needs instead of re-deriving the last several hours from the plan and the git log.

## One-paragraph summary

All 16 tasks in the plan are implemented and unit-tested (775 unit tests passing across 109 files). The code was then run live, repeatedly, against a real Hyper-V build — which the plan's own Task 11 text calls "the long pole... verified by actually building an image." That live verification surfaced seven real bugs, all fixed and committed. An eighth issue was diagnosed and is now **fixed in code, but not yet live-verified**: the nested Windows build VM cannot install git or complete Windows Update because it doesn't trust this host's own TLS-intercepting proxy CA — and this host, it turns out, is itself a susentorno guest, which the plan never anticipated. The fix (embed the host's trusted roots on the answer-file ISO, import them first thing in the provisioning script) landed with unit tests; the live rebuild that proves it actually clears the blocker has not run yet. A live build was paused at the Hyper-V console earlier in the session, hand-nursed by the user past two autologon failures, blocked on this exact issue, then powered off and deleted (see "Live session state" below) — the next build starts clean.

## What's done

**Stage 1 (template trim) — fully landed**, commits `07ec461`, `ebe12ad`, `85d40ca`. No drift from the plan.

**Stage 2 (golden image pipeline) — code complete, live-verified through Windows Update, blocked at git install.** Commits `b381445` through `82e7792` (see git log for the full list — roughly 20 commits, mixing the plan's own Task 4–14 commits with live bug fixes discovered along the way).

**Stage 3 (the role) — code complete, never yet seen a clean 14/14 pass.** `windowsFresh.test.ts` has reached 12/14 passing repeatedly; the 2 failures are both git-dependent assertions, tracking the same unresolved blocker.

Task List reflects this: Tasks 1–10, 12–14, 16 are `completed`. Tasks 11 and 15 are `in_progress` — deliberately, because the plan defines their completion as a successful live build/role run, not merely passing code review.

## Where the implementation drifted from the plan

The plan's pseudocode was a reasonable starting draft, not a spec that survived contact with a real Windows Setup. Every drift below was forced by something observed live, never a stylistic preference.

### 1. `WINDOWS_GUEST_HOSTNAME` shortened

Plan said `'susentorno-test-win'` (19 chars). NetBIOS computer names hard-limit at 15. A longer name doesn't error at Setup start — it gets silently rejected during the *specialize* pass, surfacing many minutes later as a generic "the computer restarted unexpectedly" dialog with no on-screen detail. Root-caused only by mounting the built VHDX offline and reading `Windows\Panther\setuperr.log`. Now `'susentorno-win'` (14 chars). Commit `06913fa`.

### 2. The provisioning script ships as a separate ISO file, not inlined

Plan's `buildAutounattendXml` took `{ password, provisioningScript }` and embedded the whole script, base64-encoded, into a `FirstLogonCommands` `CommandLine`. That field has an undocumented ~4096-character limit; the encoded script blew past it, and Setup rejected the *entire* answer file — again surfacing only as a late, generic failure. Fixed by generalizing `answerFileIso.ts` (Task 8's module) to carry multiple named files, not just `Autounattend.xml`, and shipping the provisioning script alongside it as `susentorno-provision.ps1` on the SUSENTORNO-labeled volume, fetched by a short `Copy-Item` in `FirstLogonCommands` instead. **`buildAutounattendXml`'s actual signature is now `{ password: string }`** — narrower than the plan's interface. Commit `15dab44`.

### 3. Explicit `<InstallTo>` disk/partition target

The plan's `DiskConfiguration` had no `InstallTo`, relying on `InstallToAvailablePartition`. With `WillWipeDisk` creating three partitions (EFI/MSR/Primary) and no explicit target, Setup fell back to the interactive "Select location to install Windows 11" disk picker and hung — confirmed live, the build VM sat there 37 minutes. Fixed by adding `<InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>`, matching `CreatePartitions`' own Order-3 primary partition. Commit `4f62c0f`.

### 4. Windows Update loop rewritten around per-update result codes

The plan's version installed a batch, checked only `RebootRequired`, and always rebooted — including when nothing failed and nothing needed a reboot, busy-looping reboots unnecessarily. Rewritten as a `while ($true)` loop that calls `GetUpdateResult($i)` per update, checks `ResultCode` explicitly, and only reboots when `RebootRequired` is true or an install actually failed. Commit `7a3326f` (and a near-duplicate `27b5da6` earlier in the log — the fix was applied, reverted by a rebase/reorder, then reapplied; the final state is correct).

### 5. Git install: four fix iterations, still not fully closed

This is the largest single area of drift and the one still blocking completion. The plan's version was a single bare `winget install`. Live iteration:

1. **No error checking at all** → added `$LASTEXITCODE` check + retry loop (commit `3f50c21`). Did not fix it.
2. Root-caused: `winget` itself is not yet command-resolvable that early after an OOBE-skipped first logon — an unrecognized command is a *terminating* PowerShell error under `$ErrorActionPreference = 'Stop'`, not a native exit code, so the `$LASTEXITCODE` check never even ran. Fixed with try/catch + `Get-Command`/full-path fallback (commit `4c2b571`). Verified via live rebuild — still failed identically.
3. Root-caused via **offline VHDX mount**: `Microsoft.DesktopAppInstaller` is staged in `WindowsApps` and its `winget.exe` execution alias exists for the Administrator profile, but the package isn't yet *registered* for that profile this early. An unregistered alias is a phantom stub — it exits 0 and does nothing, so exit-code checking alone can never distinguish success from a no-op. Fixed by force-registering the package (`Add-AppxPackage -DisableDevelopmentMode -Register`) before calling winget, and by verifying `git.exe` actually exists on disk rather than trusting the exit code (commit `4b4a293`). Verified via live rebuild — **still** failed identically (`Program Files\Git` still absent afterward).
4. Moved the registration *inside* the retry loop (one-shot registration before the loop wasn't enough) and added persistent transcript logging (`Start-Transcript -Path ... -Append`, flushed before every reboot/shutdown/throw) so the next failure could be read directly instead of inferred from which files exist afterward (commit `82e7792`). This is what's currently live-deployed.

None of iterations 1–4 were the real root cause. See "Current live blocker" below — it's a certificate trust gap, not a winget/AppX timing issue at all. Iteration 4's registration-retry and (especially) its transcript logging are still worth keeping regardless: the logging is what let us see the real problem, live, without another blind rebuild. (The transcript file is `C:\Windows\Setup\Scripts\susentorno-stage.log`, derived from the stage-marker filename.)

### 6. DVD "press any key" boot prompt keystroke injection — entirely new module, not in the plan

The plan didn't anticipate this at all. Windows Setup media's own boot loader shows "Press any key to boot from CD or DVD..." with a short timeout; an unattended start never presses one, so the VM fell through to an empty disk and failed with "the boot loader failed." New module `tests/guest/hyperv/windowsBootPrompt.ts` (`buildDefeatCdBootPromptCommand`) sends a keystroke via `Msvm_Keyboard.TypeText` over WMI. It has to run for the *entire* build, not just the first boot — Setup's own internal reboots (and later Windows Update's) hit the same prompt every time, since Hyper-V's firmware `BootOrder` stays pinned to the DVD and never gets reordered once the disk is installed. Runs concurrently (not awaited) for up to 2 hours, exiting early if the VM leaves the `Running` state. Commit `a57742f`.

### 7. Framebuffer screenshot capture — off-by-4-bytes fix

`Msvm_VirtualSystemManagementService.GetVirtualSystemThumbnailImage` returns a few extra header bytes the plan's pseudocode didn't account for. Fixed by trimming to `raw.subarray(raw.length - expectedBytes)` before RGB565→BMP conversion, confirmed empirically against three different resolutions. Same commit `a57742f`.

### 8. Build VM memory: bumped, then reverted, on a wrong hypothesis

"Computer restarted unexpectedly" crashes (see item 1) were initially misdiagnosed as guest memory pressure and the build VM's memory was bumped 4→6→8 GiB across three commits (`2242aa2`, `a51bf11`, and one more). Once the real causes (hostname length, `CommandLine` length) were found and fixed, memory was reverted to the original 4 GiB — Windows 11's documented minimum, kept modest deliberately since this build VM runs alongside whatever else is on the host. Commit `d33c57b`. Net effect: no drift in the final state, but three commits of churn the plan didn't anticipate.

### 9. `windowsGuestExec.ts`: PSModulePath reset before `ConvertTo-SecureString`

Not anticipated by the plan at all, and specific to the host machine running the harness rather than anything in the guest. When the *host* process's own `$env:PSModulePath` has PowerShell 7's module paths mixed in (true whenever `pwsh.exe` sits anywhere in the process's ancestry — a session launched via `pwsh` rather than `cmd`/`bash`), Windows PowerShell 5.1 resolves `Microsoft.PowerShell.Security` to an incompatible PS7 build and `ConvertTo-SecureString` fails to load its module on *every single* PowerShell Direct invocation — silently, since the guest itself answers fine outside the harness. This manifested as `waitForPowerShellDirect` seeing 80 identical failures over 20 minutes. Fixed by prepending the real WinPS5.1 system32 module path before anything else runs, in `buildInvokeDirectCommand`. Commit `c2386d5`. Honors the plan's "no changes to `src/`" constraint — fixed in the harness (`tests/guest/windowsGuestExec.ts`), not in `src/guestSetup/powerShellExec.ts`.

## Current live blocker: nested-guest certificate trust (fixed in code, not yet live-verified)

This is new since the last time this document's content would have been in anyone's head, and it's the one thing actively in flight.

**Diagnosis, confirmed with hard evidence, not guessed:**

- The machine running this whole harness (`DESKTOP-CMP5IFR`) is **itself a susentorno guest**. Its own `Cert:\LocalMachine\Root` contains `CN=susentorno-proxy-certificate-authority` (self-signed, valid to 2036) — confirmed by direct query. This is why the host's own browser and `winget search` work fine: something upstream already propagated ambient trust into *this* machine, the same way `propagateAmbientTrustToWindows` does for the role-under-test guest.
- The **build VM** is a brand-new, freshly-installed Windows machine with an empty trust store. It goes out through Hyper-V's Default Switch NAT, through this host's own network, and (evidently) through the same outer proxy this host trusts — but the build VM itself has never seen that CA.
- Confirmed directly from inside the build VM's guest console: `Invoke-WebRequest https://github.com` fails with `Could not establish trust relationship for the SSL/TLS secure channel` — a certificate error, not a connectivity error. `nslookup` resolving `www.microsoft.com` to `192.168.67.1` (the proxy's own address) is consistent with this too — that's the proxy's normal, correct behavior for a domain it terminates; it isn't evidence of an outage.
- This retroactively explains why git-install iterations 1–4 above never worked: it was never a winget/AppX timing problem underneath. Windows Update's own `$searcher.Search(...)` COM call fails identically, with `0x80072EFD` (`WININET_E_CANNOT_CONNECT`) — same root cause, different call site.

**Two "killed" background-task events earlier in the session** (tasks `bc7oaqo9y` and `bmk2q2cyl`, both dying within 1–3 minutes of launch, both times orphaning the build VM) remain unexplained. A Windows System-log disk warning (event ID 51, "error during a paging operation" on a transient Hyper-V-assigned `HarddiskN`) was found nearby in time but traced to virtual-disk churn from repeated `Mount-VHD`/`Dismount-VHD` cycles rather than a real physical disk fault. Whether this is related to the nested-network situation above is unknown — flagging it rather than asserting a connection.

**Fix, implemented, not yet live-verified:** rather than hardcoding the one known CA, `windowsGoldenImage.ts` now calls the same production `enumerateHostTrustedRoots(exec)` (`src/guestSetup/hostTrustStore.ts`) that `propagateAmbientTrustToWindows` already uses for the role-under-test guest, and embeds every root it returns on the answer-file ISO — one `.pem` file per root (`windowsAutounattend.ts`'s new `buildCaCertFiles`), alongside `susentorno-provision.ps1` via the same multi-file mechanism Task 8's `answerFileIso.ts` already supports. `buildProvisioningScript()`'s generated script now imports every `.pem` it finds on the still-mounted `SUSENTORNO` volume into `LocalMachine\Root` unconditionally, before the stage dispatch (i.e. before *and independent of* both the Windows Update search and the git/winget stage) — confirmed against a real store that re-importing an already-trusted cert is a silent no-op, not an error, so there's no cost to running it on every resumed invocation rather than gating it behind a stage. A real import failure throws rather than proceeding silently, matching the git-install stage's philosophy. The stamp map (`WindowsStampArgs`) gained a `certsSha256` field so a host CA rotation invalidates the cached image, same as any other build input. On a host that isn't itself proxied, `enumerateHostTrustedRoots` returns nothing extra and the whole mechanism is a no-op — this generalizes rather than special-cases the current host. Unit tests cover the new script content, the file-mapping function, and the stamp field; **the actual live rebuild that proves this clears `WININET_E_CANNOT_CONNECT`/the TLS trust error has not run.** This is the same shape as production's own `04-configure-network.ps1` / harness's `propagateAmbientTrustToWindows`, just applied to the build VM instead of the role-under-test VM — a real gap in the original design, not a workaround.

**Live session state:** the hand-nursed build (manually logged in as `Administrator` after autologon stopped working — a separate, likely-Windows-Update-triggered clearing of the plaintext `DefaultPassword` registry value, not a bug in our unattend.xml) has been powered off and the build VM deleted. Nothing left running or orphaned; the next build starts clean.

## What's left, in order

1. ~~**Implement the CA-embedding fix** described above (new code in `windowsAutounattend.ts`'s provisioning script and `windowsGoldenImage.ts`'s build orchestration — export cert from host, embed via `answerFileIso.ts`, import first thing in the guest). TDD as usual; this is a real, well-evidenced fix, not a guess.~~ **Done**, code + unit tests (see "Current live blocker" above) — not yet exercised live.
2. **Get one fully clean, unattended `pnpm vitest run --config vitest.guest.config.ts tests/guest/windowsFresh.test.ts`** — 14/14, no manual intervention, matching the plan's own definition of "verified." (No leftover build VM or hand-nursed session to account for — the environment starts clean.) This is also the first live test of the CA-embedding fix above; if it doesn't clear the TLS trust error, treat step 1 as still open.
3. **Re-run the plan's Task 16 Step 5 verification checklist** (bottom of the plan doc) — none of its items have been formally re-checked since these fixes landed: unit tier, CLI tier, guest tier with and without the ISO var, cache reuse on a second run, stale-image error naming a changed input, and clean `Get-VM` output after a full run.
4. Once 2 and 3 are green, mark Tasks 11 and 15 `completed` and close out the plan per the executing-plans skill's normal final step.
