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

**Status:** ready-for-review

- [x] Every native invocation in the shipped steps is followed immediately by a status check, and no nonzero install or upgrade status is accepted as success.
- [x] No shipped step writes under its UNC directory or references a persistent execution-policy change.
- [x] Each step succeeds when run twice in a row on the same guest. This is verified by hand through the harness executor on a golden-image guest here, and proven automatically by ticket 18's replay run.
- [x] The generated customization READMEs state the contract above.
- [x] The unit, CLI, and guest tiers pass.

## Implementation notes

- **Steps** (`templates/vm-shared-windows/`): all six shipped steps now check `$LASTEXITCODE` on the line right after every native call and `throw` a `NN-name: <operation> exited <status>` error. The single accepted nonzero status is WinGet's `-1978335212` (0x8A150014, no installed package matches) from the read-only `winget list --id <id> --exact --source winget` probe; it is named and commented in `01-install-packages` and `03-install-tools`. No step prompts, writes under `$PSScriptRoot`/the share, maps a drive, or mentions an execution policy or a new terminal.
- `01-install-packages`: the Store-pinning toggle, App Installer upgrade, and `upgrade --all` are gone. jq, Git, and GitHub CLI are probed first, then installed with `--exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity --source winget`. The process PATH is rebuilt from the persisted machine and user values (nothing written back) and each tool must resolve and exit `0` on `--version`.
- `02-install-pnpm`: bootstrap downloaded to a unique `%TEMP%` file, run in its own `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`, and removed in `finally` (a failed removal warns and then fails the step). Afterwards the persisted user `PNPM_HOME` and a persisted PATH entry under it are required, and pnpm must resolve under `PNPM_HOME` and exit `0` on `--version`.
- `03-install-tools`: requires pnpm first, checks every pnpm result, installs Claude Code with the exact-state-first WinGet pattern, then verifies `node`, `pi`, `claude`, `codex` against the refreshed persisted PATH. A reboot-required status is just another nonzero status.
- `01-auth-config`: validates `github-config.txt`, `credentials.json` (must be the managed Claude placeholder), and `auth.json` (chatgpt mode, placeholder refresh token, no API key) and that `git` and `gh` run, all before the first `git config`. `gh auth login --hostname github.com --git-protocol https --with-token` reads the token from stdin and `gh auth setup-git --hostname github.com` is checked. Both placeholder files are staged beside their destination and replaced with `File.Replace` (or `Move` on first install) on every replay. The token is never printed.
- `02-apply-home-jq-transforms`: requires `node` and `jq` first, invokes the transformer by its `$PSScriptRoot` path, and exits with its nonzero status.
- **READMEs**: `src/initEnv.ts` appends a "Windows steps" contract section (fresh elevated Windows PowerShell 5.1 with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, read-only UNC phase directory, no prompts, check every native exit code, idempotent because recovery replays everything, 30 minute limit) to both generated READMEs.
- **Live findings that changed the steps** (found by running each step twice through the harness executor on the golden-image guest):
  - `Fail "... exited $status: ..."` is a PowerShell parse error (`$status:` reads as a drive-qualified variable); the message uses `${status}`.
  - `[System.IO.File]::Replace(a, b, $null)` throws "path is not of a legal form" in Windows PowerShell 5.1 (`$null` becomes an empty string); the step passes `[NullString]::Value`.
  - The official pnpm bootstrap installs pnpm 12, whose `pnpm.exe` needs `vcruntime140.dll`. On the clean golden image `pnpm setup` dies with `0xC0000135` while the bootstrap still exits `0` and persists nothing, so pnpm silently did not install. `02-install-pnpm` therefore installs `Microsoft.VCRedist.2015+.x64` through WinGet first, only when `vcruntime140.dll` is absent. This is software beyond the list in the spec's "Shipped step changes"; it is a pnpm dependency, and the alternative (pinning pnpm to 11) would give up the floating-latest policy. Please confirm this decision.
- **Tests**: `tests/unit/templates.test.ts` gained a "shipped Windows steps meet the step contract" block (per-step native status check on the next line, no prompt/drive mapping/execution policy/new-terminal text, no writes to the UNC directory, plus per-step content assertions) and `tests/unit/initEnv.test.ts` asserts the README contract. The Pester-free rule stands: the `.ps1` behavior itself is proven by the guest run below.
- **Live verification**: through a throwaway harness on a fresh golden-image guest on the Default Switch (all five steps, each run twice in a row from the read-only UNC share with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, a share listing compared before and after): every run exited `0` and the share was unchanged. Two sandbox limits: `download.visualstudio.microsoft.com` is unreachable from this host's network, so the VC++ runtime files were seeded into the guest by the harness (the `Microsoft.VCRedist` install branch ran live and failed correctly on its network error with the status named, but has not been observed succeeding), and `gh` was a stub `gh.cmd` shim (ADR-0027's remaining substitution) because the token is fake. `nn-configure-network` was not re-run; it is unchanged since ticket 14 and its guest test covers it.
- **Tier results** (final tree): `pnpm format:check`, `pnpm lint` (eslint plus the `.ps1` parse check), and `pnpm typecheck` pass. Unit: 127 files, 1172 tests pass. CLI: 48 passed, 1 skipped. Guest: 5 files, 52 tests pass (Ubuntu roles and the Windows `windowsFresh` role, including `configure-network` on the reworked templates).
