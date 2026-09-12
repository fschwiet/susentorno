# `run-hosting` speaks an audible alert on abnormal exit

`run-hosting` speaks “susentorno is down” through Windows SAPI when startup fails or the process exits abnormally. The operator normally works inside a guest rather than watching the host console, so an audible, named alert distinguishes a failed proxy stack from an unexplained guest network problem. SIGINT and SIGTERM are deliberate shutdowns and remain silent.

## Considered Options

- **Use a terminal bell or generic beep.** Rejected because it identifies neither the failed service nor the host on which attention is required.
- **Use `System.Speech`.** Rejected because it requires an additional package under PowerShell 7, whereas the native SAPI COM voice is available on the supported Windows host.
- **Add alerts at individual failure sites.** Rejected in favor of a command-level nonzero-exit check plus uncaught-exception handlers, so new failure paths inherit the behavior.

## Consequences

- The dedicated-node relaunch topology emits at most one alert: the child reports failures it reaches, while the parent speaks only when relaunch itself fails before a child runs.
- Speech is best-effort, detached, and guarded to run at most once per process. It cannot delay or replace the original exit result.
