# Define end-to-end orchestration and recovery

Type: grilling
Blocked by: 03, 04, 05

## Question

What is the exact phase machine for a complete `setup-guest-windows` run, and what state is intentionally left after failure at each boundary?

Place preflight, reconciliation to the Default Switch, VM startup, PowerShell Direct readiness and elevation checks, ambient-trust propagation, setup-phase share access, pre-isolation scripts, `run-hosting` readiness, isolation, post-restart PowerShell Direct readiness, isolated-phase share access, and post-isolation scripts in an explicit order. Decide timeout and progress behavior, credential cleanup, whether any failure triggers rollback, and what rerunning from each possible residual state does.

The settled retry rule is a complete replay through the Default Switch, not phase detection or resume. The answer must say how that rule remains predictable when the VM begins off, running, already isolated, or left midway by a prior failure.
