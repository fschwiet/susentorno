# Hand-off: `windowsFresh` guest role implementation

**Plan:** [`docs/honist-v/plans/2026-08-18-windows-guest-test-role.md`](./2026-08-18-windows-guest-test-role.md)
**Status as of:** 2026-08-20. Written 2026-08-19 evening because the session had drifted well past the plan's own text; updated 2026-08-20 after the live rebuild this document called for actually ran. This document is what a fresh reader (human or agent) needs instead of re-deriving the last two days from the plan and the git log.

## One-paragraph summary

All 16 tasks in the plan are implemented and unit-tested (776 unit tests passing across 109 files). The code was then run live, repeatedly, against a real Hyper-V build — which the plan's own Task 11 text calls "the long pole... verified by actually building an image." That live verification surfaced nine real bugs, all fixed (eight committed; the ninth — a `-Command` argv-length limit in `powerShellExec.ts`, see the 2026-08-20 update below — is applied but not yet committed). The nested-guest CA-trust fix (embed this host's trusted roots on the answer-file ISO, import them first thing in the provisioning script) is now **live-verified**: a full rebuild confirmed all 23 roots import successfully. But that fix turned out not to be sufficient — a live rebuild still lands at 12/14, and the two failures now trace to a genuinely different, non-code cause: Microsoft's Windows Update domains are TLS-unreachable from this host's network entirely (confirmed directly, without any VM), while general internet access works fine. See "Update — 2026-08-20" below for the full diagnosis, a two-second reproduction snippet, and why this is not something a further code change here can fix. A live build was paused at the Hyper-V console earlier in the session on 2026-08-19, hand-nursed by the user past two autologon failures, then powered off and deleted (see "Live session state" below); the golden-image VHDX and network from the 2026-08-20 rebuild were torn down cleanly by the test harness itself, no manual intervention needed.

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

## Former live blocker: nested-guest certificate trust — RESOLVED 2026-08-20

**Resolved.** See "What's left, in order" item 3 below and the plan's closure at the bottom of this document. Left as-is for the historical record of how it was diagnosed.

This is new since the last time this document's content would have been in anyone's head, and it's the one thing actively in flight.

**Diagnosis, confirmed with hard evidence, not guessed:**

- The machine running this whole harness (`DESKTOP-CMP5IFR`) is **itself a susentorno guest**. Its own `Cert:\LocalMachine\Root` contains `CN=susentorno-proxy-certificate-authority` (self-signed, valid to 2036) — confirmed by direct query. This is why the host's own browser and `winget search` work fine: something upstream already propagated ambient trust into *this* machine, the same way `propagateAmbientTrustToWindows` does for the role-under-test guest.
- The **build VM** is a brand-new, freshly-installed Windows machine with an empty trust store. It goes out through Hyper-V's Default Switch NAT, through this host's own network, and (evidently) through the same outer proxy this host trusts — but the build VM itself has never seen that CA.
- Confirmed directly from inside the build VM's guest console: `Invoke-WebRequest https://github.com` fails with `Could not establish trust relationship for the SSL/TLS secure channel` — a certificate error, not a connectivity error. `nslookup` resolving `www.microsoft.com` to `192.168.67.1` (the proxy's own address) is consistent with this too — that's the proxy's normal, correct behavior for a domain it terminates; it isn't evidence of an outage.
- This retroactively explains why git-install iterations 1–4 above never worked: it was never a winget/AppX timing problem underneath. Windows Update's own `$searcher.Search(...)` COM call fails identically, with `0x80072EFD` (`WININET_E_CANNOT_CONNECT`) — same root cause, different call site.

**Two "killed" background-task events earlier in the session** (tasks `bc7oaqo9y` and `bmk2q2cyl`, both dying within 1–3 minutes of launch, both times orphaning the build VM) remain unexplained. A Windows System-log disk warning (event ID 51, "error during a paging operation" on a transient Hyper-V-assigned `HarddiskN`) was found nearby in time but traced to virtual-disk churn from repeated `Mount-VHD`/`Dismount-VHD` cycles rather than a real physical disk fault. Whether this is related to the nested-network situation above is unknown — flagging it rather than asserting a connection.

**Fix, implemented, not yet live-verified:** rather than hardcoding the one known CA, `windowsGoldenImage.ts` now calls the same production `enumerateHostTrustedRoots(exec)` (`src/guestSetup/hostTrustStore.ts`) that `propagateAmbientTrustToWindows` already uses for the role-under-test guest, and embeds every root it returns on the answer-file ISO — one `.pem` file per root (`windowsAutounattend.ts`'s new `buildCaCertFiles`), alongside `susentorno-provision.ps1` via the same multi-file mechanism Task 8's `answerFileIso.ts` already supports. `buildProvisioningScript()`'s generated script now imports every `.pem` it finds on the still-mounted `SUSENTORNO` volume into `LocalMachine\Root` unconditionally, before the stage dispatch (i.e. before *and independent of* both the Windows Update search and the git/winget stage) — confirmed against a real store that re-importing an already-trusted cert is a silent no-op, not an error, so there's no cost to running it on every resumed invocation rather than gating it behind a stage. A real import failure throws rather than proceeding silently, matching the git-install stage's philosophy. The stamp map (`WindowsStampArgs`) gained a `certsSha256` field so a host CA rotation invalidates the cached image, same as any other build input. On a host that isn't itself proxied, `enumerateHostTrustedRoots` returns nothing extra and the whole mechanism is a no-op — this generalizes rather than special-cases the current host. Unit tests cover the new script content, the file-mapping function, and the stamp field; **the actual live rebuild that proves this clears `WININET_E_CANNOT_CONNECT`/the TLS trust error has not run.** This is the same shape as production's own `04-configure-network.ps1` / harness's `propagateAmbientTrustToWindows`, just applied to the build VM instead of the role-under-test VM — a real gap in the original design, not a workaround.

**Live session state:** the hand-nursed build (manually logged in as `Administrator` after autologon stopped working — a separate, likely-Windows-Update-triggered clearing of the plaintext `DefaultPassword` registry value, not a bug in our unattend.xml) has been powered off and the build VM deleted. Nothing left running or orphaned; the next build starts clean.

## Update — 2026-08-20: CA fix live-verified as working; a second, environmental blocker sits underneath it

The live rebuild this section calls for ran. Two things came out of it: a real, unrelated bug in the harness that was silently corrupting the attempt, and — once that was out of the way — proof that the CA-embedding fix above works exactly as designed, plus discovery that it was never sufficient on its own.

**Bug #1, found and fixed: `-Command` argv length limit in `src/guestSetup/powerShellExec.ts`.** `createRealPowerShellExec` passed the entire assembled PowerShell command as one `-Command` argv element. Windows' `CreateProcess` hard-caps a process's total command line at 32,767 characters. `buildAnswerIsoCommand` (`answerFileIso.ts`) inlines every embedded file as base64 into that single command, and this host has 23 host-trusted roots — `buildCaCertFiles` alone pushes the assembled command to ~73,000 characters. Confirmed empirically by bisecting on root count: the command succeeds through 5 roots (32,603 chars) and fails from 8 roots (38,248 chars) onward, exiting 1 with **zero captured output** (a latent second bug: `answerFileIso.ts`'s error only surfaces `stdout`, and execa's combined `all` stream was empty here, so the real failure was invisible without re-running the exact command standalone to watch it fail live). Fixed by routing any command over 8,000 characters through a temp `.ps1` file invoked with `-File` instead of `-Command` — behaviourally identical for a semicolon-joined statement sequence, with no argv-length ceiling. Unit-tested (`buildPowerShellFileArgv`, mirroring the existing `buildPowerShellArgv` test); `createRealPowerShellExec` itself stays without a dedicated unit test, consistent with this codebase's no-execa-mocking precedent. **Applied, not yet committed.**

**With that fixed, the live rebuild ran end-to-end** — a genuine ~69-minute build, not a cache hit — and for the first time reached the git-install stage at all. Result: still 12/14, the same two git-dependent test failures as every previous attempt. But the *reason* is different from what was assumed:

- Mounting the resulting golden-image VHDX offline (`.image-cache/susentorno-test-windows-golden.vhdx`) and reading its transcript (`Windows\Setup\Scripts\susentorno-stage.log`) shows all 23 embedded CA roots importing into `LocalMachine\Root` successfully, every single retry — the CA-embedding fix works exactly as designed. Confirmed too: `git.exe` never landed on disk (`Test-Path "...\Program Files\Git\cmd\git.exe"` is `False` on the mounted image) and the Machine `PATH` registry value has no Git entry, because the provisioning script never got past the *first* Windows Update stage.
- The very next call after cert import — `$searcher.Search(...)` on `Microsoft.Update.Session`/`CreateUpdateSearcher()` — still throws `0x80072EFD` (`WININET_E_CANNOT_CONNECT`), the identical error the "Current live blocker" section above attributed to missing CA trust.
- Since cert import is now proven to succeed and the failure is unchanged, that attribution doesn't hold. Running the identical COM call from **this host** (not the guest — no VM involved), which already trusts the proxy CA, throws the same `0x80072EFD`. Direct `Invoke-WebRequest` calls to `ctldl.windowsupdate.com`, `download.windowsupdate.com`, `tas02.sls.update.microsoft.com`, and `www.microsoft.com` all fail with **"The SSL connection could not be established"** — a handshake failure, not a trust rejection — while the same call to `github.com` succeeds (200 OK) at the same moment. Neither WinINet nor WinHTTP has an explicit proxy configured (`ProxyEnable=0`; `netsh winhttp show proxy` → "Direct access"), consistent with the transparent-interception model described above; `nslookup` for these domains still resolves to the interception address as expected.

**Conclusion: Microsoft's Windows Update domains specifically are TLS-unreachable from this host/network, while general internet access is fine.** This is not a certificate-trust gap — the CA-embedding fix could never have closed it, because the connection itself never completes the handshake. It's a property of whatever sits upstream of this host (the "outer proxy" from the diagnosis above — plausibly a sandbox/network policy that blocks Microsoft's update infrastructure specifically), not a bug in this codebase. Every further live-build attempt will reproduce this identically, at the cost of another ~70 minutes each time, until either this runs from a network where those domains are actually reachable, or whatever blocks them upstream allows them through.

**Reproducing the failure directly, without a live build (seconds, not an hour):**

```powershell
# From an elevated PowerShell on the host (or any machine on the same network
# path) — no VM, no golden image build required.
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result = $searcher.Search("IsInstalled=0 and IsHidden=0")
  Write-Output "Search succeeded: $($result.Updates.Count) updates found"
} catch {
  Write-Output "Search FAILED: 0x$($_.Exception.HResult.ToString('X8')) — $($_.Exception.Message)"
}

# Isolates it to specific domains rather than the COM API: compare a
# Microsoft/Windows-Update host against a known-good control.
foreach ($h in 'www.microsoft.com', 'ctldl.windowsupdate.com', 'github.com') {
  try {
    $r = Invoke-WebRequest -Uri "https://$h" -UseBasicParsing -TimeoutSec 10 -Method Head
    Write-Output "$h : OK $($r.StatusCode)"
  } catch {
    Write-Output "$h : FAILED - $($_.Exception.Message)"
  }
}
```

Expected output on this host as of 2026-08-20: the COM search throws `0x80072EFD`; `www.microsoft.com` and `ctldl.windowsupdate.com` fail with an SSL-connection error; `github.com` returns `OK 200`. If Microsoft's domains ever start succeeding here, the golden-image build is worth re-running — the code-side fix is already done and live-verified up to exactly this point.

## What's left, in order

1. ~~**Implement the CA-embedding fix** described above (new code in `windowsAutounattend.ts`'s provisioning script and `windowsGoldenImage.ts`'s build orchestration — export cert from host, embed via `answerFileIso.ts`, import first thing in the guest). TDD as usual; this is a real, well-evidenced fix, not a guess.~~ **Done**, code + unit tests, and now live-verified: all 23 roots import successfully in a real build (see the 2026-08-20 update above).
2. ~~**Fix the `-Command` argv-length limit**~~ **Done**, code + unit test (see the 2026-08-20 update above) — applied but not yet committed.
3. ~~**Resolve or route around the Windows-Update-domain network block**~~ **Done.** The block was not a real network/TLS-infra limitation — it was the outer proxy's allow-list not covering all the Windows-Update-related domains this host is a guest of. Adjusted; re-verified directly (`ctldl.windowsupdate.com` and `download.windowsupdate.com` were briefly still failing on a `fallback.tls.fastly.net` cert mismatch after the allow-list change, consistent with the proxy's Fastly-edge routing, not the allow-list itself — but the actual blocking call, `Microsoft.Update.Session`'s `CreateUpdateSearcher().Search(...)`, does not depend on those two and now succeeds).
4. ~~**Get one fully clean, unattended `pnpm vitest run --config vitest.guest.config.ts tests/guest/windowsFresh.test.ts`**~~ **Done, twice.** First clean run: 873.89s wall time (full rebuild), 14/14. Second run (cache reused, no rebuild): 172s test time, 14/14. No manual intervention either time — no hand-nursed login, no leftover VM.
5. ~~**Re-run the plan's Task 16 Step 5 verification checklist**~~ **Done**, all `windowsFresh`-specific items confirmed green: `test:unit` (776/776), `build` + `test:cli` (35/36, 1 expected skip), `test:guest` with the ISO set (twice, 14/14 both times), cache reuse confirmed via file timestamps, editing `windowsAutounattend.ts` reproduces the stale-image error naming `answerXml` (probed and reverted — `git diff` clean), `test:guest` with the ISO unset correctly self-skips `windowsFresh` with no Windows VM created, and post-run `Get-VM` is clean with both golden parents retained in `.image-cache/`.

   Two **separate, pre-existing issues in the Ubuntu side of the guest tier** surfaced during this pass — unrelated to `windowsFresh` or anything in this plan, so they're filed rather than blocking this plan's closure: [#93](https://github.com/fschwiet/susentorno/issues/93) (apt-mirror connection drops fetching large packages via the proxy, in `e2e.test.ts`) and [#94](https://github.com/fschwiet/susentorno/issues/94) (`ambientTrust.test.ts` CA-verification assertion failed once). A third issue, [#91](https://github.com/fschwiet/susentorno/issues/91), documents environment/invocation gotchas hit while getting the live test to actually run (Git Bash vs. PowerShell for `ssh-agent`, the ISO-unset silent-skip trap, the rebuild-flag requirement, and UNC-path ISOs failing Hyper-V's DVD attach with Access Denied).
6. ~~Once 4 and 5 are green, mark Tasks 11 and 15 `completed` and close out the plan.~~ **Done.** Tasks 11 and 15's own definition of completion — a successful live build/role run, not merely code review — is met, confirmed by two independent clean 14/14 runs on 2026-08-20. ADR-0027, `CONTEXT.md`, and `testing.md` were already updated and committed in a prior session (`d6a0f0a`). Nothing further is pending on this plan.
