# Prototype the secure PowerShell Direct boundary

Type: prototype
Status: resolved
Blocked by: 01

## Question

What production boundary should execute PowerShell inside the named guest through PowerShell Direct using the prompted local-administrator credential?

Build only enough throwaway code and tests to compare viable invocation shapes. The chosen shape must not expose the plaintext password in process arguments, logs, errors, durable host files, or durable guest files; must safely carry arbitrary UTF-8 scripts without nested-quoting failures; and must return trustworthy stdout, stderr, and exit status with bounded waits, cancellation, and useful errors while the VM starts and restarts.

Use the existing guest-harness `WindowsGuestExec` and its PowerShell 5.1 module-path workaround as evidence, not automatically as the production interface. Record the selected credential lifecycle, script transport, readiness probe, timeout behavior, cleanup guarantees, and interface that later orchestration can depend on. Link the prototype asset from the answer rather than treating it as production code.

## Answer

Use a **short-lived stdin bridge per invocation**, represented to orchestration by a credential-scoped `WindowsGuestExecutor`. The [throwaway boundary prototype](../prototypes/powershell-direct-boundary/README.md) compares this with the current argv-built harness command and a persistent framed session. A live run against a Windows 11 Enterprise Evaluation x64 VM authenticated through PowerShell Direct with an elevated token and verified arbitrary UTF-8 transport, distinct stdout and stderr, exit code 23, and guest-child termination at the internal deadline.

### Credential lifecycle

The command creates one executor after the masked guest-password prompt and disposes it in `finally` after the last guest operation. Its username and password are private in-memory state. Every invocation starts `powershell.exe -File <shipped-bridge>` with only the bridge path and VM name in argv, then writes one JSON request containing the credential and base64 script to stdin. The bridge repairs the Windows PowerShell 5.1 module path before `ConvertTo-SecureString`, constructs a `PSCredential`, clears request references in `finally`, and exits after that invocation. Secrets never enter argv, logs, errors, or host/guest files. Do not retain a persistent PSSession: its small authentication saving does not justify longer credential retention or stale-session recovery.

### Script transport and result

The bridge calls `Invoke-Command -VMName` with a fixed runner. The runner starts a guest `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` child. A fixed UTF-16LE encoded loader is its only encoded-command argument; the arbitrary guest script crosses host stdin as UTF-8/base64, crosses PowerShell Direct as a string argument, and crosses guest-child stdin as base64. No temporary guest file or nested user-script quoting is involved, and execution policy changes only for that child.

The child process is the unit of execution, so its process exit code and separately redirected stdout/stderr are authoritative. The loader fixes console output to UTF-8 and suppresses progress records; live testing found that module-loading progress otherwise polluted redirected stderr as CLIXML. A completed nonzero exit is a result, not a transport exception. Transport failure, authentication failure, caller cancellation, deadline expiry, and bridge/protocol failure are distinct typed failures or outcomes and must redact the request.

### Readiness, deadlines, and cancellation

PowerShell Direct readiness is the same boundary invoked with a small constant probe, retried every few seconds under one orchestration-owned overall deadline. Classify failures as retryable transport/not-ready, authentication rejection, or nonretryable bridge/protocol failure; never turn repeated bad credentials into a readiness timeout.

Every invocation requires an explicit deadline. The guest runner waits only to that deadline, kills the guest child on expiry, drains both streams, and returns exit code 124 with `timedOut: true`. Host waiting has a small additional cleanup margin and force-kills a wedged bridge after it. An `AbortSignal` returns a cancelled outcome promptly but leaves the supervised bridge alive until its existing internal deadline has reaped the guest child; executor disposal waits boundedly for that cleanup. Normal completion, timeout, and cooperative cancellation close processes and pipes, drop credential references, and leave no files. Abrupt host termination cannot guarantee guest-child reaping, so cleanup is bounded and supervised rather than transactional.

### Interface for later orchestration

```ts
interface WindowsGuestExecutor {
  readonly vmName: string;
  invoke(
    script: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  dispose(): Promise<void>;
}
```

The executor owns transport and credential handling only. Script discovery, acceptable exit codes, retries of provisioning steps, reboot orchestration, progress presentation, and diagnostic retention belong above this boundary.
