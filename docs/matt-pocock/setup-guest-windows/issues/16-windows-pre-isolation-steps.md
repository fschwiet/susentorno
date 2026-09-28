# 16: Run Windows pre-isolation steps in the setup phase

**What to build:** Step plans are discovered and validated before either password prompt (H2), and phase G6 runs every pre-isolation step. A command run now provisions the guest on the Default Switch, and a failed step is reported by phase and filename with its captured output. See the spec's "Step runner" and ticket 04.

- **Plan (H2):** discover both phase directories from the host's generated Windows VM share with the Windows step naming. Require exactly one step whose slug is exactly `configure-network`. Zero or several matches are a structural generated-share error reported before any secret prompt.
- **Runner:** each step is one executor invocation with a 30-minute deadline. A fixed wrapper:
  - sets `$ErrorActionPreference = 'Stop'`;
  - sets the working directory to `\\<default-switch-host-ip>\<share>\pre-scripts` with `Set-Location -LiteralPath`;
  - invokes the step path, passed as data, with the call operator;
  - passes `-HostIp <internal-switch-host-ip>` only to the `configure-network` step.
- **Results:**
  - `0` is the only success. The runner never infers failure from a stale `$LASTEXITCODE`.
  - A nonzero exit, a timeout, a cancellation, and a transport failure are classified separately, each naming the phase and filename.
  - The runner fails fast and never retries a step.
- **Output:** the phase and filename are announced before each step. stdout and stderr are captured separately with an 8 MiB ceiling each, keeping the head and tail with a truncation marker, and are emitted afterwards. Nothing spills to a file.
- After the phase, the command closes its selected-share connection and keeps the credential.
- The Windows runner is separate from the Unix pre- and post-script runners.

**Blocked by:** 13, 14

**Status:** ready-for-agent

- [ ] Plan unit tests cover a valid plan, no `configure-network`, several `configure-network` steps, a slug that merely contains `configure-network`, repeated numeric prefixes, and ignored non-matching files.
- [ ] Runner unit tests cover the wrapper's construction (the path is never interpolated into source, and only `configure-network` gets `-HostIp`), each result classification, the capture ceiling and truncation metadata, and fail-fast.
- [ ] Unit tests of `runWindowsSetup` cover plan failure before either secret prompt, G6 after G5, the step deadline, and the residual-state row for a G6 failure.
- [ ] The unit and CLI tiers pass.
