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

**Status:** ready-for-agent

- [ ] Unit tests cover the bridge request protocol, result parsing, the classification of each typed failure, deadline and timeout handling, cancellation, and redaction. No test output or error contains the credential.
- [ ] Readiness polling tells retryable not-ready apart from auth rejection, which is never retried into a timeout.
- [ ] A packaged build includes the bridge, and `update-shares` does not copy it into any VM share.
- [ ] The existing Windows guest-tier role passes using the production executor, and the harness no longer builds a `-Command` string containing the password.
- [ ] The unit, CLI, and guest tiers pass.
