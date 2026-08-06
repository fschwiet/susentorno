# Automate Ubuntu guest isolation and post-scripts

## Purpose

`susentorno setup-guest-unix` (see [2026-08-06-automate-ubuntu-guest-setup-design.md](2026-08-06-automate-ubuntu-guest-setup-design.md)) automates mounting the SMB share and running `pre-scripts/` on an Ubuntu guest, but stops before network isolation — that design's "Out of scope" section explicitly flagged isolation, the post-isolation address change, and `post-scripts/` as needing their own design, since the DHCP-wait uncertainty around isolation deserves deliberate treatment.

The gap this closes: after a guest is isolated (its adapter reassigned from the Default Switch to the Internal switch), its `/etc/fstab` entry still points at the old, now-unreachable Default-Switch host IP, so the SMB mount silently breaks. Nothing today updates it, and nothing automates isolation or `post-scripts/` either — a user still has to hand-drive `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM`, fix the mount, and run two more scripts by hand, exactly the copy-paste-heavy, error-prone pattern `setup-guest-unix` was built to eliminate for the phase before it.

This design extends `setup-guest-unix` itself (rather than adding a second command) to cover the entire remaining Ubuntu flow: isolation, the post-isolation mount fix, and `post-scripts/`. After this change, `setup-guest.md`'s Ubuntu path is "install `openssh-server`, then run `susentorno setup-guest-unix`" — nothing manual left except VM creation (§1) and the one-time host firewall setup.

## Why the mount isn't just pointed at the isolated IP from the start

It was tested and confirmed that a guest still attached to the Default Switch (NAT/setup phase) can, on at least one host, successfully reach the Internal-switch host IP directly — which would seem to make the whole isolation-phase mount problem moot by mounting there from the very first step. This isn't adopted as the design, for a specific, previously-documented reason:

This project has already investigated exactly this class of behavior (a now-removed `docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md`, still visible in git history at commit `41caed6`). A guest confined to one adapter of a multi-homed Windows host reaching the host's *other* adapter IP, on an allowed port, depends entirely on the host's networking model — specifically Windows' "weak host receive" setting and inter-interface forwarding — neither of which this project sets or asserts. That investigation found the pivot **not reachable** on the host it measured (strong-host, no forwarding, both Windows defaults at the time); a guest reaching the Internal-switch host IP from the Default Switch today indicates that host-model state differs now, for reasons not further diagnosed here. `host-allow-vm-inbound.ps1` already scopes its SMB firewall rule with `-LocalAddress` specifically to narrow this class of exposure, citing that same investigation — building new automation that *depends on* cross-adapter reachability working would run counter to that existing hardening effort.

The mount therefore continues to use the Default-Switch host IP during the pre-isolation phase (unchanged from the existing `mountShare` design) and is explicitly re-pointed at the Internal-switch host IP once isolation has actually happened — a guaranteed-reachable address in both phases, with no dependency on undocumented host networking defaults.

## Scope

`setup-guest-unix` becomes the single command covering the entire Ubuntu path from "SSH is reachable" through "the guest is fully set up," replacing today's "run `setup-guest-unix`, then hand-drive isolation, the mount fix, and `post-scripts/`" split. Windows-guest automation remains out of scope, unchanged from the original design.

## New prerequisite: elevation

`Get-VMNetworkAdapter`, `Stop-VM`, `Connect-VMNetworkAdapter`, and `Start-VM` all require an elevated process token — confirmed directly: `Get-VMNetworkAdapter` against a real VM from a non-elevated shell fails with "You do not have the required permission to complete this task," while `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)` cleanly reports `False`/`True` with no special permission of its own. A Node CLI has no good way to silently self-elevate (shelling out to `Start-Process -Verb RunAs` would trigger an interactive UAC dialog and hand off to a disconnected window, breaking the inherited-stdio design every SSH/PowerShell invocation in this command relies on), so `setup-guest-unix` now requires being launched from an already-elevated terminal — the same requirement `setup-machine.md` already documents for `host-allow-vm-inbound.ps1`.

The command checks this first, before anything else (including prompting): run the `IsInRole` check via the same `execa`-to-`powershell.exe` pattern used throughout, and exit immediately with "re-run this from an Administrator PowerShell/terminal" if it's not elevated.

## New input: VM name

None of today's prompts (guest address, username, share/account name, password) let the command identify the guest as a **Hyper-V VM** — `Stop-VM`/`Connect-VMNetworkAdapter`/`Start-VM`/`Get-VMNetworkAdapter` all key off the VM's Hyper-V name, which has no necessary relationship to the guest OS's own hostname. This becomes a new required prompt, asked alongside the existing ones. Consistent with the original design's choice not to persist guest address/username across runs, the VM name is prompted fresh every run too — no config file to introduce or go stale.

## Idempotent top-level flow

Every invocation runs the same fixed sequence — no phase-detection/resume logic, matching (and now extending across the whole command) the philosophy `runPreScripts` already established: a failed run is safe to retry from the top, because every built-in step is idempotent.

0. **Pre-flight checks**, before touching the VM at all: confirm the process is elevated (above); confirm `run-hosting`'s DHCP (UDP 67) and DNS (UDP 53) ports are actually bound on the Internal-switch host IP (`Get-NetUDPEndpoint -LocalAddress <ip> -LocalPort <port>` — confirmed to need no special permission and to return nothing when unbound). Fail fast with a clear message on either check if it doesn't hold.
1. Query the VM's current adapter switch (`Get-VMNetworkAdapter`). If it isn't already on `Default Switch`, reassign it there — graceful `Stop-VM` (see below) → `Connect-VMNetworkAdapter -SwitchName 'Default Switch'` → `Start-VM` — then wait for SSH reachability (below).
2. Resolve the Default-Switch host IP; create-or-update the SMB mount to point at it (existing `mountShare`, unchanged).
3. Run every `pre-scripts/` script in order (existing `runPreScripts`, unchanged, including the `configure-network` exact-remainder argument special case).
4. Re-check `run-hosting`'s DHCP/DNS ports (same check as step 0) — guards against `run-hosting` having been stopped sometime during the potentially multi-minute `pre-scripts/` run. Fail fast if not.
5. Isolate: graceful `Stop-VM` → `Connect-VMNetworkAdapter -SwitchName 'susentorno-internal'` → `Start-VM`, then wait for SSH reachability.
6. Resolve the Internal-switch host IP; create-or-update the SMB mount to point at it (same `mountShare`, called again with a different IP).
7. Run every `post-scripts/` script in order (new `runPostScripts`, below).

A fresh guest (never isolated) effectively skips the reassignment in step 1, since `Get-VMNetworkAdapter` already reports `Default Switch`. A guest that's already been fully set up runs all 8 steps again unconditionally on a rerun — including a round-trip through Default Switch and back — trading a slower rerun for exactly one code path to reason about and test.

## Isolation mechanics

**Hyper-V VM operations** (`Get-VMNetworkAdapter`, `Stop-VM`, `Connect-VMNetworkAdapter`, `Start-VM`) shell out to `powershell.exe` via `execa`, following the pattern `src/runHosting/abnormalExitAlert.ts` already established (`-NoProfile -NonInteractive -Command '<script>'`) — no new dependency. Unlike `abnormalExitAlert.ts`'s fire-and-forget detached call, these are awaited synchronously as a normal part of the command's control flow, so a failure surfaces directly rather than being silently swallowed. Argument/command-string construction is a pure function, unit-tested the same way `buildSshRunArgv`/`buildScpArgv` are today; the actual `execa` invocation is a thin wrapper exercised only by manual verification against a real Hyper-V guest, matching the precedent already set for `createSshRemoteExec`. This was smoke-tested directly against a scratch VM (`temp-vm`) during design: `Get-VMNetworkAdapter`, `Stop-VM`, `Connect-VMNetworkAdapter`, and `Start-VM` all behaved as expected once elevated, with the full stop/reconnect/start cycle completing in about a second on the Hyper-V side (that VM has no OS, so this measures only Hyper-V's own bookkeeping, not guest shutdown/boot time).

**`Stop-VM` is graceful, not forced**: a plain `Stop-VM` requests an ACPI shutdown via the guest's Hyper-V integration services (present by default on modern Ubuntu kernels via `hv_vmbus`/`hv_utils`), letting the filesystem/journal shut down cleanly. `-Force` (a hard power-off) is only used as a fallback if the graceful request doesn't complete within a bounded timeout (60 seconds).

**The `run-hosting` readiness check** (steps 0 and 4) queries `Get-NetUDPEndpoint -LocalAddress <internal-switch-host-ip> -LocalPort 67` and `-LocalPort 53`; both must return a bound endpoint. If either is missing, the command exits with a message telling the user to start `run-hosting` and retry, without having touched VM state.

**Waiting for reachability** after each `Start-VM` (steps 1 and 5): poll a lightweight SSH command through the same `RemoteExec` seam every 10 seconds, up to a 10-minute overall timeout, for both the reassign-to-Default-Switch and isolate-to-Internal-switch directions alike. `setup-guest.md`'s documented ~5-minute worst case was observed when a *running* guest's adapter was changed live; this design always powers the guest fully off and back on for both transitions, so the guest's network stack performs a fresh DHCP negotiation at boot rather than depending on Linux's slower failed-attempt retry backoff — and with `run-hosting` now confirmed listening before the Internal-switch `Start-VM`, leases are expected to bind in under a second, per the existing doc's own measurement of that case. The 10-minute timeout is a generous backstop, not the expected common case. Progress reports through the existing `onStep` mechanism (e.g. "waiting for guest to become reachable... (40s elapsed)") so the wait is visible rather than a silent hang; a timeout error points at `setup-guest.md`'s troubleshooting section (the host-firewall "allow node.exe on public networks?" dialog, etc.).

## Mount step (reused)

No new mount logic. The existing `mountShare` create-or-update `/etc/fstab` handling (delete-then-append keyed on mount point, already convergent whether the mapping is missing, correct, or stale) is called twice — once with the Default-Switch host IP (step 2), once with the Internal-switch host IP (step 6). Same function, same idempotency guarantee already documented for it, just invoked at two points in the flow with different IPs.

## Post-scripts execution

New `runPostScripts`, structurally identical to `runPreScripts` minus the `configure-network` argument special case — none of `post-scripts/`'s built-ins (`01-auth-config.sh`, `02-apply-home-jq-transforms.sh`) take arguments, and nothing in `setup-guest.md` documents one that does. `listPreScripts` becomes a directory-agnostic `listScripts(dir)` that both `runPreScripts` and `runPostScripts` call, rather than duplicating the numeric-prefix-ordering logic. Same `RemoteExec` seam, same stop-at-first-non-zero-exit semantics. `.susentorno/post-scripts/` already supports the same custom-script weaving mechanism as `.susentorno/pre-scripts/` (README's "Customizing setup scripts"), so a woven-in custom post-script runs in its resolved position automatically, with the same no-argument limitation and idempotency caveat already documented for custom pre-scripts.

## Console output for script execution

Today, the shared `onStep` callback in `setup-guest-unix.ts` prints `setup-guest-unix: ${message}...` for every step, including each pre-script's `running ${filename}` announcement — with no separation from the script's own streamed output (apt/pnpm/etc. logs), which can be long and makes the announcement easy to miss. For `runPreScripts` and `runPostScripts` specifically (not the more compact mount-step logging), the step announcement gains a leading and trailing blank line and switches to a `susentorno: ` prefix:

```

susentorno: running 01-apt-packages.sh...

<script's own streamed output>
```

## Failure handling & idempotency limits

Every step keeps today's "stop at first non-zero exit, print what failed, exit non-zero" behavior, now spanning the full pipeline. The whole command is safe to rerun from the top after fixing a guest-side problem — the same guarantee `runPreScripts` already documents, extended across mount/pre-scripts/isolation/mount/post-scripts. The explicit caveat, unchanged in spirit from the original design: `post-scripts/` (like `pre-scripts/`) is only idempotent in practice for the built-ins; a woven-in custom script's idempotency remains the same pre-existing user responsibility the README already documents for the customization mechanism generally.

## Testing

Unit tests cover the pure logic as before: Hyper-V/`Get-NetUDPEndpoint` PowerShell-command construction, `runPostScripts` orchestration (via the generalized `listScripts`), and the reachability-poll loop against a fake clock/injected `RemoteExec`. `tests/guest/`'s QEMU harness cannot exercise anything Hyper-V-specific — VM stop/reassign/start, the elevation check, or the `run-hosting` readiness check — since it doesn't run under Hyper-V at all; that entire isolation phase joins the existing SMB mount step as a documented manual-verification gap (same spirit as ADR-0010's existing fidelity-gap callouts for this harness). `runPostScripts`'s own orchestration logic, independent of the isolation gap around it, can be exercised through the harness the same way `runPreScripts` is today.

## Documentation

`setup-guest.md`'s Ubuntu path collapses to: install `openssh-server`, run `susentorno setup-guest-unix`, done — the separate "Isolate" and "run `post-scripts/`" instructions for Ubuntu are removed from the main flow (Windows' existing manual flow is unchanged). The manual fallback callout grows to cover isolation and post-scripts as well, for diagnosing a failure or understanding exactly what the command does. A new prerequisite is called out up top: the command must be run from an elevated (Administrator) PowerShell/terminal.

## Out of scope

- Windows Guest automation — unchanged from the original design.
- Depending on cross-adapter host reachability for the pre-isolation mount (see "Why the mount isn't just pointed at the isolated IP from the start") — the Default-Switch-host-IP approach remains the guaranteed-correct one.
- A persisted Guest/VM registry — the VM name, like every other prompt, is asked fresh each run, consistent with the original design's existing choice not to introduce a config file.
