# Windows guest installs Claude Code with the native installer

Status: resolved

## Problem Statement

The shipped Windows tools pre-isolation step installs Claude Code from the `Anthropic.ClaudeCode` WinGet package. Anthropic's supported way to install Claude Code on Windows is the native installer: `irm https://claude.ai/install.ps1 | iex`. The Linux template already uses the matching native installer (`claude.ai/install.sh`), so the two platforms install Claude Code differently, and the Windows guest depends on a WinGet package instead of the official channel.

## Solution

The Windows tools pre-isolation step installs Claude Code by running the official `https://claude.ai/install.ps1` bootstrap, the same way the Windows pnpm step runs its official bootstrap. Each setup phase installs or updates to the current Claude Code release. The step makes sure the native install location is on the guest user's persisted PATH, so later steps and interactive sessions find `claude`. WinGet is no longer used for Claude Code.

## User Stories

1. As a susentorno user setting up a Windows guest, I want Claude Code installed through Anthropic's official native installer, so that the guest gets Claude Code from the supported channel.
2. As a susentorno user, I want the Windows and Linux templates to install Claude Code the same way, so that both guests behave alike.
3. As a susentorno user, I want each Windows guest setup to install the current Claude Code release, so that the guest follows the floating "current Claude Code" policy.
4. As a susentorno user, I want the setup to fail with a clear `03-install-tools` message if downloading the Claude bootstrap fails, so that I know why setup stopped.
5. As a susentorno user, I want the setup to fail with a clear message if the Claude bootstrap exits nonzero, so that a broken install never passes silently.
6. As a susentorno user, I want the temporary bootstrap file removed whether the install succeeds or fails, so that the guest keeps no leftover installer scripts.
7. As a susentorno user, I want a failure to remove the temporary bootstrap file reported as a step failure, so that cleanup problems are visible.
8. As a susentorno user, I want the bootstrap never staged in the read-only UNC phase directory, so that the step does not depend on that share being writable.
9. As a susentorno user, I want the bootstrap run noninteractively in its own Windows PowerShell process, so that unattended setup never stalls on a prompt and the bootstrap cannot end the step's own process.
10. As a susentorno user, I want the native install directory (`%USERPROFILE%\.local\bin`) added to my persisted user PATH when it is missing, so that `claude` resolves in later steps and in my own sessions.
11. As a susentorno user, I want that PATH entry added only once, so that repeated setup runs do not duplicate it.
12. As a susentorno user, I want the step's existing check that `claude` resolves on the persisted PATH and reports a version to keep working, so that a successful step means a usable Claude Code.
13. As a susentorno user, I want the guest's persistent execution policy left untouched, so that installing Claude Code does not weaken the guest's script policy.
14. As a susentorno maintainer, I want the Windows tools step to stop carrying WinGet helpers it no longer uses, so that the script stays small and readable.
15. As a susentorno maintainer, I want unit tests that only asserted on the WinGet Claude install removed, so that the suite does not pin script text that no longer exists.

## Implementation Decisions

- **Module changed:** only the shipped Windows tools pre-isolation step (`03-install-tools`). The Node runtime, Pi and Codex installs are unchanged, and so are the ordering and the final resolve-and-version checks for `node`, `pi`, `claude` and `codex`.
- **Bootstrap invocation:** follow the Windows pnpm step's established pattern rather than a literal `irm | iex`.
  - Download `https://claude.ai/install.ps1` to a uniquely named file under the guest's temporary directory.
  - Run it in a child Windows PowerShell 5.1 process with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`.
  - Fail if it exits nonzero.
  - Remove the file in a `finally` block. A cleanup failure is reported as a warning and then fails the step.
  - The source script is the same one the official one-liner runs. Only the invocation differs, so that the step gets an exit status and the bootstrap cannot end the step process.
- **Idempotency:** always run the bootstrap. There is no "already installed" probe, and this matches the Linux step.
- **PATH:** after the bootstrap, if the persisted user PATH has no `%USERPROFILE%\.local\bin` entry (compared case-insensitively, ignoring a trailing backslash), append it to the persisted user PATH. The existing process-PATH refresh and `claude` resolution check then run as before.
- **No WinGet for Claude Code:** remove the step's WinGet lookup, the package-absent status constant, and the WinGet list/install helpers. Nothing else in this step uses them. The other Windows steps keep their own WinGet use.
- **No migration:** these steps run on clean Windows installs, so the step does not detect, remove or work around an existing `Anthropic.ClaudeCode` WinGet install.
- **Network:** the step runs during the setup phase with general network access, so the proxy allow/auth lists do not change.
- Consistent with [[shipped-guest-templates-carry-only-requirements]]: Claude remains a required shipped tool; only its install channel changes.

## Testing Decisions

- Good tests here exercise real guest behavior: Claude Code ends up installed, resolves from the persisted PATH, and reports a version. They don't assert on the script's text.
- **Seam:** the existing `guest` tier Windows end-to-end test, which runs the shipped Windows pre-isolation steps on a real Hyper-V guest. It already covers this step, including the `claude` resolve-and-version postcondition. No new seam or new test is needed.
- **Unit tier:** delete the stale WinGet-specific Claude test in the template unit tests, and the single `Anthropic.ClaudeCode` assertion inside the broader Windows tools test. Leave the other template-content tests unchanged; removing them is a separate decision.
- The implementing agent runs `pnpm test:unit`. The maintainer runs the Windows `guest` tier, because its prerequisites (Hyper-V, elevation, Docker, a Windows ISO, and a golden-image build that can take 60–120 minutes) are a human call.
- Prior art: the Windows pnpm step's bootstrap handling and its persisted-PATH verification.

## Out of Scope

- Detecting or removing a WinGet-installed Claude Code, or stale copies on an existing guest.
- Changing how Pi, Codex, Node, pnpm, or the WinGet-installed packages in other Windows steps are installed.
- Removing or rewriting the other template script-content unit tests.
- Updating historical specs and issues under `docs/matt-pocock`, including the setup-guest-windows issue that names `Anthropic.ClaudeCode`.
- Pinning a Claude Code version.

## Further Notes

- The repo doesn't show whether the native Windows installer saves `%USERPROFILE%\.local\bin` to the user PATH itself. The idempotent PATH step works either way, and the `guest` tier run confirms the result.
- The download, child-process run and cleanup pattern is deliberately duplicated from the pnpm step rather than extracted into a shared helper. With two call sites, a shared sibling file dot-sourced from the UNC phase directory, plus a new isolated test seam, would cost more than it saves. The failure that matters (real installer behavior) is visible only at the `guest` tier. Revisit with its own spec if a third step needs a bootstrap.
