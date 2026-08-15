# Brainstorming brief: the Hyper-V guest test tier ("spec 2")

**Purpose of this document.** Spec 2 was scoped, and several of its core decisions
were made, during the brainstorming session that produced
[the spec-1 design](../specs/2026-08-15-hyperv-guest-tier-preparation-design.md).
That session ended before spec 2 was designed. This brief carries the decisions,
the open questions, and the verified facts across the session boundary so the
next brainstorm starts where that one stopped instead of re-deriving it.

This is **not** a spec. It is input to `/honist-v:brainstorming`.

## Dependency and sequencing

Spec 2 consumes `run-hosting --isolation-name` and `setup-guest-unix`'s answer
flags, both of which spec 1 adds. Spec 2 can be **brainstormed** at any time —
designs don't need the code — but its plan and implementation must follow spec 1
landing. Spec 1's own plan had not been written when this brief was created.

## The goal, in one sentence

Replace the QEMU-in-WSL2 `guest` test tier with real Hyper-V VMs, so the tier
exercises the production Windows network path instead of substituting for it.

The concrete measure of success: **the suite's `run-hosting` invocation drops
`--no-forward`**. That single flag (`tests/proxyStack.ts:157`) currently disables
the gateway forwarder, the DNS responder, and the DHCP server together, and WSL's
`dnsmasq` and `socat` stand in for all three. Dropping it is what turns
[ADR-0014](../../adr/0014-host-side-dns-and-dhcp.md)'s "covered only by manual
Hyper-V checkpoints" and [ADR-0011](../../adr/0011-loopback-publish-with-node-forwarder.md)'s
forwarder into real automated coverage.

## Decisions already made — do not re-open without new information

Each of these was put to the user as an explicit choice with alternatives, and
answered. The reasoning is recorded so a later disagreement can be an informed
one.

1. **Fidelity, not a port.** The point is to delete the harness's three
   substitutions, not to swap QEMU for Hyper-V while keeping them. The
   alternative ("simplification": drop the WSL dependency, keep the
   substitutes) was rejected because accepting a real-Hyper-V, elevation-
   requiring, host-state-touching tier without buying the fidelity means paying
   [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md)'s
   price for none of its return.

2. **Golden VHDX built by unattended Ubuntu Server autoinstall**, with per-test
   guests as **differencing VHDXs** (`New-VHD -Differencing -ParentPath`) — the
   analogue of today's qcow2 overlay. Rejected alternatives: a manually-built
   golden VM plus checkpoints (cheap, but makes the suite un-bootstrappable from
   source, which is a real cost for a tier in the default pipeline); and
   converting the cloud image to VHDX (needs `qemu-img` on Windows, a new
   non-Hyper-V dependency, and keeps the cloud-image-vs-installer fidelity gap
   that autoinstall closes).

3. **Module-driven phase tests plus one end-to-end test.** The fine-grained
   tests drive `mountShare`, `runPreScripts`, `isolateVmToSwitch`, and
   `runPostScripts` directly, because they need to observe state *between*
   phases; a single end-to-end test invokes the real `setup-guest-unix` with
   spec 1's flags. Driving everything through the real command was rejected for
   leaving no seam for intermediate assertions; driving nothing through it was
   rejected for leaving the command's own wiring untested.

4. **The suite provisions its own SMB share.** `globalSetup` creates a
   `susentorno-test-share` local user with a per-run random password and a
   read-only share over the throwaway environment directory, sweeping orphans
   from a crashed previous run first — the "safe to rerun, sweeps residue
   regardless of origin" pattern `delete-host-network` already establishes. A
   documented one-time manual prerequisite was rejected for breaking the
   bootstrappable-from-clean property. This is high-value coverage:
   `mountShare`'s `cifs-utils` install, `/etc/susentorno-share.cred`, the
   `x-systemd.automount` fstab entry, and especially the stale-autofs unwind at
   `mountShare.ts:76-90` are all completely untested today, and the 9p `virtfs`
   mount has nothing in common with any of it.

5. **The isolation name is the single sandboxing key.** One value (`test`)
   derives the switch, the firewall rule prefix, the share account, the share
   names, the VM names, and the golden-image cache directory — so everything the
   suite touches on the host is discoverable and sweepable from one string.
   Spec 1 adds the term to `CONTEXT.md` scoped to the host network only; if spec
   2 extends it to VM and share-account names, it amends that definition.

## Open questions the brainstorm must answer

These were identified but never put to the user.

1. **Boot diagnostics.** Today `guest.sh` captures a QEMU serial log
   (`-serial file:`) plus the guest journal and network dumps over SSH; the
   serial log is the only thing that helps when a guest never boots far enough
   to accept SSH. Hyper-V Gen2 has no equivalent by default. Candidates:
   `Set-VMComPort` to a named pipe with a Node reader; SSH-only diagnostics
   (useless for boot failures); a console thumbnail via WMI
   (`Msvm_VirtualSystemManagementService.GetVirtualSystemThumbnailImage`).

2. **Golden image mechanics.** Generation 1 vs 2; if Gen2, Secure Boot needs the
   "Microsoft UEFI Certificate Authority" template or must be disabled
   (`setup-guest.md` documents this for real guests). Seeding autoinstall
   without ISO-authoring tooling — a small FAT32 VHDX labelled `cidata` works,
   since NoCloud matches on volume label rather than ISO9660. Cache location,
   the stamp/rebuild mechanism (today: `build-image.sh` hashes the seed inputs),
   and whether to add a maximum image age.

3. **VM and disk lifecycle.** Naming, differencing-disk layout, how many
   concurrent guests (today: `g1` rebooted through the phase transition, `g2`
   booted fresh straight into the isolated phase), startup sweep of orphans from
   a killed run, teardown.

4. **Disposition of the ~20 existing assertions.** Many assert *harness*
   topology and change meaning under real `run-hosting` — `proto dhcp`, the
   bridge IP as resolver, absence of DNAT, absence of an in-guest `dnsmasq`.
   This needs a test-by-test decision, not a bulk port.

5. **Pipeline placement.** The tier will require an elevated shell and Hyper-V.
   Does it stay in the default `pnpm test`? What runtime is acceptable? Removing
   nested virtualization should make it faster, but the golden-image build and
   the real `apt`/installer traffic are the dominant costs.

6. **Coexistence with a developer's live environment.** `checkNoRunningProxy`
   already forbids a running `run-hosting` during the suite. Two `run-hosting`
   instances bound to different adapters is a separate question — permitted, or
   still guarded?

7. **Retirement of the WSL2 harness.** Same changeset or a follow-up? This is
   ~1058 lines across `tests/guest/harness/*.sh`, `wsl.ts`, and `globalSetup.ts`,
   plus rewrites of `development.md`'s prerequisites (mirrored networking,
   `ignoredPorts=67`, `setup-wsl.sh` all become unnecessary) and `testing.md`.
   [ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) is superseded or
   substantially amended here — spec 1 deliberately left it untouched.

8. **The missing manual checklist.** `setup-guest-unix-isolation-checklist.md`
   is referenced by `testing.md:25` and by ADR-0023, but does not exist — added
   in `da4b7f6`, deleted in `2fd9770`. Spec 2 should decide whether it is
   automated away, restored, or whether the dangling references are simply
   removed.

9. **Windows guests in the test mix.** Raised by the user as a possibility when
   deferring the `vm-shared-windows/` template trim. Explicitly out of scope, or
   planned for later?

## Verified facts — established with evidence, don't re-derive

- **Ubuntu publishes no VHD/VHDX for 26.04.** `cloud-images.ubuntu.com/releases/26.04/release/`
  offers `.img` (qcow2), `.ova`, `.vmdk`, `.squashfs` only. `Convert-VHD` handles
  VHD↔VHDX only. This is what rules out a direct port of `build-image.sh`.
- **`--no-forward` gates all three network services**, not just the forwarder
  (`src/commands/runHosting.ts:194` and `:222`).
- **`startProxyStack` already spawns the real `run-hosting`** from `dist/cli.js`
  (`tests/proxyStack.ts:155-172`), captures its stdout, and supports allowlist
  edits and credential rotation. The guest suite is not mocking the proxy — it
  is running production with its Windows network layer switched off.
- **SSH connection multiplexing is unavailable on Windows.** Win32-OpenSSH issue
  #405 (ControlMaster/ControlPath/ControlPersist) has been open since 2016,
  labelled "0 - Backlog / Issue-Enhancement". Don't design around it.
- **A `setup-guest-unix` run makes roughly 20-23 ssh/scp invocations.** Each
  prompts without key auth, and `-t` gives each a fresh pty so sudo's per-tty
  timestamp re-prompts too. The test guest therefore needs key auth **and**
  `NOPASSWD` sudo baked in — today's QEMU seed already does this
  (`tests/guest/harness/seed/user-data`).
- **`apt-daily`/`unattended-upgrades` hold the dpkg lock shortly after boot.**
  Today's harness never trips this because its guest tests never run `01`-`03`.
  An end-to-end test running real `apt install` on a freshly booted guest sits
  squarely in that window; the golden image should mask those timers the way it
  already masks `systemd-networkd`.

## What already exists to build on

Production Hyper-V control, in `src/guestSetup/` — the control plane is largely
written; guest *creation and disposal* is the genuinely missing piece:

| Module | What it gives spec 2 |
| --- | --- |
| `hyperVQueries.ts` | `Get-VM`/`Get-VMNetworkAdapter`/`Get-VMSwitch` builders and exact-match parsers; `getVmIpAddresses` |
| `hyperVOperations.ts` | `Stop-VM`, `Connect-VMNetworkAdapter`, `Start-VM`, and `planVmReconciliation` |
| `vmReconcile.ts` | `reconcileVmToSwitch` / `isolateVmToSwitch` — the real phase transition |
| `kvpDaemon.ts` | guest IP discovery prerequisite (`linux-cloud-tools-virtual`) |
| `mountShare.ts` | SMB mount, credentials file, fstab, stale-mount unwind |
| `remoteExec.ts` | the `RemoteExec` seam and `createSshRemoteExec` |
| `preflightChecks.ts`, `runHostingReadiness.ts`, `reachabilityWait.ts`, `tcpConnect.ts`, `elevationCheck.ts`, `powerShellExec.ts` | supporting checks |

Tier precedent: `tests/host-network/` (`globalSetup.ts`, `checkElevated.ts`)
shows the shape of a real-Hyper-V, elevation-gated tier, and ADR-0023 argues why
such a tier is safe when it can be sandboxed by isolation name.

Current harness to be replaced: `tests/guest/globalSetup.ts`, `tests/guest/wsl.ts`,
`tests/guest/guest.test.ts` (~475 lines, ~20 tests), and
`tests/guest/harness/*.sh` (~430 lines of bash plus the cloud-init seed).

## Suggested opening move for the brainstorm

The decisions above cover *what* the tier does. The unanswered questions are
mostly about *lifecycle and failure* — image build, VM disposal, diagnostics,
residue, and which existing assertions still mean anything. Question 4 (the
test-by-test disposition of the current ~20 assertions) is the one most likely to
reshape everything else, because it determines what the harness actually has to
be able to do; consider starting there rather than with the image build, which is
the more obvious but more mechanical problem.
