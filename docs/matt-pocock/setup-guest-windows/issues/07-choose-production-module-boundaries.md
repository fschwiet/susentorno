# Choose the production module boundaries

Type: grilling
Status: resolved
Blocked by: 06

## Question

Where should the Windows setup path share production modules with `setup-guest-unix`, and where should it remain an honest Windows-specific sibling?

Using the settled command, PowerShell Direct, script, trust, share, and orchestration contracts, assign responsibilities and stable interfaces across the command registration, prompt resolution, host-network preflight, VM reconciliation, guest execution, share access, script running, and ambient-trust modules. Decide which proven guest-harness code graduates into `src/`, which Unix modules become platform-neutral without weakening their interfaces, and which apparent similarities should remain duplicated because their semantics differ.

The answer should be a file/module-level implementation outline that minimizes conditional platform branches, preserves current Unix behavior, and leaves seams that the agreed test tiers can exercise directly.

## Answer

Split `src/guestSetup/` three ways: shared host-side modules at the top level, Unix-only modules in `unix/`, Windows-only modules in `windows/`. Put the 14-phase Windows flow behind one deep, fake-driven module, with a thin Commander registration in front of it. Unix gets behavior-preserving refactors only: moves, one function relocation, one pure-helper extraction, and a data parameter on script discovery. No platform flags are added to shared modules.

### Layout

| Location | Modules | Notes |
| --- | --- | --- |
| `src/guestSetup/` (shared) | `powerShellExec`, `quoteForPowerShell`, `elevationCheck`, `hyperVQueries`, `hyperVOperations`, `vmReconcile`, `switchName`, `preflightChecks`, `runHostingReadiness`, `hostTrustStore`, `listScripts`, new `guestNetwork` | Host-side and platform-neutral. |
| `src/guestSetup/unix/` | `remoteExec`, `quoteForRemoteShell`, `mountShare`, `fstabLine`, `kvpDaemon`, `runPreScripts`, `runPostScripts`, `ambientTrust`, `setupAnswers`, `reachabilityWait`, `tcpConnect` | Moved without renaming. `reachabilityWait`/`tcpConnect` are generic, but Unix is their only user, so they don't count as a shared seam. |
| `src/guestSetup/windows/` | `guestExecutor`, `setupAnswers`, `hostPreflight`, `stepPlan`, `stepRunner`, `trustReconciler`, `shareCredential`, `guestChecks`, `isolatedReadiness`, `setupFlow`, `residualStateFooter` | New. |
| `src/commands/setupGuestWindows.ts` | Option registration, the elevation and environment checks, real-adapter wiring, and turning the outcome into the footer and exit code | Registered in `src/cli.ts`. |
| `templates/powershell/windowsGuestBridge.ps1` | Shipped PowerShell Direct bridge | Outside every VM-share template directory, so `update-shares` never weaves it into a guest share. Resolved through `packageRoot()`. |

Within a platform directory, the directory carries the platform, so filenames have no prefix. Exported symbols keep a platform qualifier where a bare name would be ambiguous at the import site (`WindowsGuestExecutor`, `WindowsTrustReconciliationError`), and Unix symbols keep their current names. Unit tests mirror the layout: `tests/unit/guestSetup/`, `tests/unit/guestSetup/unix/`, `tests/unit/guestSetup/windows/`.

### Shared-module changes (behavior-preserving)

- **`guestNetwork.ts`**: `resolveGuestNetwork` and its result/failure types move here from `src/commands/setupGuestUnix.ts`, with unchanged hint text. Both commands use it for H1.
- **`src/cliPrompt.ts`**: gains the `SetupAnswerPrompts` type. The Unix answer functions move to `unix/setupAnswers.ts`.
- **`listScripts(dir, naming)`**: takes one of two exported constants. `UNIX_STEP_NAMING` is `.sh`, case-sensitive, as today. `WINDOWS_STEP_NAMING` is `.ps1` with a case-insensitive extension. Sorting is explicitly ordinal. `GuestScript` stays the shared discovered-step representation. Validating the plan stays per-platform: Unix keeps its check inside `runPreScripts`, and Windows validates in `windows/stepPlan.ts` during H2.
- **`hostTrustStore.ts`**: gains the pure SHA-256 diff and fingerprint normalization (`diffAmbientCandidates`), extracted from `unix/ambientTrust.ts`, which re-imports them.
- **`preflightChecks.ts`** and **`vmReconcile.ts`**: unchanged. Windows passes its 3-minute stop and 60-second confirm-off deadlines through the existing `VmReconcileDeps` timeout fields. The shared code already never force-stops.

### Windows modules and interfaces

- **`windows/guestExecutor.ts`**: the `WindowsGuestExecutor` interface from [Prototype the secure PowerShell Direct boundary](02-prototype-secure-powershell-direct-boundary.md), created from the shipped bridge. It also exposes `waitForPowerShellDirect(executor, { deadlineMs, onHeartbeat, signal })`, which returns ready or auth-rejected and throws a typed transport, protocol or timeout failure. This is the only module that knows about the bridge, the credential, or PowerShell Direct.
- **`windows/setupAnswers.ts`**: `resolveHostAnswers(flags, prompts)` for the VM name and share name, and a generic `pairedCredentialPrompt(...)` that yields successive (name, masked secret) pairs until the caller accepts one. An EOF or cancel ends it with a distinct result. Both the guest account and the VM share account use it. It reuses only `SetupAnswerPrompts` and `cliPrompt`.
- **`windows/hostPreflight.ts`**: calls the shared `runPreflightChecks`, then adds the Windows-only rules. The state must be `Running`/`Off`, the adapter must be on one of the two expected switches (which is why the shared `planVmReconciliation` never meets an unrelated switch), and the named SMB share must resolve to this environment's Windows VM-share directory.
- **`windows/stepPlan.ts`** / **`windows/stepRunner.ts`**: `stepPlan.ts` validates the plan in H2, including exactly one exact `configure-network`. `stepRunner.ts` holds the per-step wrapper, the UNC working directory, the `-HostIp` argument, the 8 MiB head/tail capture, result classification and fail-fast, as set out in [Define Windows script-runner semantics](04-define-windows-script-runner-semantics.md). It is separate from the Unix runners.
- **`windows/trustReconciler.ts`**: internally split into a pure planner and an executor-driven applier. The planner takes the host snapshot, the validated proxy CA from `src/ca.ts` helpers, the guest `LocalMachine\Root` fingerprints and the managed manifest, and returns either an ordered operation list or an ownership-ambiguity failure. The applier carries the typed `operation` failure from [Define Windows ambient-trust propagation](05-define-windows-ambient-trust-propagation.md).
- **`windows/shareCredential.ts`**: replace, verify, close, and remove-unverified for each address-keyed entry, plus the per-run credential ledger that the footer reads. See [Define the Windows share credential lifecycle](03-define-windows-share-credential-lifecycle.md).
- **`windows/guestChecks.ts`**: G3's structural checks, with the supported-platform allowlist as a data constant, and the pending-reboot probe that G7 reuses.
- **`windows/isolatedReadiness.ts`**: G11's lease, DNS and proxy-TCP poll.
- **`windows/setupFlow.ts`**: the deep module. Its single entry point is `runWindowsSetup(deps, flags, signal) → WindowsSetupOutcome`. `deps` holds the host `PowerShellExec`, an executor factory, prompts, an output sink, a clock/sleep, the H1-resolved network and the discovered plans. The outcome is success, a failure (phase, step filename, classified error, credential ledger), or cancelled. The phase machine, the re-prompt loops, the cleanup rules and the fixed deadlines from [Define end-to-end orchestration and recovery](06-define-orchestration-and-recovery.md) are all exercised through this interface with fakes.
- **`windows/residualStateFooter.ts`**: queries Hyper-V after the failure and formats the footer. The command maps the outcome to exit code `1` or `130`.

Every Windows guest-facing module talks only to `WindowsGuestExecutor` and returns typed results. None of them shares code with `unix/mountShare`, `unix/reachabilityWait` or `unix/kvpDaemon`, whose semantics differ.

### Guest-harness graduation

`tests/guest/windowsGuestExec.ts` stops putting the password into `-Command`. It becomes a thin adapter over the production executor, and keeps its 20-minute OOBE wait and screenshot hint as test policy layered on the production readiness function. `tests/guest/windowsAmbientTrust.ts` is deleted in favor of `windows/trustReconciler.ts`. The PSModulePath repair then exists only in the shipped bridge.

### Implementation sequencing

1. **Restructure slice (no Windows code):** the `unix/` moves, `guestNetwork.ts`, `SetupAnswerPrompts` into `src/cliPrompt.ts`, the diff extracted into `hostTrustStore`, `listScripts` naming constants, and the test mirror. This slice must pass the unit, CLI and existing Unix guest tiers before Windows modules land.
2. Windows modules and the command.
3. **Harness adoption slice:** the harness switches to the production executor and the harness trust helper is removed. This happens after the executor exists and before the end-to-end Windows guest test.
