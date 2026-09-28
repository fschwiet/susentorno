# Spec: `setup-guest-windows`

Status: ready-for-agent

Source: [wayfinder map](map.md) and its resolved tickets `issues/01`–`issues/09`. Where this spec summarizes a ticket, the ticket's Answer is authoritative for detail.

## Problem Statement

A susentorno user with a Windows 11 guest has no automated path from "Windows is installed and updated" to "the guest is isolated and fully provisioned." `setup-guest-unix` does this for Ubuntu guests in one command, but the Windows equivalent is a long manual console procedure:

- setting a persistent `Set-ExecutionPolicy`;
- typing `cmdkey` credentials for the VM share by hand, once per host address;
- running each pre-isolation step one at a time;
- opening new terminals so PATH changes are visible;
- moving the adapter to the Internal switch by hand;
- running each post-isolation step.

Each manual step can go wrong silently. The shipped Windows steps ignore many native exit codes, so a failed package install can look like success. Certificate trust is split: `configure-network` installs the proxy CA and points `NODE_EXTRA_CA_CERTS` at that CA alone, so Node trusts different roots than Windows and Git do. Host ambient trust is never propagated to Windows guests in production. If something fails partway, the user cannot tell what state the guest is in or how to recover. The guest-tier harness also puts the guest password into a process argument.

## Solution

Add `susentorno setup-guest-windows`. It is a host-side command that takes an installed and updated Windows 11 Enterprise guest with one DHCP adapter on the Default Switch through the complete setup phase and isolated phase with no console work in the guest. It controls the guest only through PowerShell Direct, never over the network being configured.

The user runs it from an elevated host terminal while `run-hosting` is running. The command:

1. asks for any answer not given as a flag, including two masked passwords;
2. validates host and guest prerequisites before changing anything;
3. puts the VM on the Default Switch;
4. reconciles guest trust;
5. installs the VM share credentials;
6. runs every pre-isolation step;
7. moves the VM to the selected Internal switch;
8. proves the lease, DNS, and proxy reachability;
9. runs every post-isolation step.

Every failure stops where it happened. Nothing is rolled back. The command prints a residual-state footer that says exactly what state the VM was left in. Recovery is always the same: rerun the command. The rerun returns the guest to the Default Switch and replays the whole flow.

## User Stories

### Invocation and prompts

1. As a susentorno user, I want one command that fully provisions and isolates my Windows guest, so that I don't have to follow a manual console procedure.
2. As a susentorno user, I want the command to match `setup-guest-unix`'s automation boundary, so that both guest platforms work the same way.
3. As a susentorno user, I want `--help` to say that the command uses PowerShell Direct, moves the adapter from the Default Switch to the Internal switch, runs both phases, and needs elevation and a running `run-hosting`, so that I know the prerequisites before I start.
4. As a susentorno user, I want a flag for every non-secret answer (`--isolation-name`, `--nat-adapter-alias`, `--vm-name`, `--guest-username`, `--share-name`, `--share-account`), so that I can script the command.
5. As a susentorno user, I want each omitted non-secret answer to be prompted on its own, with the documented defaults (`vm-shared-windows`, `susentorno`), so that I can mix flags and prompts.
6. As a susentorno user, I want the guest password and the VM share password to be masked prompts with no flag, file, or environment-variable input, so that secrets never land in shell history or process listings.
7. As a security-conscious user, I want neither password to appear in output, errors, diagnostics, process arguments, or files, except for the VM share credentials that are intentionally persisted, so that running setup does not leak secrets.
8. As a susentorno user, I want no guest-address option, so that I'm not asked for something PowerShell Direct doesn't use.
9. As a susentorno user, I want every prompt answered before any trust or provisioning change is made, so that I can leave the command running unattended once the prompts end.
10. As a susentorno user, I want EOF or cancel at any prompt to exit cleanly, so that the command never loops forever when input ends.

### Accounts and credentials

11. As a susentorno user, I want the guest user account (an existing local administrator) kept separate from the VM share account (a restricted host-local account), so that the guest never logs on with share credentials and the share account never gains guest privileges.
12. As a susentorno user, I want a guest authentication failure to ask for the username and password again as a pair, even if the username came from a flag, so that I can fix a wrong username as easily as a wrong password.
13. As a susentorno user, I want an SMB authentication failure to ask for the VM share account and password again as a pair, so that I can fix either value.
14. As a susentorno user, I want structural problems (the account is not an administrator, the token is not elevated, the share path is wrong, the share is writable, a missing share account, an SMB identity conflict) reported with remediation instead of a password re-prompt, so that I don't keep retyping a correct password.
15. As a guest user, I want VM share credentials kept for both the Default-Switch and Internal-switch host addresses, so that the VM share stays reachable if the VM is later moved to either expected switch.
16. As a guest user, I want the VM share reached by UNC path with no drive letter, so that setup doesn't take a drive letter or leave stale mappings.
17. As a guest user, I want share credentials written through the native Credential Manager API and never through `cmdkey /pass:`, so that the share password never appears in a guest process argument.
18. As a security-conscious user, I want setup to fail if the VM share is writable by the share account, so that a misconfigured host share is caught.

### Preflight

19. As a susentorno user, I want host elevation, environment and Windows VM share presence, isolation name, adapter alias, and switch and host-address resolution checked before any prompt, so that basic misconfiguration fails immediately.
20. As a susentorno user, I want the VM's existence, state, adapter count, switch attachment, SMB share path, and `run-hosting` DHCP and DNS listeners checked before either password prompt, so that I don't type secrets for a run that can't succeed.
21. As a susentorno user, I want malformed generated step plans (for example, zero or several `configure-network` steps) rejected before either password prompt, so that a broken VM share fails early.
22. As a susentorno user, I want the guest checked for the supported guest platform (Windows 11 Enterprise x64 25H2, including Evaluation), an enabled local administrator, an elevated token, no pending reboot, and usable WinGet, so that unsupported or unready guests fail with clear remediation.
23. As a maintainer, I want the supported guest platform list kept as source-controlled data, so that adding a release is a deliberate change made after the guest tier passes on it.
24. As a susentorno user, I want each preflight failure to name the failed prerequisite and the VM, switch, adapter, share, account, or address involved, plus a remediation, so that I can fix it without reading the source.

### VM reconciliation and replay

25. As a susentorno user, I want the command to accept a VM that is `Off` or `Running` on either expected switch and bring it to the Default Switch, so that the first run and every rerun start the same way.
26. As a susentorno user, I want a VM already running on the Default Switch reused without a restart, so that repeated setup-phase runs are fast.
27. As a susentorno user, I want saved, paused, transitional, disconnected, extra-adapter, and unrelated-switch states rejected with remediation instead of repaired silently, so that the command never changes a VM it doesn't understand.
28. As a susentorno user, I want the VM stopped gracefully, allowing about 3 minutes for the stop and 60 seconds to confirm `Off`, and never force-stopped, so that Windows shutdown isn't cut short.
29. As a susentorno user, I want a rerun to replay the complete flow from the Default Switch from any residual state, including a completed guest, so that recovery is always "run it again."
30. As a customization author, I want the documentation to state that every step must be idempotent because recovery replays everything, so that my steps are written for replay.

### Trust

31. As a user behind a TLS-terminating corporate proxy, I want the host's ambient trust propagated into the guest's `LocalMachine\Root` before any provisioning step reaches the network, so that package installs validate the same upstreams the host can.
32. As a guest user, I want Windows, Git, and Node to trust the same set of roots (the retained ambient roots plus the current proxy CA), so that no tool fails TLS while another succeeds.
33. As a guest user, I want `NODE_EXTRA_CA_CERTS` to point at one stable combined bundle, so that Node keeps its public roots and gains both kinds of added trust.
34. As a susentorno user, I want ambient trust to only ever be added, so that replay never removes a root I depend on.
35. As a susentorno user, I want the proxy CA replaced when the environment's `cert.pem` changes, and the old one removed only if managed state proves setup installed it, so that rotation never deletes trust setup doesn't own.
36. As a susentorno user, I want a partial trust failure to leave safe state that the next replay converges from, so that a trust failure never needs manual cleanup.
37. As a security-conscious user, I want trust diagnostics to show only operations, categories, counts, and abbreviated SHA-256 fingerprints, never PEM content or subjects, so that diagnostics are safe to share.

### Steps

38. As a customization author, I want steps discovered as `NN-name.ps1` (case-insensitive extension) in ordinal filename order, with non-matching files ignored, so that I can ship sibling resources next to my steps.
39. As a customization author, I want each step to run in a fresh, elevated Windows PowerShell 5.1 process with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, working from the read-only UNC phase directory, so that PATH changes from earlier steps are visible and the guest's persistent execution policy is untouched.
40. As a customization author, I want exit code `0` to be the only success, an uncaught terminating error to become a nonzero exit, and `exit N` to be respected, so that failure semantics are predictable.
41. As a customization author, I want the documentation to say that I must check native exit codes myself, so that I know PowerShell 5.1 does not do it for me.
42. As a susentorno user, I want each step announced by phase and filename, with its stdout and stderr captured separately (8 MiB head and tail per stream) and emitted afterwards, so that I can see what each step did.
43. As a susentorno user, I want the sequence to stop at the first failed, timed-out, cancelled, or transport-failed step, with that classification and the filename shown, so that I know exactly where it stopped.
44. As a customization author, I want a 30-minute limit per step, documented in the customization README, so that slow installs have room but a hung step still ends.
45. As a susentorno user, I want the shipped steps to install only the software shipped behavior needs (jq, Git, GitHub CLI, pnpm, Node, Pi, Claude Code, Codex), and not upgrade App Installer or unrelated packages, so that setup doesn't change more of my guest than necessary.
46. As a susentorno user, I want shipped steps to skip packages that are already installed and treat every other nonzero result as failure, so that replay is idempotent and real failures are never hidden.
47. As a susentorno user, I want `configure-network` to verify the reconciled trust and set Git's `http.sslBackend=schannel` instead of installing certificates itself, so that only one component owns trust.
48. As a susentorno user, I want post-isolation auth configuration to refresh the Git identity, GitHub authentication, and the Claude and Codex placeholder credentials on every replay, so that a workspace switch takes effect when I rerun.

### Isolation

49. As a susentorno user, I want the command to refuse to isolate a guest with a pending reboot or while `run-hosting` is not running, so that it never strands a guest on the Internal switch in a broken state.
50. As a susentorno user, I want a pending reboot to fail with "restart the guest, then rerun", so that I know the remedy.
51. As a susentorno user, I want the command to prove, after isolation, that the guest has a lease from `run-hosting` with the host as gateway, working DNS through the host, and a TCP connection to the proxy stack, so that post-isolation steps start on a working network.
52. As a susentorno user, I want an isolated-readiness timeout to name the unmet condition and point at `run-hosting`, so that I can diagnose the host side.

### Progress, failure, and cancellation

53. As a susentorno user, I want each phase announced and a heartbeat about every 15 seconds during long waits, so that I know the command hasn't hung.
54. As a susentorno user, I want every failure to print a residual-state footer with the failed phase and step, the VM's queried power state and switch, which share credentials were kept verified or removed, and the instruction to rerun, so that I always know where I stand.
55. As a susentorno user, I want exit code `1` for failure and `130` for cancellation, so that scripts can tell them apart.
56. As a susentorno user, I want Ctrl+C to cancel the in-flight guest operation, clean up within about 30 seconds, print the footer, and exit `130`, and a second Ctrl+C to exit immediately, so that I stay in control.
57. As a susentorno user, I want cleanup after a failure to remove only share credentials this run wrote but did not verify, and to keep verified ones, so that a later failure doesn't erase working access.

### Maintainers and tests

58. As a maintainer, I want the Windows flow behind one deep module driven by fakes, so that every phase, failure, and residual state can be unit-tested without a VM.
59. As a maintainer, I want the Unix setup path kept byte-for-byte behaviorally unchanged apart from module moves and extractions, so that adding Windows cannot regress Ubuntu guests.
60. As a maintainer, I want the guest-tier harness to use the production PowerShell Direct executor, so that the test harness stops putting the password into `-Command` and tests the real transport.
61. As a maintainer, I want an end-to-end guest test that runs the packaged command, deliberately fails in the isolated phase, checks the real footer, and then replays successfully, so that the replay promise is proven against real Windows.
62. As a maintainer, I want evidence from every guest-tier run on whether any installer requested a reboot, so that the decision about a controlled reboot is based on data.

## Implementation Decisions

### Command contract (ticket 01)

- The command is `susentorno setup-guest-windows`, with the non-secret options `--isolation-name` (default `susentorno-internal`), `--nat-adapter-alias` (default `vEthernet (Default Switch)`), `--vm-name`, `--guest-username`, `--share-name` (prompt default `vm-shared-windows`), and `--share-account` (prompt default `susentorno`). There are no password options. `--guest-password` and `--share-password` must be rejected as unknown options.
- Prompt order:
  1. `Hyper-V VM name` and `SMB share name`.
  2. `Guest username` and masked `Guest password`.
  3. `VM share account` and masked `VM share password`, after guest authentication and the structural checks.
  - Each flag suppresses only its own initial prompt. The paired re-prompt loops re-ask both halves, even when one half came from a flag.
- A **supported guest platform** is an allowlisted tuple of (product, edition, architecture, release). The initial entry is `Windows 11 | Enterprise | x64 | 25H2`. Enterprise Evaluation counts as Enterprise. The build number is reported but not checked.
- The command does not create the VM, the guest user account, the host network, the SMB share, or the VM share account, and it does not start `run-hosting`.

### Phase machine (ticket 06)

The flow is one linear phase machine. It never detects or resumes a prior run.

| # | Phase |
| --- | --- |
| H1 | Host prerequisites: elevation, environment and Windows VM share, isolation name, adapter alias, both switches and host IPv4 addresses. Prompt for a missing VM name and share name. |
| H2 | Host checks: VM, state, adapter, switch, and share path; `run-hosting` listeners. Discover and validate both step plans. |
| H3 | Guest username and password prompts. |
| G1 | Reconcile the VM to the Default Switch and start it. |
| G2 | PowerShell Direct readiness and authentication. Rejection returns to H3. |
| G3 | Guest structural checks: platform, administrator, elevation, pending reboot, WinGet. |
| G4 | VM share account prompts. Replace and verify the Default-Switch credential, with the paired SMB re-prompt. |
| G5 | Windows guest trust reconciliation. |
| G6 | Pre-isolation steps from `\\<default-switch-host-ip>\<share>\pre-scripts`. |
| G7 | Isolation gate: no pending reboot, and `run-hosting` still bound. |
| G8 | Replace the Internal-switch credential, marked unverified. |
| G9 | Graceful stop, connect the adapter to the Internal switch, start. |
| G10 | PowerShell Direct readiness with the same executor. Rejection here is structural. |
| G11 | Isolated-network readiness: lease and gateway, DNS, proxy TCP. |
| G12 | Verify Internal-switch UNC share access. |
| G13 | Post-isolation steps from `\\<internal-switch-host-ip>\<share>\post-scripts`. |
| G14 | Dispose the executor and print the success summary. |

- G8 comes after G7 on purpose, so a pre-isolation failure never discards a previously verified Internal-switch entry.
- Fixed deadlines have no flags, and there is no overall command deadline:

  | Wait | Deadline |
  | --- | --- |
  | PowerShell Direct readiness | 5 minutes, probing about every 5 seconds |
  | Each structural-check or trust invocation | 2 minutes |
  | Each share operation | 1 minute |
  | Each step | 30 minutes |
  | Isolated readiness | 3 minutes |
  | Graceful stop / confirm `Off` | about 3 minutes / 60 seconds |

- The first version never reboots the guest. A pending reboot at G3 or G7 fails with "restart the guest, then rerun". The only sanctioned future extension is a controlled reboot on the Default Switch followed by a replay of the complete pre-isolation plan, and only if guest-tier evidence requires it.
- There is no rollback. On a handled failure, cleanup closes any open selected-share connection and removes any credential this run wrote but has not verified. The executor is always disposed. Cancellation runs the same cleanup, bounded to about 30 seconds.
- The residual-state footer queries Hyper-V after the failure; it does not infer state. Ticket 06's residual-state table defines what each failure boundary leaves and states that the next run replays from all of them.

### PowerShell Direct boundary (ticket 02)

- A credential-scoped `WindowsGuestExecutor`, created after the guest password prompt and disposed in `finally`. Its interface came from the prototype:

  ```ts
  interface WindowsGuestExecutor {
    readonly vmName: string;
    invoke(script: string, options: { timeoutMs: number; signal?: AbortSignal }):
      Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
    dispose(): Promise<void>;
  }
  ```

- Each invocation starts a short-lived shipped bridge (`powershell.exe -File <bridge>`). Only the bridge path and the VM name go in argv. The credential and the base64 script go over stdin as one JSON request.
  - The bridge repairs the PowerShell 5.1 module path, calls `Invoke-Command -VMName` with a fixed runner, and clears its references.
  - The runner starts a guest child with `-NoProfile -NonInteractive -ExecutionPolicy Bypass` and a fixed encoded loader, and the script reaches the child over its stdin. There is no temporary file, no nested quoting, and no persistent PSSession.
- The loader forces UTF-8 output and suppresses progress records, which would otherwise pollute stderr as CLIXML.
- When a deadline expires, the guest child is killed and the invocation returns `exitCode: 124, timedOut: true`. A wedged bridge is force-killed after a small margin. An `AbortSignal` returns promptly while the supervised bridge reaps the child.
- A completed nonzero exit is a result. Transport, authentication, cancellation, deadline, and protocol failures are distinct typed outcomes, and all of them redact the request.
- `waitForPowerShellDirect(executor, { deadlineMs, onHeartbeat, signal })` probes readiness. It returns ready or auth-rejected and throws a typed transport, protocol, or timeout failure. Repeated bad credentials never turn into a readiness timeout.
- The bridge ships as a PowerShell template outside every VM-share template directory, so `update-shares` never weaves it into a guest share. It is resolved through `packageRoot()`.

### VM share credentials (ticket 03)

- Two Credential Manager entries in the guest user account, keyed by the Default-Switch and Internal-switch host IPv4 addresses. Both hold the `--share-account` identity. They are written in-process through the native API, equivalent to `cmdkey /add`, and never with `/pass:`. Access is by UNC path only, with no drive mapping.
- For each address, replay does the following: close any existing connection to the selected share, delete the credential at that target, write the new one, and verify it when the address is reachable. It never disconnects other shares. An SMB identity conflict on the same address fails and names the address.
- Verification passes only if all three hold:
  1. a known generated file can be read and the `pre-scripts` and `post-scripts` paths can be listed;
  2. creating a probe in the share root fails with access denied;
  3. if the probe is created anyway, the command removes it best-effort and fails as a structural error.
- An authentication failure only at the Internal-switch address is structural. The command removes that entry and requires a full rerun.
- After each phase's steps, the command closes its selected-share connection and keeps the verified entry.
- The per-run credential ledger records verified and removed entries for the footer.

### Trust reconciliation (ticket 05)

- One host-driven Windows guest trust reconciliation runs at G5, before the first step. It is the only owner of certificate imports, managed trust files, and `NODE_EXTRA_CA_CERTS`.
- It takes one immutable snapshot per run:
  - host roots from the existing production `enumerateHostTrustedRoots`, with its Disallowed-store and server-authentication EKU policy unchanged;
  - the environment's validated `cert.pem`;
  - DER SHA-256 fingerprints of the guest's `LocalMachine\Root`.
- Certificates are installed into `LocalMachine\Root` only, never Current User. Diffing is by lowercase DER SHA-256.
- Managed state lives under `C:\ProgramData\susentorno\trust`:
  - fingerprint-named ambient PEMs;
  - the current proxy CA PEM;
  - a manifest listing the managed ambient fingerprints and the current proxy fingerprint;
  - one combined, deduplicated Node supplemental bundle. Machine `NODE_EXTRA_CA_CERTS` points at this bundle.
- Ambient trust is additive. The proxy CA is replaceable: the command installs and verifies the new CA, publishes the bundle, and only then removes the old CA if the manifest proves ownership. Ambiguous ownership fails without deleting anything.
- Apply order:
  1. validate everything;
  2. write the ambient PEMs;
  3. import missing certificates;
  4. re-read the store and verify;
  5. atomically replace the manifest and bundle;
  6. set and verify the environment variable;
  7. remove the superseded proxy CA and verify.

  The command stops at the first failure and does not roll back. If managed state is missing, it is rebuilt from valid PEMs. Malformed PEMs are never silently discarded.
- `WindowsTrustReconciliationError` names the operation (host enumeration, guest fingerprint, ambient import, proxy import, bundle publication, environment update, proxy cleanup, or verification), the trust category, and an abbreviated fingerprint, plus the executor's bounded output.

### Step runner (ticket 04)

- Discovery matches `NN-name.ps1`: `NN` is exactly two digits, `name` is non-empty, and the extension is case-insensitive. Sorting is ordinal, and duplicate prefixes are allowed. The plan must contain exactly one step whose slug is exactly `configure-network`. That step alone receives `-HostIp <internal-switch-host-ip>`. No other step receives runner arguments.
- Each step is one executor invocation. A fixed wrapper sets `$ErrorActionPreference = 'Stop'`, runs `Set-Location -LiteralPath <phase UNC dir>`, and invokes the step path with the call operator. The path is passed as data and never interpolated into source.
- `0` is the only success. The runner never infers failure from a stale `$LASTEXITCODE`.
- stdout and stderr are captured separately. Each has an 8 MiB ceiling, keeping the head and tail with a truncation marker, and nothing spills to a durable file. The phase and filename are announced before each step, and its output is emitted afterwards with the same context.
- The runner fails fast and never retries a step.
- It is separate from the Unix `runPreScripts` and `runPostScripts`. Only the pure discovery model is shared.

### Shipped step changes (ticket 09)

- **All steps:** a mutating native command succeeds only with exit `0`. Each step checks `$LASTEXITCODE` right after every native call and throws a step-specific error that names the operation and status. The only exception is a named, documented, tested read-only probe (the pinned WinGet "package absent" result). Steps never prompt, never write to the share, never map drives, never change the persistent execution policy, and never rely on another step's session state.
- **`01-install-packages`:**
  - Remove the Store-pinning bypass toggle, the App Installer self-upgrade, and `upgrade --all`.
  - For jq, Git, and GitHub CLI, check exact installed state first, then do an exact, silent, non-interactive install with agreements accepted.
  - Refresh PATH for the current process only, verify each tool, and drop the "open a new terminal" text.
- **`02-install-pnpm`:** stage the official bootstrap in a unique temp file removed in `finally`. Verify that the persisted `PNPM_HOME` and PATH resolve pnpm.
- **`03-install-tools`:**
  - Require pnpm first.
  - Check every pnpm result.
  - Install Claude Code with the exact-state-first WinGet pattern.
  - Verify `node`, `pi`, `claude`, and `codex`.
  - Treat a reboot-required result as failure.
- **`configure-network`:**
  - Remove all certificate and environment mutation.
  - Validate `HostIp` as IPv4 without using it.
  - Verify the reconciled proxy fingerprint, manifest, `NODE_EXTRA_CA_CERTS`, and bundle contents.
  - Set and read back `http.sslBackend=schannel`, then clear the DNS cache.
- **`01-auth-config`:**
  - Validate all inputs before any mutation.
  - Check every `git config` and `gh auth` call, passing the token on stdin.
  - Replace the Claude and Codex placeholders atomically on every replay.
- **`02-apply-home-jq-transforms`:** require `node` and `jq` first, then invoke the transformer by its `$PSScriptRoot` path and propagate its exit code.
- **`verify-config.ps1`:** switch to DER SHA-256 checks against the manifest and bundle, and check native status immediately after each call.

### Module boundaries (ticket 07)

- `src/guestSetup/` splits into shared top-level modules, `unix/`, and `windows/`. Shared modules get no platform flags.
- Behavior-preserving shared changes:
  - `resolveGuestNetwork` moves into a shared `guestNetwork` module.
  - `SetupAnswerPrompts` moves into `cliPrompt`, and the Unix answer functions move into `unix/`.
  - `listScripts(dir, naming)` takes `UNIX_STEP_NAMING` or `WINDOWS_STEP_NAMING`.
  - `diffAmbientCandidates` is extracted into `hostTrustStore`.
  - `vmReconcile` and `preflightChecks` are unchanged. Windows passes its stop deadlines through the existing deps.
- Windows modules: `guestExecutor`, `setupAnswers` (`resolveHostAnswers`, a generic `pairedCredentialPrompt`), `hostPreflight`, `stepPlan`, `stepRunner`, `trustReconciler` (a pure planner plus an executor-driven applier), `shareCredential` (including the ledger), `guestChecks` (the platform allowlist and the pending-reboot probe), `isolatedReadiness`, `setupFlow`, and `residualStateFooter`.
- **Deep module:** `runWindowsSetup(deps, flags, signal) → WindowsSetupOutcome`. The deps are the host `PowerShellExec`, an executor factory, prompts, an output sink, a clock and sleep, the resolved network, and the discovered plans. The outcome is success, failure (phase, step filename, classified error, credential ledger), or cancelled.
- **Thin command:** it registers options, runs the elevation and environment checks, wires the real adapters, and maps the outcome to the footer and exit code `1` or `130`.
- **Sequencing:**
  1. A restructure slice with no Windows code. It must pass the unit, CLI, and Unix guest tiers.
  2. The Windows modules and the command.
  3. A harness-adoption slice. The guest harness's Windows exec becomes a thin adapter over the production executor, keeping its OOBE wait as test policy. The harness Windows trust helper is deleted.

## Testing Decisions

### What makes a good test

A good test exercises external behavior at the highest seam that observes the promise. It does not test internals. Each acceptance promise belongs to exactly one tier.

### Seams

These follow ticket 07's boundaries and ticket 08's verification plan.

- **Primary unit seam:** `runWindowsSetup`, driven through fakes for the host PowerShell, the executor factory, the prompts, the output sink, and the clock. It covers:
  - phase order, and all prompts before any mutation;
  - flag suppression, defaults, and prompt order;
  - both paired re-prompt loops, including a flagged name, and their EOF exits;
  - structural failures versus credential failures;
  - G8 after G7, and the G7 gate;
  - fixed deadlines against a fake clock;
  - progress lines and heartbeats;
  - the cleanup ledger;
  - cancellation, including the second Ctrl+C;
  - every residual-state row in ticket 06.
- **Focused unit seams**, only where a module has logic worth pinning on its own:
  - `hostPreflight`;
  - `stepPlan` and `stepRunner` (classification, capture limits, fail-fast);
  - the `trustReconciler` planner (rotation, ownership ambiguity) and the applier's typed failure;
  - `shareCredential`;
  - `guestChecks`;
  - `isolatedReadiness`;
  - `residualStateFooter`;
  - `setupAnswers`;
  - the executor's bridge protocol and deadline handling;
  - the command's outcome-to-exit-code mapping.
- **CLI tier:** a new elevated `setupGuestWindows` CLI test, modeled on the existing `setupGuestUnix` CLI test. It covers:
  - the help text;
  - the listed options and rejection of the password flags;
  - failures before any prompt for a bad isolation name, an adapter that doesn't resolve, or a missing environment or VM share;
  - a nonexistent `--vm-name` failing before `Guest password`;
  - EOF at `Hyper-V VM name`.
- **Guest tier:** a new `windowsE2e` role replaces `windowsFresh`.
  - **Staging:** the real proxy stack on the `test` isolation name, the placeholder PAT, a customized `post-scripts/99-fail.ps1`, and a `gh.cmd` shim on the guest's machine PATH.
  - **Run 1:** the packaged `node dist/cli.js setup-guest-windows` runs with every non-secret flag and both secrets on stdin. It must exit `1` at G13 on `99-fail.ps1`, and the real footer must show `Running` on the test Internal switch with both credentials verified.
  - **Run 2:** remove the failing step and rerun. The command must exit `0`.
  - **Assertions inside the isolated guest:**
    - addressing and DNS come from `run-hosting`, and there is no direct route to the Internet;
    - allow, terminate, drop, and 403 behave as the network policy requires;
    - trust reconciliation took effect;
    - the share is reachable by UNC on both addresses;
    - the tools resolve;
    - Git uses schannel;
    - the auth and home transforms were applied;
    - the persistent execution policy is unchanged;
    - neither password appears in any output or artifact.
  - **Operations:**
    - `beforeAll` gets a 2-hour budget;
    - each run's log is saved;
    - `reboot-evidence.txt` records reboot evidence;
    - diagnostics are extended with WinGet logs, pending-reboot markers, `cmdkey /list` targets, and trust fingerprints, and are scanned for secrets.
  - **Golden image:** its `git` stage becomes a `winget-ready` stage, which forces one image rebuild. `SUSENTORNO_WINDOWS_ISO` stays a required prerequisite.
- Shipped `.ps1` steps get no Pester tests. The guest tier is where their contract is observable.

### Prior art

- **Unit:** the existing `setupGuestUnix`, `vmReconcile`, `preflightChecks`, `listScripts`, and `hostTrustStore`/`ambientTrust` unit tests show the fake-deps style. The prototype's tests show how to test the executor protocol.
- **CLI:** the existing elevated `setupGuestUnix` CLI test.
- **Guest:** the existing `windowsFresh` role and its harness (`windowsGuestExec`, `collectWindowsDiagnostics`, `sweepIsolationResidue`) and the Unix guest roles.

### Acceptance

Ticket 08's 37-row checklist is the acceptance contract. Each row names the one tier and owner that must cover it.

## Out of Scope

- Creating the Hyper-V VM, acquiring media, installing Windows, running Windows Update, and creating the guest user account.
- Windows 10, Windows Server, other architectures or feature releases, Microsoft or domain accounts, and non-administrator guest user accounts.
- SSH or WinRM in Windows guests.
- Any guest reboot in the first version. The controlled-reboot extension is only permitted if guest-tier evidence requires it.
- Phase detection, resume in place, rollback, or a separate cleanup mode.
- Configurable deadlines or an overall command deadline.
- Changing `setup-guest-unix` behavior, or moving Unix onto the supported-guest-platform allowlist model.
- Pester or PowerShell-level unit tests of shipped steps.
- Proving positive allow-listed egress inside setup. The post-isolation steps and the guest tier exercise it.

## Further Notes

- Documentation that must land with the implementation:
  - the `setup-guest.md` Windows section rewritten around the command. It covers the prerequisites, flags and prompt order, replay, how to read the footer, and the "restart the guest, then rerun" remediation, and it deletes the manual `Set-ExecutionPolicy`, `cmdkey`, and step-by-step guidance;
  - the generated Windows customization READMEs: the step contract and the 30-minute limit;
  - `testing.md`: the `windowsE2e` row replaces `windowsFresh`;
  - an ADR-0027 amendment: `windowsE2e` replaces `windowsFresh`, the `gh` shim is the only remaining substitution, and the "Windows arm of ambient trust in `src/`" rejection is superseded;
  - `CONTEXT.md` already defines **Guest user account** and **VM share account**.
- ADR-0028's trust-selection policy governs which host roots are selected. ADR-0027 deferred the Windows production implementation only until a caller existed, and this command is that caller.
- The PowerShell Direct prototype is throwaway evidence, not production code.
