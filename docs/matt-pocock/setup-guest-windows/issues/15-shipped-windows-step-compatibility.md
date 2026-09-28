# 15: Make shipped Windows steps noninteractive, replay-safe, and exit-checked

**What to build:** The shipped Windows pre-isolation and post-isolation steps meet the step contract. They are noninteractive and idempotent, check the exit status of every native call, and never write to the read-only UNC share. The command can then run them unattended and replay them safely. The generated customization READMEs document the same contract for customized steps. See the spec's "Shipped step changes" and ticket 09. `configure-network` and `verify-config.ps1` are covered by ticket 14.

- **All steps:**
  - A mutating native command succeeds only with exit `0`. Each step checks `$LASTEXITCODE` right after every native call and throws a step-specific error that names the operation and status. The only exception is a named, documented, read-only probe: WinGet's pinned "package absent" result.
  - Steps never prompt, never write to the share, never map drives, never change the persistent execution policy, and never rely on another step's session state.
  - Remove the "open a new terminal" messages.
- **`01-install-packages`:**
  - Remove the Store certificate-pinning bypass toggle, the App Installer self-upgrade, and `upgrade --all`.
  - For jq, Git, and GitHub CLI, check exact installed state first, then do an exact, silent, noninteractive install with agreements accepted from the `winget` source.
  - Refresh PATH from persisted values for the current process only, then verify that each tool resolves and reports a version.
- **`02-install-pnpm`:** download the official bootstrap to a unique temp file that is removed in `finally`. Verify that the persisted `PNPM_HOME` and PATH resolve pnpm and that `pnpm --version` exits `0`.
- **`03-install-tools`:**
  - Require pnpm first.
  - Check every pnpm result.
  - Install Claude Code with the exact-state-first WinGet pattern.
  - Verify `node`, `pi`, `claude`, and `codex`.
  - Treat a reboot-required result as failure.
- **`01-auth-config`:**
  - Validate `github-config.txt`, `credentials.json`, and `auth.json` before any mutation.
  - Check every `git config` call, `gh auth login` with the token on stdin and an explicit hostname and protocol, and `gh auth setup-git`.
  - Replace the Claude and Codex placeholders atomically on every replay. Never print the token.
- **`02-apply-home-jq-transforms`:** require `node` and `jq` first, invoke the transformer by its `$PSScriptRoot` path, and propagate a nonzero exit immediately.
- **Customization READMEs:** customized Windows `.ps1` steps run elevated in fresh Windows PowerShell 5.1 processes with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, from a read-only UNC phase directory. They must not prompt, must handle every native exit themselves, must be idempotent because recovery replays the complete flow, and have a 30-minute limit per step.

**Blocked by:** 14

**Status:** ready-for-agent

- [ ] Every native invocation in the shipped steps is followed immediately by a status check, and no nonzero install or upgrade status is accepted as success.
- [ ] No shipped step writes under its UNC directory or references a persistent execution-policy change.
- [ ] Each step succeeds when run twice in a row on the same guest. This is verified by hand through the harness executor on a golden-image guest here, and proven automatically by ticket 18's replay run.
- [ ] The generated customization READMEs state the contract above.
- [ ] The unit, CLI, and guest tiers pass.
