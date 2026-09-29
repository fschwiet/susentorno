# 11: Production PowerShell Direct executor, adopted by the guest harness

**What to build:** The credential-scoped `WindowsGuestExecutor` and its shipped bridge, as production code. The Windows guest-tier harness uses it in place of its current argv-built command, so the existing Windows guest test runs over the production transport and the guest password no longer appears in a process argument. See the spec's "PowerShell Direct boundary" and ticket 02, including its throwaway prototype.

This interface came from the prototype:

```ts
interface WindowsGuestExecutor {
  readonly vmName: string;
  invoke(script: string, options: { timeoutMs: number; signal?: AbortSignal }):
    Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  dispose(): Promise<void>;
}
```

- Each invocation starts a short-lived shipped bridge. Only the bridge path and the VM name go in argv. The credential and the base64 script go over stdin as one JSON request.
- The bridge repairs the Windows PowerShell 5.1 module path. It runs a fixed runner through `Invoke-Command -VMName`. The runner starts a guest child with `-NoProfile -NonInteractive -ExecutionPolicy Bypass` and a fixed encoded loader, and the script reaches the child over its stdin. The loader forces UTF-8 output and suppresses progress records.
- When a deadline expires, the guest child is killed and the invocation returns `exitCode: 124, timedOut: true`. A wedged bridge is force-killed after a small margin. An `AbortSignal` returns a cancelled outcome promptly while the bridge reaps the child. Transport, authentication, cancellation, deadline, and protocol failures are distinct typed outcomes, and all of them redact the request.
- `waitForPowerShellDirect(executor, { deadlineMs, onHeartbeat, signal })` returns ready or auth-rejected, and throws a typed transport, protocol, or timeout failure. Repeated bad credentials never turn into a timeout.
- The bridge template sits outside every VM-share template directory, so `update-shares` never weaves it into a guest share. It is resolved from the package root.
- The harness's Windows exec becomes a thin adapter over the production executor. It keeps its 20-minute OOBE wait and screenshot hint as test policy layered on `waitForPowerShellDirect`. The PSModulePath repair then exists only in the bridge.

**Blocked by:** 10

**Status:** resolved

- [x] Unit tests cover the bridge request protocol, result parsing, the classification of each typed failure, deadline and timeout handling, cancellation, and redaction. No test output or error contains the credential.
- [x] Readiness polling tells retryable not-ready apart from auth rejection, which is never retried into a timeout.
- [x] A packaged build includes the bridge, and `update-shares` does not copy it into any VM share.
- [x] The existing Windows guest-tier role passes using the production executor, and the harness no longer builds a `-Command` string containing the password.
- [x] The unit, CLI, and guest tiers pass.

## Implementation notes

- Production code: `src/guestSetup/windows/guestExecutor.ts` (`createWindowsGuestExecutor`, `waitForPowerShellDirect`, and a typed `WindowsGuestError` whose `kind` is `transport`, `authentication`, `protocol`, `deadline`, `cancelled`, or `timeout`) and the shipped bridge `templates/powershell/windowsGuestBridge.ps1`, resolved by `windowsGuestBridgePath()` in `src/templates.ts`.
- Bridge protocol: one JSON request on stdin (non-ASCII characters are written as unicode escapes); one JSON line back, either `{kind:'result',...}` or `{kind:'error', category, message}`. The bridge classifies a rejected credential from PowerShell Direct's `PSDirectException` raised in its credential exchange (locale-independent, verified live), keeping the English "credential is invalid" text only as a fallback. A remote terminating error is `protocol`. Every other connection failure is retryable `transport`. Anything else the bridge prints, or a nonzero exit without an envelope, is `protocol`.
- Host supervision: a wedged bridge is force-killed after the invocation deadline plus a 30-second margin (a `deadline` failure). An `AbortSignal` returns `cancelled` at once and leaves the bridge running. `dispose()` waits up to 30 seconds for such bridges, then force-kills them, and drops the credential.
- Redaction: every thrown message has the password, username, script and base64 script replaced with `[redacted]`, and is truncated to 2000 characters. Guest stdout and stderr in a completed result are returned as-is.
- `waitForPowerShellDirect` returns `auth-rejected` on the first authentication rejection and retries `transport` and `deadline` failures until its deadline (`timeout`).
- Harness: `tests/guest/windowsGuestExec.ts` is now a thin adapter (stdout and stderr merged into `stdout`, as the old execa-based exec did) plus the 20-minute OOBE wait and screenshot hint. `windowsFresh` gained live coverage of the executor: UTF-8 round trip, distinct streams, exit code, no CLIXML progress on stderr, guest-child kill at the deadline, and wrong-password `auth-rejected`.
- Packaging: `tests/cli/windowsGuestBridge.test.ts` checks that `pnpm pack --dry-run` lists the bridge and that `init` and `update-shares` never copy it into a share.
- Verification: format, lint, typecheck, unit (843 tests), CLI (38 passed, 1 skipped) and the `windowsFresh` guest role (18 tests) pass. A full guest-tier run passed 50 of 51 tests. The one failure was the Ubuntu `ambientTrust` test (openssl "certificate signature failure" in the guest). It passed when rerun alone, and it does not touch code changed here.
