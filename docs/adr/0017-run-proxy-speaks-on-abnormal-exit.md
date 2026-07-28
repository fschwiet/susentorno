# run-proxy speaks an audible alert on abnormal exit

`run-proxy` announces any non-clean exit — startup failures (Docker unavailable, an unreadable/invalid config, a certificate error, a port conflict) as well as runtime crashes — by speaking "Configamatron is down" once through the native Windows **SAPI COM** voice (`SAPI.SpVoice`), spawned as a PowerShell one-liner; a clean `Ctrl-C` shutdown stays silent. The operator normally works inside the guest and does not watch `run-proxy`'s host console, so an unspoken failure — whether the proxy never started or died mid-session — goes unnoticed and looks like a guest problem.

## Considered Options

- **A terminal BEL / a beep.** Rejected: a bare tone says neither what failed nor where it came from, so the operator still has to go looking — the confusion this is meant to remove.
- **The managed `System.Speech` synthesizer.** Rejected: it is dependency-free only under Windows PowerShell 5.1 (.NET Framework); under pwsh 7 / .NET it requires a NuGet package. SAPI COM depends only on the OS and works from any shell.
- **Alert on runtime crashes only, not startup failures.** Rejected: the operator does not watch startup either, so a proxy that fails to come up would still fail silently — precisely the case that prompted broadening the scope.

## Consequences

- The alert is a general `run-proxy` behavior, independent of any one feature. It was introduced alongside host-run MCP servers ([[host-run-mcp-servers]]), whose all-or-nothing supervision makes a silent host-side failure especially costly, but it is not specific to them and fires for every abnormal exit ([[run-proxy-owns-proxy-lifecycle]]).
- Speaking is best-effort and bounded: a failed or slow SAPI spawn must not change, delay, or replace `run-proxy`'s original non-zero exit result.
- Windows-host-specific, consistent with the project's Hyper-V-only host target ([[hyper-v-only-target]]).
