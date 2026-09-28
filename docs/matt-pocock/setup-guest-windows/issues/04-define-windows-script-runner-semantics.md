# Define Windows script-runner semantics

Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

What exact discovery and execution contract should apply to Windows pre-isolation and post-isolation scripts?

Decide the numbered `.ps1` filename rule and ordering; how the woven `configure-network` step is identified and receives the Internal-switch host IP; the working directory and UNC invocation form; whether each script gets a fresh process so environment changes such as PATH are visible; how per-process `-ExecutionPolicy Bypass` is applied; how native and PowerShell failures become one reliable exit result; what output is streamed or captured; and when the sequence stops.

The answer must cover shipped and customized scripts, preserve the requirement that retries are safe only when customization inputs are idempotent, and identify any invariants that the existing generic Unix-only `listScripts`, `runPreScripts`, and `runPostScripts` interfaces should or should not share.

## Answer

Treat each woven `.ps1` file as one **Windows provisioning step** and each phase directory as an immutable execution plan. Shipped and customized steps have the same execution and failure contract; the runner does not compensate for a customized step that is interactive, non-idempotent, or careless with native exit codes.

### Discovery and plan validation

Discover steps from the host's generated Windows VM-share directories before guest execution. A runnable filename matches `NN-name.ps1`, case-insensitively for the extension, where `NN` is exactly two decimal digits and `name` is non-empty. Sort matching filenames with ordinal filename ordering. Repeated numeric prefixes are permitted because the complete woven filenames still give a deterministic order. Ignore nonmatching files and directories so they remain available as sibling resources.

Parse the slug from the portion between `NN-` and `.ps1`. Before starting the pre-isolation sequence, require exactly one step whose slug is exactly `configure-network`; zero or multiple matches are structural generated-share errors. Names that merely contain that slug do not match. Invoke only that step with the named argument `-HostIp <Internal-switch host IP>`; every other pre-isolation step and every post-isolation step receives no runner-supplied arguments.

### Per-step process contract

Invoke each step through one fresh `WindowsGuestExecutor` request. The executor's already-settled guest child process supplies Windows PowerShell 5.1 with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`; no persistent execution-policy setting is changed. PowerShell Direct must provide the guest user account's elevated administrative token, including for steps without `#Requires -RunAsAdministrator`.

The fixed invocation wrapper must:

1. set `$ErrorActionPreference = 'Stop'`;
2. use `Set-Location -LiteralPath` to make the selected phase's UNC directory the working directory;
3. construct the step path as data and invoke it with the call operator, never interpolate it into executable PowerShell source; and
4. pass the named host-IP argument only for the exact `configure-network` match.

The UNC path is `\\<phase-host-ip>\<share-name>\pre-scripts` during the setup phase and `\\<phase-host-ip>\<share-name>\post-scripts` during the isolated phase. No drive mapping or local script copy is created. A fresh process for every step prevents session-state leakage and makes machine/user environment updates from a prior step visible naturally. The runner does not synthesize PATH entries or compatibility environment variables. Scripts should use `$PSScriptRoot` for sibling resources when that is clearer than relying on the guaranteed phase working directory.

### Unified result and failure semantics

Exit code `0` is the only successful step result. The wrapper converts an uncaught terminating PowerShell error into a nonzero process exit. An explicit script `exit N` remains authoritative. The runner reports ordinary nonzero exit, deadline expiry (`exitCode: 124` with `timedOut: true`), cancellation, and transport/authentication/protocol failure as distinct classifications, always naming the phase and filename.

Windows PowerShell 5.1 does not reliably promote native executable failures to PowerShell exceptions. Each script must therefore inspect native exit status and explicitly throw or exit nonzero for statuses it considers failures. A script may explicitly accept documented idempotent native outcomes. The runner must not infer failure from a stale `$LASTEXITCODE` after a script otherwise returns successfully, because an earlier native status may have been deliberately accepted. This requirement applies equally to shipped and customized steps and must be stated in customization documentation.

Before starting the next step, capture stdout and stderr separately. Each stream has an 8 MiB in-memory ceiling per step; continue draining beyond the ceiling and retain head and tail with an explicit truncation marker and metadata. Do not spill output to a durable file. Announce the phase and filename before invocation, then emit the captured streams with the same context. On failure, include the bounded output in the command diagnostic while preserving the executor's credential redaction guarantees.

Stop the sequence immediately on the first nonzero result, timeout, cancellation, or transport failure. Never retry an individual step automatically. Recovery is the command's full-flow replay from the Default Switch, which reruns every shipped and customized step. The prompts and customization documentation must consequently state that customization inputs are required to be idempotent.

### Shared and platform-specific boundaries

Generalize `listScripts` only enough to share the pure discovery model across platforms: directory, expected extension, filename, host path, parsed slug, and ordinal ordering. The filename shape and phase progress callback are also shared invariants.

Keep Windows execution separate from the existing Unix `runPreScripts` and `runPostScripts`. UNC construction, PowerShell invocation, named parameters, fresh-process behavior, output classification, and Windows failure semantics are not useful branches in Unix runners. The Unix interfaces should preserve their current behavior while a Windows-specific phase runner consumes the shared discovered-step representation.

The audit found that several shipped Windows steps currently invoke native commands without consistently checking their exit status, and their fresh-process/package-readiness assumptions have not been proven. [Define shipped Windows step compatibility changes](09-define-shipped-windows-step-compatibility.md) resolves those adaptations after the ambient-trust design is settled.
