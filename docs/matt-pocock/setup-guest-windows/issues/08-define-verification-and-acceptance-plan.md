# Define the verification and acceptance plan

Type: grilling
Status: resolved
Blocked by: 06, 07

## Question

What exact evidence must an implementation provide before `setup-guest-windows` is considered complete?

Define unit coverage for the stable internal seams and failure states; CLI coverage for packaged help, options, prompts, preflight, and secret handling; and a guest-tier scenario that invokes the packaged command from the setup phase, runs the real Windows pre-isolation steps, crosses onto the real Internal switch, runs the real post-isolation steps, and verifies the resulting isolated guest. Account explicitly for the current Windows golden image's preinstalled Git substitution, the optional ISO prerequisite, two masked password inputs, long-running package installation, and diagnostics on failure. The guest-tier run must record whether any supported installer requested a reboot, because that evidence alone would trigger the controlled-reboot extension in [Define end-to-end orchestration and recovery](06-define-orchestration-and-recovery.md). Decide how replay from the orchestration ticket's residual states and its residual-state footer are covered.

Also define the required documentation changes and an acceptance checklist linking each observable promise from the command and orchestration decisions to one highest-appropriate test tier. Do not implement the tests or command in this ticket.

## Answer

An implementation is complete when the unit, CLI, and guest tiers pass with the coverage below, the documentation changes land, and every row of the acceptance checklist has its owning test. Unit tests cover the stable seams and every failure state through fakes. The CLI tier covers what the packaged command can show without a VM. One guest-tier role, `windowsE2e`, proves the real flow, one real replay, and the isolated guest.

### Guest tier: the `windowsE2e` role

`tests/guest/windowsE2e.test.ts` replaces `windowsFresh`, which is retired and whose network-boundary assertions move here. It boots from the golden image with its single adapter on the Default Switch.

**Staging (before run 1):**

- Start the real proxy stack on the `test` isolation name and create the test share.
- Write `github-config.txt` containing the placeholder PAT.
- Add a customized `post-scripts/99-fail.ps1` that throws.
- Put a `gh.cmd` shim (exit `0` for any arguments) in a directory at the front of the guest's **machine** PATH.

The shim stays inside the disposable guest's differencing disk, and `sweepIsolationResidue` removes it after an aborted run. It is not injected through a per-process PATH, because the host environment never reaches guest steps and ticket 09 forbids runner-supplied PATH behavior.

**Invocation:** `node dist/cli.js setup-guest-windows` with every non-secret flag: `--isolation-name test`, `--vm-name`, `--guest-username Administrator`, `--share-name`, `--share-account`. The two secrets go in on stdin as `<guest password>\n<share password>\n`. The golden `Administrator` is the guest user account.

**Run 1 (real failure):**

- The command must exit `1` at G13 on `99-fail.ps1`, after every real pre- and post-isolation step has run.
- The footer, captured through real Hyper-V queries, must name:
  - phase G13 and step `99-fail.ps1`;
  - the VM as `Running` on the test Internal switch;
  - both VM share credentials as verified;
  - the instruction to rerun.

**Run 2 (replay):** remove `99-fail.ps1` and rerun. The command must exit `0`. This covers:

- the G1 path "running on the Internal switch", which stops the VM and returns it to the Default Switch;
- credential replacement over entries that were already verified;
- replay idempotence for every shipped step.

**After run 2, assert inside the isolated guest:**

- The DHCP address, default route, and resolver all come from `run-hosting`, and there is no in-guest DNS responder.
- The guest has no direct Internet route.
- Allow-listed `:80` and `:443` traffic passes through. A terminated `:443` destination validates against the proxy CA. `git ls-remote` works over schannel. A non-allow-listed `:443` connection is dropped, and a non-allow-listed `:80` request gets `403`.
- Trust reconciliation took effect:
  - the proxy CA's DER SHA-256 fingerprint is in `LocalMachine\Root`;
  - the managed manifest names that fingerprint;
  - `NODE_EXTRA_CA_CERTS` names the combined bundle.
- The share is reachable by UNC for both host addresses, with credential targets present for both and no mapped drive.
- `jq`, `git`, `node`, `pnpm`, `pi`, `claude`, and `codex` resolve and report versions. The real GitHub.cli package is installed even though the shim shadows `gh`.
- `http.sslBackend` is `schannel`.
- `01-auth-config` applied the Git identity and the Claude and Codex placeholders, including the host Codex account ID.
- The home settings transform ran.
- The guest's persistent execution policy is unchanged from the golden image's.
- Neither password appears in either run's output or in any collected artifact.

**Operations:**

- The `beforeAll` hook timeout is 2 hours.
- Command output streams live and is also saved as `setup-guest-windows.run-<n>.log`.
- After each run, the production pending-reboot probe, together with the WinGet, pnpm, and Claude step outcomes, is written to `reboot-evidence.txt`. A green run is itself the evidence that no supported installer requested a reboot, because ticket 09 makes such a result a step failure and G7 refuses to isolate. Only a failure naming a reboot-required package status would trigger the controlled-reboot extension from [Define end-to-end orchestration and recovery](06-define-orchestration-and-recovery.md).
- `collectWindowsDiagnostics` adds:
  - WinGet `DiagOutputDir` logs and the pending-reboot markers;
  - `cmdkey /list` (targets only);
  - the managed trust manifest and the bundle's fingerprints;
  - a VM screenshot and both run logs.

  Every artifact is scanned for both passwords.

**Golden image and prerequisites:**

- The golden build's `git` stage becomes a `winget-ready` stage. It keeps the App Installer registration retry, requires `winget --version` to exit `0` at the version G3 supports, and installs nothing. Step 01 therefore installs Git, jq, and gh for real in run 1, and takes the verified-installed skip for all three in run 2. The stamp change forces one Windows image rebuild.
- `SUSENTORNO_WINDOWS_ISO` stays a **required** guest-tier prerequisite, per ADR-0027's 2026-09-27 amendment; it is not optional.

### CLI tier

`tests/cli/setupGuestWindows.test.ts` (elevated, like `setupGuestUnix.test.ts`) covers:

- `--help` text: PowerShell Direct, the switch move, both phases, elevation, and `run-hosting`.
- Every non-secret option is listed, and `--guest-password` and `--share-password` are rejected as unknown options.
- An invalid isolation name, or one that resolves to no adapter, fails with no prompts.
- An uninitialized environment, or one without the Windows VM share, fails before any prompt.
- A nonexistent `--vm-name` fails at H2 without reaching `Guest password`.
- EOF on the `Hyper-V VM name` prompt exits cleanly.

### Unit tier

Mirroring the layout from ticket 07:

- **`runWindowsSetup`**, through fakes: phase order; every prompt before any mutation; flag-suppressed prompts, defaults, and prompt order; both paired re-prompt loops (including re-asking a flagged name) and their EOF exits; structural failures versus credential failures; G8 placed after G7; the G7 gate; fixed deadlines against a fake clock; progress lines and heartbeats; the cleanup ledger (unverified entries removed, verified entries kept); cancellation (bounded cleanup, second Ctrl+C, the `cancelled` outcome); and every residual-state row in ticket 06's table.
- **Focused seams:**
  - `hostPreflight`: state, adapter, switch, and share-path rules.
  - `stepPlan` and `stepRunner`: plan validation and result classification.
  - `trustReconciler`: the planner, including rotation and ownership ambiguity, and the applier's typed failure.
  - `shareCredential`: replace, verify, close, remove-unverified, and the ledger.
  - `guestChecks`: the platform allowlist and the pending-reboot probe.
  - `isolatedReadiness`: each unmet condition named.
  - `residualStateFooter`: formatting.
  - `setupAnswers`.
  - The executor's bridge protocol and deadline handling.
  - The command's mapping of outcome to exit code `1` or `130`.
- **Restructure slice from ticket 07:** it must keep the existing unit, CLI, and Unix guest tiers green before any Windows module lands.

Shipped `.ps1` steps get no Pester or PowerShell-level tests. The guest tier is where their contract is observable.

### Documentation

1. **`setup-guest.md` Windows section**, rewritten around the command: the prerequisites (ticket 01), the flags and prompt order, what rerunning does (replay from the Default Switch), how to read the residual-state footer, and the "restart the guest, then rerun" remediation. The manual `Set-ExecutionPolicy`, `cmdkey`, script-by-script, and "open a new terminal" guidance is deleted.
2. **Generated Windows customization READMEs:** the ticket 09 step contract and the 30-minute per-step limit.
3. **`testing.md`:** the guest-tier row describes `windowsE2e`, its longer runtime, and the `gh` shim, and no longer mentions `windowsFresh`.
4. **ADR-0027 amendment:**
   - `windowsE2e` replaces `windowsFresh`;
   - the only remaining substitution is the `gh` shim, because Git is no longer preinstalled and the harness trust helper is gone;
   - the rejected option "a Windows arm of `propagateAmbientTrust` in `src/`" is noted as superseded now that a caller exists.
5. **`CONTEXT.md`:** adds **Guest user account** and **VM share account**. This was done while resolving this ticket.

### Acceptance checklist

Each observable promise is owned by one tier: the highest one that directly observes it.

| # | Promise (source) | Tier | Owner |
| --- | --- | --- | --- |
| 1 | Help describes PowerShell Direct, switch move, both phases, elevation, `run-hosting` (01) | cli | `setupGuestWindows.test.ts` |
| 2 | Every non-secret answer has a flag; no password flag exists (01) | cli | `setupGuestWindows.test.ts` |
| 3 | Isolation name, adapter, and environment/VM-share failures occur before any prompt (01, H1) | cli | `setupGuestWindows.test.ts` |
| 4 | A missing VM fails before any secret prompt (01, H2) | cli | `setupGuestWindows.test.ts` |
| 5 | EOF at a prompt exits cleanly (01) | cli | `setupGuestWindows.test.ts` (VM-name prompt); unit for later prompts |
| 6 | Non-elevated host fails first (01) | unit | command wiring |
| 7 | Each flag suppresses only its own prompt; defaults and prompt order (01) | unit | `setupAnswers`, `setupFlow` |
| 8 | VM state, adapter-count, switch, and share-path rules; `run-hosting` listener check (01, H2) | unit | `hostPreflight`, `setupFlow` |
| 9 | Plan discovery fails before either secret (06, H2) | unit | `stepPlan`, `setupFlow` |
| 10 | Guest auth failure re-asks the username and password as a pair, including a flagged username (01, G2) | unit | `setupFlow` |
| 11 | Structural guest checks (platform, admin, elevation, pending reboot, WinGet) fail with remediation and do not re-prompt (01, G3) | unit | `guestChecks`, `setupFlow` |
| 12 | SMB auth failure re-asks as a pair; a structural share failure never looks like a bad password (01, G4) | unit | `shareCredential`, `setupFlow` |
| 13 | All prompts precede any trust or provisioning mutation (06) | unit | `setupFlow` |
| 14 | Starting states: Off/Running on either expected switch accepted; transitional, saved, extra-adapter, unrelated-switch states rejected (01, 06 G1) | unit | `hostPreflight`, `setupFlow` |
| 15 | Graceful stop within the Windows deadlines; never force-stops (06) | unit | `setupFlow` via `vmReconcile` deps |
| 16 | Fixed deadlines per wait (06) | unit | `setupFlow` with a fake clock |
| 17 | Internal-switch credential written only after the isolation gate (06, G8) | unit | `setupFlow` |
| 18 | Never isolates with a pending reboot or a dead `run-hosting` (06, G7) | unit | `setupFlow` |
| 19 | Isolated-readiness expiry names the unmet condition (06, G11) | unit | `isolatedReadiness` |
| 20 | Phase announcements and 15-second heartbeats (06) | unit | `setupFlow` |
| 21 | Cleanup removes only unverified credentials this run wrote; the executor is always disposed (06) | unit | `shareCredential`, `setupFlow` |
| 22 | Cancellation: bounded cleanup, footer, exit `130`; a second Ctrl+C exits immediately (06) | unit | `setupFlow`, command wiring |
| 23 | Every residual-state row replays from the Default Switch (06) | unit | `setupFlow` |
| 24 | Trust planner rotates only provably managed proxy trust and fails on ambiguity (05) | unit | `trustReconciler` |
| 25 | Step result classification, capture limits, and fail-fast (04) | unit | `stepRunner` |
| 26 | A first run from the Default Switch reaches the isolated phase through real pre- and post-isolation steps (01, 06) | guest | `windowsE2e` run 1 |
| 27 | The real residual-state footer reports the queried VM state and credential ledger; exit `1` (06) | guest | `windowsE2e` run 1 |
| 28 | Rerunning from a failed isolated guest replays everything and succeeds; every shipped step is idempotent (01, 06, 09) | guest | `windowsE2e` run 2 |
| 29 | The guest's addressing, route, and DNS come from `run-hosting`; there is no direct Internet route (06 G11) | guest | `windowsE2e` |
| 30 | The network boundary enforces the network policy (allow, terminate, drop, 403) | guest | `windowsE2e` |
| 31 | Trust reconciled: proxy CA fingerprint in the root store, manifest, Node bundle (05) | guest | `windowsE2e` |
| 32 | VM share reachable by UNC on both addresses with retained credentials and no drive mapping (03) | guest | `windowsE2e` |
| 33 | Shipped packages and tools install and resolve in fresh processes; Git via schannel (09) | guest | `windowsE2e` |
| 34 | Post-isolation auth and home transforms applied (09) | guest | `windowsE2e` |
| 35 | Persistent execution policy unchanged (map Notes) | guest | `windowsE2e` |
| 36 | Neither secret appears in output, errors, or diagnostics (01) | guest | `windowsE2e` scan across runs and artifacts |
| 37 | No supported installer requested a reboot (06, 09) | guest | `windowsE2e` `reboot-evidence.txt` |
