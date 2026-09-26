# Define Windows script-runner semantics

Type: grilling
Blocked by: 02, 03

## Question

What exact discovery and execution contract should apply to Windows pre-isolation and post-isolation scripts?

Decide the numbered `.ps1` filename rule and ordering; how the woven `configure-network` step is identified and receives the Internal-switch host IP; the working directory and UNC invocation form; whether each script gets a fresh process so environment changes such as PATH are visible; how per-process `-ExecutionPolicy Bypass` is applied; how native and PowerShell failures become one reliable exit result; what output is streamed or captured; and when the sequence stops.

The answer must cover shipped and customized scripts, preserve the requirement that retries are safe only when customization inputs are idempotent, and identify any invariants that the existing generic Unix-only `listScripts`, `runPreScripts`, and `runPostScripts` interfaces should or should not share.
