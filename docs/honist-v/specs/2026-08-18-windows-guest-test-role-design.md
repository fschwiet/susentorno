# The Windows guest test role

## Purpose

The `guest` tier boots real Hyper-V VMs on a real Internal switch served by the real `run-hosting` ([ADR-0025](../../adr/0025-guest-layer-tested-against-real-hyperv.md)), but every guest it boots is Ubuntu. `templates/vm-shared-windows/` and the manual Windows procedure in `setup-guest.md` are covered by no automated test at all. This design adds one Windows guest role to that tier.

The claim the role makes:

> **A real Windows guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, takes its entire network configuration from the host and reaches exactly the destinations the network policy permits and nothing else.**

That is deliberately the same claim ADR-0025 makes for Ubuntu, restricted to the network boundary. It is the Windows counterpart of `tests/guest/fresh.test.ts`: a guest that boots directly into the isolated phase and is asserted against without ever having seen the Default Switch.

Because the role makes the `templates/vm-shared-windows/` scripts testable for the first time, it also discharges a commitment [ADR-0024](../../adr/0024-shipped-guest-templates-carry-only-requirements.md) deferred, which recorded that directory as *"a known, deliberate exception on the day this is written"* precisely because *"the Windows guest path is covered by no test tier — the trim would be unverifiable beyond review, and a Windows guest may enter the test mix later, which would change what 'required' means there."* That condition now holds, so the Windows template trim lands in this changeset.

## Scope

**Added**

- A `windowsFresh` role in `tests/guest/`: a Windows golden-image pipeline, VM lifecycle, PowerShell Direct guest access, framebuffer screenshot diagnostics, and one test file.
- A harness-side guest installer for ambient trust roots, driven by the production host-side enumerator.
- Unit tests for the new pure functions.
- Documentation of `SUSENTORNO_WINDOWS_ISO` as a guest-tier prerequisite.

**Changed in `templates/` — the ADR-0024 trim**

`templates/vm-shared-windows/` reduced to what a susentorno guest requires. Detailed in section 4.

**Changed in `tests/`**

- `hyperv/imageCache.ts`, `hyperv/goldenStamp.ts`, `hyperv/sweep.ts`, `hyperv/vm.ts`, `testShare.ts`, `globalSetup.ts`. Detailed in section 5.

**Changed in `src/` — nothing.**

This is a deliberate constraint, carried over from the 2026-08-15 tier design's observation that *"a design that needs a capability added to make a test work should be re-examined first."* Where the role needs something the production modules do not offer for Windows — invoking a `.ps1` provisioning script, mounting a share, installing ambient roots — the harness does it directly rather than growing a half-used product capability with no caller.

**Deleted**

- `templates/vm-shared-windows/pre-scripts/04-configure-tools.ps1`.

**Explicitly not in scope**

- **A `setup-guest-windows` command.** Automating the manual Windows procedure the way `setup-guest-unix` automated Ubuntu's is a product feature, and it should be designed against a working Windows guest role rather than at the same time as one.
- **Running the Windows pre-scripts and post-scripts under test.** The `phases`/`e2e` equivalents for Windows — `01`–`03`, `01-auth-config.ps1`, `02-apply-home-jq-transforms.ps1` — are a follow-on spec. `04-configure-network.ps1` is in scope only because it *is* the network boundary.
- **A Windows arm of `propagateAmbientTrust` in `src/`.** Section 3 explains why the propagation this role needs lives in the harness instead.
- **The two divergences found while designing this.** Recorded under "Found and deferred".

## Two properties the design holds

- **The image is defined by repo contents, as far as it can be.** `computeGoldenStamp()` encodes a claim that the golden image is a function of its recorded inputs, and that claim is what makes a corrupted or hand-mutated image self-healing. This design keeps it for the answer file, the provisioning script, the credential, and the ISO identity — and gives it up honestly, in writing, for Windows Update state.
- **Safe to rerun, sweeps residue regardless of origin.** Unchanged from ADR-0025. Everything the role creates derives from the `test` isolation name and is swept by name at startup and teardown.

## 1. The Windows golden image pipeline

`ensureWindowsGoldenImage()` mirrors `ensureGoldenImage()`'s contract — return the path to a golden VHDX matching current inputs — with three behavioural differences: the ISO comes from an environment variable, a stale image is refused rather than silently rebuilt, and diagnostics are screenshots rather than a serial log.

### 1.1 Acquisition

Ubuntu's pipeline is bootstrappable from clean because `releases.ubuntu.com` publishes both a stable ISO URL and `SHA256SUMS`, so `isoCache.ts` downloads and verifies unattended. Windows has no equivalent: the Enterprise evaluation sits behind a registration form at `info.microsoft.com` and yields a short-lived signed URL. Unattended acquisition is therefore impossible, and this design gives it up rather than working around it.

`SUSENTORNO_WINDOWS_ISO` names a local path to a Windows 11 Enterprise evaluation ISO. Obtaining it is a documented one-time prerequisite alongside Hyper-V, Docker, and `ssh-agent`. The harness reads the path, fails fast if it is unreadable, and hashes the file once so its digest can enter the stamp — pointing the variable at a different build invalidates the cached image.

When the variable is unset, the entire role self-skips with a prescriptive message naming the variable and the acquisition documentation. There is precedent on both counts: `testing.md` already records that cli-tier tests *"self-skip when [`jq`] is unavailable"*, and commit `147f30a` established that a missing external prerequisite should produce a prescriptive message rather than a bare failure. Unlike Hyper-V or Docker, this prerequisite genuinely cannot be satisfied by a script, so a skip is truthful rather than merely convenient.

### 1.2 Seeding the answer file — no seed disk

Ubuntu needs a separate `CIDATA`-labelled volume because that is what cloud-init looks for. Windows Setup instead searches the root of the installation media, and `makeInstaller()` already builds exactly that: it mounts the ISO, copies the tree into a FAT32 VHDX, and retypes the partition as an ESP.

So `autounattend.xml` is written straight into the installer VHDX root using the existing `writeFile()` helper, and `makeSeed()` has no Windows counterpart. One fewer disk, one fewer failure mode, and `buildCopyTreeCommand`/`buildCreateFat32VolumeCommand`/`buildSetEspTypeCommand` carry over unchanged.

Secure Boot is **off on the build VM**, exactly as the Ubuntu build does via `buildDisableSecureBootCommand`. It is not a property the installed image persists, and leaving it off removes one variable from the least-debuggable phase. The role VM enables it.

### 1.3 What `autounattend.xml` does

In pass order:

1. **WinPE pass:** set `BypassTPMCheck`, `BypassSecureBootCheck`, and `BypassRAMCheck` under `HKLM\SYSTEM\Setup\LabConfig`, so Setup proceeds on a VM with no vTPM.
2. **Disk configuration:** GPT layout across the whole target disk.
3. **Specialize/oobeSystem:** enable the built-in `Administrator` account with a harness-generated password; set `LocalAccountTokenFilterPolicy`; skip OOBE entirely, including the Microsoft-account push that `setup-guest.md:32` currently works around by unplugging the network adapter.
4. **Policy:** disable Windows Update, Microsoft Store auto-update, DiagTrack telemetry, and consumer experiences; set `PreventDeviceEncryption`.
5. **Autologon** for the built-in `Administrator`, with `AutoLogonCount` of 10 — the update loop reboots once per servicing pass and rarely needs more than a few, so 10 leaves headroom without leaving autologon enabled indefinitely. The provisioning script clears the credential explicitly at the end regardless of the remaining count.

### 1.4 Firmware, and the BitLocker trap

The tier's economy rests on `buildNewDifferencingVhdCommand` — one golden parent, a thin child per role — and `vhd.ts` already warns that *"Hyper-V stamps parent identity into each child, so the golden VHDX must never be booted or modified after the build."*

Windows 11 24H2 and later enable **automatic device encryption** during clean installs when the firmware supports it. If that engaged during the golden build, the volume would be sealed to the build VM's vTPM, every per-role child would present a different vTPM, and each would boot to a BitLocker recovery prompt — a symptom that looks like a boot hang, not an encryption problem.

The design therefore ships **no vTPM at all**. With no TPM present, automatic device encryption cannot engage, so the failure class is designed out rather than suppressed; `PreventDeviceEncryption` is set anyway as cheap belt-and-braces. Secure Boot stays on for role VMs with the `MicrosoftWindows` template, because it is a genuine boot-path property, production guests run with it on, and `vm.ts` already models the concept.

This diverges from `setup-guest.md:37`, which has real users enable a vTPM. The divergence is accepted because nothing in this role's test surface — DHCP leases, resolver behaviour, CA trust in `LocalMachine\Root`, proxy egress — is TPM-dependent. That reasoning does not generalise: ADR-0025 spent real effort closing the Ubuntu NetworkManager-versus-`networkd` divergence precisely because *that* one was not orthogonal to what was being asserted.

### 1.5 The provisioning script

The analogue of Ubuntu's `late-commands`. Run once at first logon, as the built-in `Administrator`:

1. **Install all Windows updates to exhaustion,** using the built-in `Microsoft.Update.Session` COM API rather than `PSWindowsUpdate` from PSGallery, so the build needs no module download. Loop search → download → install → reboot until a pass finds nothing.
2. **Install Git** — `winget install --id Git.Git --exact --silent`.
3. **Clear autologon** and shut down.

Intermediate reboots leave the VM `Running`, so `waitForOff` remains an unambiguous "finished" signal and needs no change.

Git is preinstalled rather than arriving from `01-install-packages.ps1` because pre-scripts run **pre-isolation**, on the Default Switch with full internet — winget has never run through the proxy in production, and `01-install-packages.ps1`'s own `BypassCertificatePinningForMicrosoftStore` toggle is direct evidence that winget and the Store fight a MITM. Having the role winget-install through the proxy would invent a requirement rather than test one, and would fail for reasons that say nothing about susentorno.

This is a deliberate *inclusion* in an image the house pattern otherwise keeps bare — `e2e.test.ts` pointedly asserts the golden image *"deliberately omits"* the toolchain. It is accepted because it is what makes the `git ls-remote` assertion in section 2 possible, and that assertion is the most boundary-relevant thing Git can do.

### 1.6 Stamp and rebuild policy

`goldenStamp.ts` generalises to take a stamp path and an inputs object, so both pipelines share one hasher. The Windows inputs are: the ISO's SHA-256, the answer file, the provisioning script, the `Administrator` password, and a build-algorithm version.

The stamp covers **inputs, never content**. Baking Windows Update into the image makes the result a function of the calendar, so two developers with the same ISO get different images and no rebuild is byte-reproducible. This is a deliberate trade — a patched baseline is worth more than a reproducible one for a guest whose job is to reach the network — and the spec states it rather than implying a reproducibility the pipeline does not have.

- **Missing image** → build automatically. There is no expectation to violate on a first run.
- **Stale stamp** → throw, naming which input changed and how to force a rebuild (`SUSENTORNO_WINDOWS_IMAGE_REBUILD=1`). Rebuilding stays fully automated; it simply is not something that happens to you.

Ubuntu's silent-rebuild behaviour is unchanged. The divergence tracks a real cost difference — 20–30 minutes versus 60–120 — rather than being arbitrary.

### 1.7 Sizes and shape

| Thing | Value |
|---|---|
| Installer VHDX | 8 GB, FAT32, ESP-typed |
| Golden VHDX | Dynamic, 127 GB maximum (matching `setup-guest.md`; realistically ~40 GB consumed) |
| Build VM | 4 GB startup memory, 2 vCPU, automatic checkpoints disabled, attached to **`Default Switch`** |
| Role VM | 4 GB dynamic memory (2–6 GB), 2 vCPU, Secure Boot on, no vTPM, attached to **`susentorno-test-internal`** |

The build VM is on the Default Switch — Hyper-V ICS, with real gateway and DNS — for the same reason the Ubuntu build is: Windows Update and `winget` need general internet, and the build is not the thing under test. The role VM never touches the Default Switch at all, which is what makes it the `fresh` shape rather than the `phases` shape.

Automatic checkpoints are disabled on the build VM for the reason `goldenImage.ts` already documents: they would place writes in transient AVHDX overlays that `Remove-VM` discards along with the finished image.

### 1.8 Screenshot diagnostics

Ubuntu's build is debuggable because `startSerialLog()` captures the whole install, kept deliberately outside the per-run results directory *"[because] a failed build's log has to still be there on the next run."* Windows Setup writes nothing to serial, and PowerShell Direct is unavailable until the guest reaches OOBE — so during the window most likely to fail, there is no channel at all. The failure signature is a VM that never powers off, ninety minutes later.

`vmScreenshot.ts` captures the VM framebuffer through WMI (`Msvm_VirtualSystemManagementService.GetVirtualSystemThumbnailImage`), converting the returned pixel buffer to a BMP. It exposes the same `start(...)`/`stop()` shape as `startSerialLog` and captures every two minutes.

Where the frames land differs by caller, for the same reason the Ubuntu tier splits its own artefacts. **Build** screenshots go to `.image-cache/`, retaining the most recent 10, and deliberately survive into the next run — a failed build's evidence has to still be there when you come back to it, and a per-run directory cannot do that. **Role** screenshots go to `test-results/guest/<timestamp>/windowsFresh/`, alongside every other role's per-run diagnostics, and are discarded with the rest of that run's output.

For Windows Setup this is usually the entire diagnosis: the failure modes are "sitting at a language prompt" (malformed answer file), "sitting at a hardware-requirements refusal" (bypass keys wrong), and a bugcheck, all of which are legible in a picture. The asymmetry justifying the work is that `autounattend.xml` will be developed by iteration, and that loop is unbearable blind.

## 2. The `windowsFresh` role

Named for the shape it tests, not the operating system. Existing roles are `phases`, `e2e`, `fresh`, and `ambientTrust`; follow-on Windows specs will want `windowsPhases` and `windowsE2e`, so claiming the bare OS name now would misname this one later. `GuestRole` gains the member, and `roleVmName`, `roleVhdPath`, `rolePipeName`, and `sweep.ts` pick it up unchanged.

### 2.1 Lifecycle

`beforeAll`:

1. `startProxyStack({ forward: { isolationName: 'test' } })` — the real `run-hosting` on the test Internal switch, same as every other role.
2. Create the SMB share over `envRoot/vm-shared-windows`.
3. Cut a differencing disk off the Windows golden parent; create a Gen 2 VM on `susentorno-test-internal` with Secure Boot on and no vTPM; start it; begin screenshot capture.
4. Poll `Invoke-Command -VMName … { $true }` until the VMBus session answers, with a 20-minute ceiling; exceeding it throws and names the screenshot directory, since that is the OOBE-failed signature.
5. Propagate ambient trust into the guest (section 3.1) — **before** any assertion that performs a TLS handshake.
6. Mount the share, then run `04-configure-network.ps1` from it (section 2.4).

Ordering in steps 5 and 6 matters: the ambient roots must be in place before the `git ls-remote` and passthrough `:443` assertions, and the proxy CA must be in place before the terminated-destination assertion.

The whole of `beforeAll` must fit `vitest.guest.config.ts`'s `hookTimeout` of 1,800,000 ms. The golden image build is not subject to it — that runs in `globalSetup`, outside per-file hooks.

There is **no address discovery and no reachability probe**. The guest's address is something the test asks about, not a precondition for asking anything — which is the whole point of the transport choice below.

`afterAll` collects diagnostics, destroys the guest and its differencing disk, removes the share, and stops the stack, each guarded so one failure cannot hide the others.

### 2.2 Transport: PowerShell Direct

The Ubuntu roles reach their guests over SSH, across the very network under test. That is survivable there because the serial console keeps logging when the network does not. Windows has no serial console to offer, so the same design would make a DHCP failure a black box: a timeout and nothing else.

`Invoke-Command -VMName` runs over the Hyper-V VMBus with no network involvement. The host is already elevated for this tier and the guest-side component is built into Windows 10 and later. Consequences:

- **The circularity breaks.** When the network under test is broken, the harness can still get in and run `Get-NetIPConfiguration`. This is the functional replacement for the serial console.
- **Harness surface disappears.** No OpenSSH Server in the image, no harness keypair, no `known_hosts` seeding or cleanup, no `ssh-agent` prerequisite for this role, no host-key trust dance across a switch change. `harnessKeys.ts`, `knownHosts.ts`, `waitForReachable`, and `filterCandidateAddresses` have no counterparts on this path. Against that it adds one thing: a guest local account with a password, the exact analogue of Ubuntu's baked-in public key.
- **There is no fidelity argument for SSH here.** On Ubuntu, SSH is what production `setup-guest-unix` genuinely uses. On Windows there is no automated production path at all yet, so SSH would be a harness-only choice imitating nothing.

The cost is that `windowsGuestExec.ts` shares nothing with `guestExec.ts`. That is correct rather than unfortunate — a shared abstraction over `bash -ic` and `Invoke-Command -VMName` would be a worse module than two honest ones.

**Elevation.** `04-configure-network.ps1` declares `#Requires -RunAsAdministrator` and writes to `LocalMachine\Root` and machine-scope environment variables, so the session must be genuinely elevated. Authenticating as the **built-in `Administrator`** account sidesteps UAC admin-approval-mode filtering, and `LocalAccountTokenFilterPolicy` is set in the answer file as a second guard.

**Credential.** `windowsCredential.ts` generates the password once and persists it in `.image-cache/` — gitignored, repo-local, the same treatment `harnessKeys.ts` gives the harness private key. The password is a stamp input, so losing the file forces a rebuild rather than leaving an unreachable image.

### 2.3 The share

`testShare.ts` currently hardcodes `SHARE_NAME = 'susentorno-test-vm-shared-linux'` against `envRoot/vm-shared-linux`. It gets parameterised by share folder, yielding `susentorno-test-vm-shared-windows` for this role, and `sweep.ts` learns to remove both share names. The local account (`SHARE_ACCOUNT = 'susentorno-test'`, within `New-LocalUser`'s 20-character limit) is shared between them.

Inside the guest the share is reached with `cmdkey /add:<internal-host-ip>` plus a direct UNC path — the flow `setup-guest.md:188-194` documents, including its per-address wrinkle. No package install is required, unlike Ubuntu's `cifs-utils`.

### 2.4 Running the shipped script

The role invokes `powershell -ExecutionPolicy Bypass -File \\<internal-host-ip>\<share>\pre-scripts\04-configure-network.ps1 -HostIp <internal-host-ip>` over PowerShell Direct.

`-ExecutionPolicy` is passed per-invocation rather than mutating machine policy: `setup-guest.md:217` has manual users run `Set-ExecutionPolicy Bypass`, and a `.ps1` fetched over UNC lands in the Internet zone, but the test should leave behind no state the manual flow would not.

The `04-` prefix is the **post-trim** name. Section 4 renumbers it from `05-`, so the role and the trim land in the same changeset and the role cannot be implemented against the current tree without it.

The script is invoked **by path**, not through `listScripts`/`runPreScripts`. `listScripts.ts`'s regex is `/^(\d{2})-(.+)\.sh$/` and teaching the production provisioning modules about PowerShell is the follow-on spec's job. Invoking by path keeps this design's `src/` changes at zero.

### 2.5 Assertions

Grouped by what a failure would mean.

**Configuration arrived entirely from the host.**

| Assertion | Mechanism |
|---|---|
| The address is DHCP-derived and in the internal subnet | `Get-NetIPAddress` — `PrefixOrigin`/`SuffixOrigin` are `Dhcp` |
| The default route's next hop is the internal host IP | `Get-NetRoute -DestinationPrefix 0.0.0.0/0` |
| The resolver is exactly the host | `Get-DnsClientServerAddress` |
| Names resolve to the host, so the real DNS responder answered | `Resolve-DnsName example.com` |
| The deleted in-guest layer stays deleted | No `SusentornoDnsResponder` scheduled task |

**The share is real.** `cert.pem` is readable over SMB at the internal host IP.

**The shipped script did its job.** After running `04-configure-network.ps1`: the CA is present in `LocalMachine\Root`; machine-scope `NODE_EXTRA_CA_CERTS` is set and its file exists; `git config --global http.sslBackend` reads `schannel`.

**The boundary behaves.**

| Assertion | Destination | What it proves |
|---|---|---|
| Returns under 400 | `http://archive.ubuntu.com/` | Allow-listed `:80` passthrough |
| Returns under 400 | `https://pypi.org/` | Allow-listed `:443` passthrough, validated against public roots |
| Returns 200 | `https://api.anthropic.com/` | **TLS-terminated** destination — the guest accepts susentorno's leaf, so the CA import actually worked |
| Connection dropped, non-zero `curl` exit | `https://blocked.example.com/` | Default-deny on `:443` |
| Returns 403 | `http://blocked.example.com/` | Default-deny on `:80` |
| Succeeds | `git ls-remote https://github.com/git/git` | Git doing real TLS through the proxy on schannel's trust path |

`api.anthropic.com` resolves to the stack's local mock upstream, because `startProxyStack` passes `--upstream-override api.anthropic.com=host.docker.internal:<port>`; the assertion is about the guest accepting susentorno's leaf, not about reaching Anthropic. `github.com` and `pypi.org` are genuinely external.

The `api.anthropic.com` row is load-bearing and easy to omit by accident. Without a TLS-terminated destination, nothing exercises the proxy CA and the `LocalMachine\Root` check degrades into reading configuration back — the same weak-assertion trap that makes the bare `sslBackend` readback insufficient on its own.

## 3. Trust surfaces

Three distinct surfaces are in play, and conflating them produced a wrong conclusion during design that is worth recording so it is not re-derived.

| Surface | Needed for | Windows status |
|---|---|---|
| Proxy CA | TLS-**terminated** auth-list destinations, where the guest sees susentorno's leaf | Handled by `04-configure-network.ps1` — `LocalMachine\Root` and `NODE_EXTRA_CA_CERTS` |
| Public root program | **Passthrough** allow-list destinations, where TLS stays end-to-end with the real service | Free — Windows ships the Microsoft root program; Node ships Mozilla's |
| Host ambient extra roots | A host that is itself behind a terminating proxy | **Nothing does this for Windows.** `propagateAmbientTrust` is Ubuntu-only and wired solely into `setup-guest-unix` |

### 3.1 Why the harness propagates ambient trust

The third surface is not hypothetical. susentorno is developed from inside a susentorno Windows guest, so the tier must run there, and `current-auth-list.txt` lists `github.com:443` under `#pragma github authenticated`. On such a host:

- `http://archive.ubuntu.com/` — plain HTTP. Fine.
- `https://pypi.org/` — `current-allow-list.txt:191` makes it passthrough in the outer environment too, so it stays end-to-end to the real pypi.org and validates against public roots. Fine.
- `https://api.anthropic.com/` — the inner stack's `--upstream-override` routes it to the local mock upstream; it never leaves the machine. Fine.
- `git ls-remote https://github.com/…` — the inner proxy passes it through, and the **outer** proxy terminates it with the outer susentorno CA. A guest holding only public roots plus the inner CA fails the handshake.

The existing Ubuntu roles avoid this only by accident: `phases` and `fresh` make no TLS assertion against an outer-terminated host, and `e2e` survives because it runs `setup-guest-unix`, which calls `propagateAmbientTrust`. The machinery exists; it is wired into exactly one role.

So `windowsAmbientTrust.ts` installs the host's ambient roots into the guest's `LocalMachine\Root` over PowerShell Direct before the egress assertions, driven by the **production** `enumerateHostTrustedRoots()` from `src/guestSetup/hostTrustStore.ts` — which reads the host's Windows store and is already agnostic about the guest. Only the guest-side installer is harness code, because that genuinely does not exist for Windows.

On this machine the `git ls-remote` assertion then exercises something worth having: the inner proxy validating an outer-terminated upstream against ambient trust, which is [ADR-0026](../../adr/0026-validate-upstream-certificates-against-ambient-trust.md)'s subject.

A Windows arm of `propagateAmbientTrust` in `src/` is explicitly rejected. It would ship a product feature with no caller, since the command that would invoke it does not exist until the scope-C spec.

### 3.2 Substitutions

ADR-0025 keeps a countable list; Windows has two.

1. **Git is preinstalled** in the golden image rather than arriving from `01-install-packages.ps1` (section 1.5).
2. **The guest-side ambient-root installer is harness code** rather than production code (section 3.1).

`gh` is absent rather than stubbed, because this role never runs post-scripts.

## 4. The Windows template trim

ADR-0024's test — *does removing it break a product behaviour?* — applied to `templates/vm-shared-windows/`. This follows the Linux precedent in `docs/honist-v/plans/2026-08-15-hyperv-guest-tier-preparation.md` Tasks 8–9, including its instinct to separate the content trim from the file deletion so the renumbering fallout is reviewable on its own.

| File | Change |
|---|---|
| `01-install-packages.ps1` | Drop `wsl --update`. Keep the winget bootstrap and `winget upgrade --all` — ADR-0024 kept `apt upgrade -y` for the same reason. Package list reduced to `jqlang.jq`, `Git.Git`, `GitHub.cli`. Removed: `Microsoft.PowerShell`, `Microsoft.DotNet.SDK.10`, `Microsoft.VisualStudioCode`, `Microsoft.WindowsTerminal`, `WinMerge.WinMerge`, `Docker.DockerDesktop`, `Microsoft.VCRedist.2015+.x64`, `Python.Python.3.14` |
| `02-install-pnpm.ps1` | Drop `pip install PyYAML`; keep the pnpm install |
| `03-install-tools.ps1` | Drop `dotnet-outdated-tool` and `csharpier` — ADR-0024 removed "the .NET SDK **and its global tools**". Keep the node runtime, `@earendil-works/pi-coding-agent`, `Anthropic.ClaudeCode`, `@openai/codex`. Fix the closing message, which currently claims it installed VS Code |
| `04-configure-tools.ps1` | **Deleted** — every remaining line is preference: `powercfg` timeouts (ADR-0024 removed the GNOME screensaver equivalent), VS Code extensions, `codebase-memory-mcp`, context7 MCP wiring, and the `ssh-agent` service enablement |
| `nn-configure-network.ps1` | Stop printing its own number — it says `05-configure-network` in five `Write-Host` strings. Weaves out as `04-configure-network.ps1` |
| `verify-config.ps1` | Decouple the `(05)`/`(06)` section labels from script numbers |
| `post-scripts/*` | Unchanged — required end to end |

The three kept packages are each called by a shipped script: `jq` by the home settings transforms, `Git.Git` by both `04-configure-network.ps1` and `01-auth-config.ps1`, `GitHub.cli` by `01-auth-config.ps1`. `Python.Python.3.14` and `pip install PyYAML` go because Ubuntu never installed them — it relies on the distribution's `python3` — and no shipped script calls Python.

Windows drops from four built-in pre-scripts to three, so both platforms now weave `nn-configure-network` out as `04-`. This **closes** the divergence ADR-0024 recorded as a lasting consequence (*"Windows keeps four built-ins and stays `05-`, so the two platforms' woven numbering legitimately diverges"*).

### 4.1 Fallout

- `tests/cli/updateShares.test.ts` asserts on the woven output tree and names `04-configure-tools.ps1`. The Linux precedent used exactly this as the failing test that drives the deletion.
- `setup-guest.md:222` instructs `.\05-configure-network.ps1 -HostIp …`, and `:229` names both platforms' scripts by number. Both become `04-`.
- `development.md:11-14` justifies its `ssh-agent` prerequisite by the guest tier's needs. With the template no longer enabling the service, developing susentorno inside a Windows guest requires enabling it manually. This is a documentation note, not a new requirement — the prerequisite was always the host's, and the `windowsFresh` role does not need it at all.
- `testing.md:52` gains `SUSENTORNO_WINDOWS_ISO` and this role's timings; `:77` gains the skip behaviour.

Checked and deliberately **not** touched: `templates/home-jq-transforms/manifest.yaml` is already clean, since ADR-0024 removed the VS Code entry as *"the one place this rule's first application reaches a Windows guest"*; and the `tests/unit/guestSetup/listScripts.test.ts` / `runPreScripts.test.ts` fixtures naming `05-configure-network.sh` are synthetic temp-directory fixtures, which the Linux plan explicitly warned against "fixing".

## 5. Modules and file layout

### 5.1 New

| File | Responsibility |
|---|---|
| `tests/guest/windowsAutounattend.ts` | Pure. `buildAutounattendXml()`, `buildProvisioningScript()` — the counterpart of `autoinstall.ts` |
| `tests/guest/hyperv/windowsGoldenImage.ts` | `ensureWindowsGoldenImage()` — installer media, build VM, wait for off, stamp |
| `tests/guest/hyperv/windowsCredential.ts` | Generate and persist the `Administrator` password in `.image-cache/` |
| `tests/guest/hyperv/vmScreenshot.ts` | WMI framebuffer capture and BMP assembly; `start`/`stop` mirroring `serialLog.ts` |
| `tests/guest/windowsGuestExec.ts` | PowerShell Direct `run`/`capture`/`copyFile` |
| `tests/guest/hyperv/windowsTestGuest.ts` | Role VM lifecycle off the differencing disk |
| `tests/guest/windowsAmbientTrust.ts` | Guest-side installer for roots from production `enumerateHostTrustedRoots()` |
| `tests/guest/windowsDiagnostics.ts` | Failure dumps into `test-results/guest/<timestamp>/windowsFresh/` |
| `tests/guest/windowsFresh.test.ts` | The role |

### 5.2 Changed

| File | Change |
|---|---|
| `hyperv/imageCache.ts` | `GuestRole` gains `windowsFresh`; Windows golden VHDX, stamp, credential, and screenshot paths; ISO path resolved from the environment |
| `hyperv/goldenStamp.ts` | Generalise to `(stampPath, inputs)` so both pipelines share one hasher |
| `hyperv/sweep.ts` | Remove both share names |
| `hyperv/vm.ts` | Add a `MicrosoftWindows`-template Secure Boot builder alongside the existing UEFI-CA one |
| `testShare.ts` | Parameterise by share folder |
| `globalSetup.ts` | Build the Windows golden image when the ISO variable is set; skip silently otherwise |

Each new module has one job and a pure core that can be unit-tested without Hyper-V. The PowerShell-string-inside-PowerShell-string quoting that PowerShell Direct requires is isolated in `windowsGuestExec.ts` rather than spread across call sites.

## 6. Failure handling and diagnostics

Every failure names its own remedy.

| Condition | Behaviour |
|---|---|
| `SUSENTORNO_WINDOWS_ISO` unset | Role self-skips with a prescriptive line naming the variable and the acquisition doc |
| ISO path unreadable | Fail fast, naming both the path and the variable |
| Stamp stale | Throw, naming which input changed and the rebuild flag |
| Build times out | Throw, naming the screenshot directory and the target VHDX path so `Panther\setupact.log` can be salvaged offline |
| PowerShell Direct never answers | Same — this is the OOBE-failed signature |
| Assertion fails | `windowsDiagnostics` dumps IP configuration, routes, resolvers, `LocalMachine\Root` contents, and relevant event logs, each collected independently so one broken command cannot hide the others |

Artefact locations are split as section 1.8 describes: build screenshots in `.image-cache/`, surviving into the next run; role screenshots and assertion diagnostics under `test-results/guest/<timestamp>/windowsFresh/`, matching every other role.

Sweep is unchanged in character: name-driven and origin-blind, at startup and teardown.

## 7. Unit coverage

Following the precedent that the harness's pure functions get unit tests:

- `buildAutounattendXml()` — bypass keys present, built-in `Administrator` enabled, `LocalAccountTokenFilterPolicy` set, OOBE skipped, Update/Store/telemetry/consumer-experiences disabled, `PreventDeviceEncryption` set, autologon count sufficient.
- `buildProvisioningScript()` — update loop, Git install, autologon cleared, shutdown last.
- Windows stamp hashing — each input's change produces a different stamp; identical inputs produce an identical one.
- PowerShell Direct command builders — nested quoting round-trips values containing quotes, spaces, and backticks.
- BMP assembly from a synthetic pixel buffer.
- Share-name derivation for both share folders.

## 8. Domain record

**New ADR — "The Windows guest layer is tested against a real Hyper-V guest over PowerShell Direct."** Carries the claim, the env-var ISO with its explicit surrender of reproducibility, the PowerShell Direct rationale (out-of-band diagnosis, no production SSH path to mirror), the no-vTPM decision and the BitLocker reasoning behind it, fail-on-stale, and the two named substitutions.

**ADR-0024 amended.** Its consequence recording `templates/vm-shared-windows/` as *"a known, deliberate exception on the day this is written"* is discharged; the amendment links the new ADR and notes that the woven-numbering divergence it predicted has closed rather than persisted.

**`CONTEXT.md` additions.**

- **Ambient trust** — the host's non-public trusted roots, propagated into a guest so it can validate the same terminated upstreams the host can. `CONTEXT.md` currently defines only the host-side **Upstream trust bundle**, and section 3 turned entirely on the guest-side concept having no name. *Avoid:* extra CAs, corporate roots.
- **Guest role** — one disposable guest identity within the guest test tier, from which its VM name, differencing disk, serial or screenshot channel, and diagnostics directory all derive. Follows the precedent that **Isolation name** already reaches into test vocabulary. *Avoid:* test guest, VM name.

## 9. Risks and contingencies

| Risk | Contingency |
|---|---|
| The COM update loop hangs, and it is the least predictable part of the build | Primary consumer of the screenshot diagnostics; the timeout message names both the screenshots and the VHDX for offline log salvage |
| `winget` is temperamental under an autologon context | Fall back to downloading the Git for Windows silent installer directly |
| PowerShell Direct lands in a filtered, non-elevated token | Built-in `Administrator` plus `LocalAccountTokenFilterPolicy`; both are in the answer file from the start rather than added after the symptom |
| Windows Setup does not find `autounattend.xml` at the installer VHDX root | Fall back to a separate FAT32 volume, reusing `makeSeed()`'s existing shape |
| **Nested virtualisation cost** — susentorno is developed inside a guest, so this build runs under nested Hyper-V | The 60–120 minute estimate may be substantially optimistic; the build timeout is set generously and the failure message distinguishes "still progressing" from "stuck" via the screenshots |
| **Disk** — `.image-cache/` grows by roughly 50–60 GB | Documented as a guest-tier prerequisite alongside the ISO |

## Found and deferred

Two divergences surfaced while comparing the Linux and Windows templates. Both are real, both are orthogonal to this design's claim, and both deserve their own changeset rather than riding along. A GitHub issue for each.

1. **Placeholder credentials are copied, not symlinked.** `01-auth-config.sh` symlinks them *"so it tracks the shared placeholder (regenerated on re-init)"*; `01-auth-config.ps1` copies, so a re-init leaves a Windows guest holding a stale placeholder.
2. **`NODE_EXTRA_CA_CERTS` cannot see ambient roots on Windows.** Commit `40e5807` pointed the Linux variable at the full system bundle so Node picks up ambient roots. Windows points it at a lone `C:\ProgramData\susentorno\proxy-ca.pem`. Node still trusts the public program — the variable *extends* Node's bundled roots rather than replacing them — so the gap is narrower than the Linux bug was, but a Windows guest's Node cannot see ambient roots at all. Windows has no concatenated bundle to point at, so this is a design problem rather than a one-line edit.

## Considered options

- **Scope the first Windows spec at full parity** — a `setup-guest-windows` command plus `phases`/`e2e` equivalents. Rejected: the image pipeline is the genuinely unknown piece, and landing it behind a single narrow claim proves it works before a product feature depends on it.
- **The pre-built dev VHDX from `aka.ms/windev_VM_hyperv`.** Rejected: no published checksum, a hard expiry date refreshed quarterly, ~20–30 GB, and preloaded with Visual Studio — the same cloud-image-versus-installer fidelity gap ADR-0025 rejected for Ubuntu. First-boot automation would still be required, so the work does not go away.
- **A hand-built golden VHDX.** Rejected: it discards the one property ADR-0025's stamp depends on — that the image is defined by the repo — and keeps only unattended acquisition, which is the property that matters least.
- **OpenSSH Server in the guest.** Rejected: it would reach the guest across the network under test, with no serial console to fall back on, and it would imitate a production transport that does not exist on Windows.
- **A vTPM matching `setup-guest.md`.** Rejected: automatic device encryption would seal the golden volume to the build VM's vTPM and brick every differencing child, and nothing under test is TPM-dependent.
- **Running the trimmed `01-install-packages.ps1` during the golden build.** Rejected: it couples the cached image to shipped template content, so any template edit triggers a multi-hour rebuild, and it inverts the boundary that makes the tier legible — golden image is the bare OS, provisioning is what the test does.
- **Having the role winget-install through the proxy.** Rejected: pre-scripts run pre-isolation in production, so this would invent a requirement rather than test one.
- **Stubbing `git`**, mirroring ADR-0025's `gh`. Rejected: it buys tidiness by deleting the assertion with the most to say about the network boundary.
- **A separate `guest-windows` tier.** Rejected by `testing.md`'s own placement rule — the observable surface is still *"behavior driven or observed inside a disposable guest"* — and it would duplicate `globalSetup.ts` while still being unable to run concurrently.
- **Moving `github.com` into the inner auth-list fixture** so the inner proxy terminates it and no ambient propagation is needed. Rejected: it mutates a shared fixture other tests read, and swaps a passthrough assertion for a credential-injection one, which is `phases`' claim rather than this role's.
- **A Windows arm of `propagateAmbientTrust` in `src/`.** Rejected: an unreachable feature is worse than an absent one; it has no caller until the scope-C spec.
