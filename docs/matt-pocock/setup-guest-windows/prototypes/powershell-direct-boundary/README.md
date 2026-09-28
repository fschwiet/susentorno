# THROWAWAY: PowerShell Direct boundary prototype

This prototype compares invocation shapes for [Prototype the secure PowerShell Direct boundary](../../issues/02-prototype-secure-powershell-direct-boundary.md). It is evidence, not production code.

Run the transport checks on a Windows host:

```powershell
node .\docs\matt-pocock\setup-guest-windows\prototypes\powershell-direct-boundary\prototype.test.mjs
```

Run the demo:

```powershell
node .\docs\matt-pocock\setup-guest-windows\prototypes\powershell-direct-boundary\prototype.mjs
```

The automated checks use `-Local` because no Hyper-V VM is required. Remove `local: true` and supply `vmName` plus a real credential to exercise the same bridge through `Invoke-Command -VMName`.

## Shapes compared

| Shape | Verdict | Reason |
| --- | --- | --- |
| Build one `powershell.exe -Command` string containing `ConvertTo-SecureString '<password>'` and a base64 guest script (the current guest harness) | Reject | Script quoting is safe, but the plaintext password is observable in the host process command line, errors can only be merged, and host command-line length limits remain. |
| Start a fresh host `powershell.exe -File <shipped bridge>` per call and send one JSON envelope on stdin | Select | The fixed argv contains no credential or guest script. The bridge keeps the credential in process memory, uses PowerShell Direct, and sends the script to a guest child PowerShell over stdin. The child gives real, separate stdout/stderr and a process exit code. |
| Keep one host PowerShell process/session alive and exchange framed requests | Reject for v1 | It can amortize authentication and make cancellation messaging richer, but adds framing, desynchronization, stale-session, credential-retention, and restart complexity without a demonstrated setup-time need. |

## What the prototype demonstrates

- The guest script round-trips awkward quotes, backticks, dollar signs, newlines, BMP and supplementary Unicode without nesting it in a command string.
- The child `powershell.exe` returns its actual exit code while stdout and stderr stay separate.
- An internal deadline terminates the child and returns a stable timeout result.
- Username, password, and script do not appear in host process arguments.
- `-ExecutionPolicy Bypass` applies only to the guest child process.
- No host or guest temporary file is created. The checked-in bridge contains no secret.
- The PowerShell 5.1 module-path repair occurs before credential construction.

A live run against `sus-test` (Windows 11 Enterprise Evaluation x64) authenticated through PowerShell Direct with an elevated token and demonstrated UTF-8 round-tripping, separate stdout/stderr, exit code 23, and guest-child termination at the internal deadline. The live run exposed PowerShell module-loading progress records polluting redirected stderr as CLIXML; setting `$ProgressPreference = 'SilentlyContinue'` in the fixed loader removed that pollution. A production guest-tier acceptance test must preserve this coverage.

## Boundary consequences to validate with the human

The proposed production interface is a short-lived credential-scoped executor:

```ts
interface WindowsGuestExecutor {
  readonly vmName: string;
  invoke(script: string, options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  dispose(): void;
}
```

`createWindowsGuestExecutor` copies the prompted password into private executor state; the command disposes the executor in `finally` immediately after its last guest operation. Each `invoke` starts a fresh bridge process and writes the credential request to stdin. Readiness is the same operation with a tiny constant script, retried under an overall deadline. Transport/unavailable, authentication, cancellation, timeout, and completed nonzero exit are distinct outcomes.

The prototype supports a strong cleanup guarantee for normal completion and internal timeout: pipes and processes are closed, memory references are dropped, and there are no temporary files. On caller cancellation, production should return a cancelled outcome promptly but leave the supervised bridge alive until its already-bounded internal deadline reaps the guest child; `dispose()` waits for that cleanup. It may force-kill the bridge only after that deadline. Abrupt host termination still cannot guarantee that a guest child is reaped, so cancellation cleanup is bounded and supervised, not transactional.
