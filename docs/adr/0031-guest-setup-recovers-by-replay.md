# Guest setup recovers by replaying from the setup phase, never by resuming or rolling back

Both guest setup commands recover from any failure the same way: rerun the command. A rerun returns the guest to the Default Switch and runs the whole flow from the start, every shipped and customized step included. Nothing is rolled back and no completed phase is detected or skipped. Each failure boundary leaves a nameable, observable state, and every one of those states is a valid starting point for the next replay, so one recovery path covers all of them.

## Considered Options

- **Phase detection and resume in place**, **rollback on failure**, and **a separate cleanup mode** were rejected in favor of the one recovery path that converges from every residual state.

## Consequences

- Every pre- and post-isolation step, shipped or customized, must be idempotent; the generated step READMEs state this.
- Rerunning an already-isolated guest briefly reattaches it to the internet-facing Default Switch.
- `setup-guest-windows` never reboots the guest. A pending reboot at G3 or G7 fails with "restart the guest, then rerun". The only sanctioned extension is a controlled Default-Switch reboot followed by replay of the complete pre-isolation plan, if a supported installer proves one unavoidable.
- On failure, Windows setup removes only the VM share credentials this run wrote but did not verify. Its residual-state footer queries Hyper-V rather than inferring state.
