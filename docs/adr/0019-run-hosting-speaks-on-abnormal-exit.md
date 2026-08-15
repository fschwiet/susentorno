# `run-hosting` speaks an audible alert on abnormal exit

`run-hosting` announces any abnormal exit — startup failures (Docker unavailable, an unreadable/invalid
config, a certificate error, a port conflict, a failed relaunch) as well as runtime crashes — by
speaking "susentorno is down" once through the native Windows **SAPI COM** voice
(`SAPI.SpVoice`), spawned as a detached PowerShell one-liner that Node does not wait on. A clean
shutdown (Ctrl-C/SIGINT, or SIGTERM) stays silent.

The operator normally works inside the guest and does not watch `run-hosting`'s host console, so an
unspoken failure — whether the proxy never started or died mid-session — goes unnoticed and looks
like a guest problem.

## Where this lives in the code

`run-hosting` sometimes runs as two processes (see [[loopback-publish-with-node-forwarder]]): on
Windows with forwarding enabled (the default), the invoked process relaunches through a dedicated
`node-copy-with-custom-firewall-rules.exe` copy and then only mirrors that child's exit code. Actual startup and runtime
failures happen inside whichever process reaches them — the relaunch parent for relaunch-mechanism
failures (can't copy/spawn the dedicated node.exe, child killed by signal), the child (or the sole
process, when there's no relaunch) for everything else: missing env paths, missing CA, an
Internal-switch adapter with no resolvable IPv4 address, gateway/DNS/DHCP bind failures, and every failure inside
`runHostingLoop` (unreadable credentials/allowlist, config build failure, Docker failing to start a
color, the proxy never becoming ready, or any other fatal error the loop's `fatal()` collapses to).

The alert is implemented as a single top-level choke point — wrapping the whole command action plus
`process.on('uncaughtException')`/`('unhandledRejection')` — rather than a call added at each of the
current ~8 early-exit sites. New failure sites are covered automatically without remembering to wire
each one up individually.

## Considered Options

- **A terminal BEL / a beep.** Rejected: a bare tone says neither what failed nor where it came
  from, so the operator still has to go looking — the confusion this is meant to remove.
- **The managed `System.Speech` synthesizer.** Rejected: it is dependency-free only under Windows
  PowerShell 5.1 (.NET Framework); under pwsh 7 / .NET it requires a NuGet package. SAPI COM depends
  only on the OS and works from any shell.
- **Alert on runtime crashes only, not startup failures.** Rejected: the operator does not watch
  startup either, so a proxy that fails to come up would still fail silently — precisely the case
  that prompted broadening the scope.
- **Both processes independently apply "non-zero exit code ⇒ speak" in the relaunch topology.**
  Rejected: most failures happen inside the relaunched child, and the parent just mirrors its exit
  code afterward — applying the rule in both places would speak the alert twice for one failure. The
  parent instead stays silent whenever `relaunchIfNeeded` reports a child actually ran
  (`relaunched: true`); it only speaks for failures in the relaunch mechanism itself, where no child
  ever started.
- **A call added at each known early-exit site.** Rejected in favor of one top-level wrapper: with
  calls scattered across the ~8 current early-return sites plus the loop's `fatal()`, any future
  failure path that forgets to call in stays silent. A wrapper around the whole action plus the
  process-level exception handlers catches everything, including failures nobody anticipated.
- **Treat SIGTERM as abnormal (unhandled), leaving Node's default abrupt termination.** Rejected:
  an external stop request (service manager, Windows shutdown) isn't a failure any more than Ctrl-C
  is. SIGTERM gets the same graceful, silent shutdown path as SIGINT.

## Consequences

- The alert is a general `run-hosting` behavior, independent of any one feature. It was introduced
  alongside host-run MCP servers ([[host-run-mcp-servers]]), whose all-or-nothing supervision makes
  a silent host-side failure especially costly, but it is not specific to them and fires for every
  abnormal exit ([[run-hosting-owns-hosting-lifecycle]]).
- In the relaunch topology ([[loopback-publish-with-node-forwarder]]), only one process ever speaks
  for a given failure: the process that actually reached the failure, never the parent merely
  mirroring a child's exit code.
- SIGINT and SIGTERM are both treated as clean, silent shutdowns; every other termination path is
  abnormal and speaks.
- Speaking is best-effort and bounded: the alert is spawned detached and unreferenced, so a failed
  or slow SAPI spawn cannot change, delay, or replace `run-hosting`'s original exit result. There is no
  confirmation that the speech was heard or even started.
- A single in-process guard ensures the alert speaks at most once per process, even if multiple
  failure signals fire in sequence (e.g. a caught fatal error followed by an `uncaughtException`
  during teardown).
- Windows-host-specific, consistent with the project's Hyper-V-only host target
  ([[hyper-v-only-target]]).
