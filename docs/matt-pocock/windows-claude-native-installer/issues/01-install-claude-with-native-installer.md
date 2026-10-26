# 01: Windows guest installs Claude Code with the native installer

**What to build:** When `susentorno setup-guest-windows` runs the shipped Windows tools pre-isolation step, Claude Code is installed or updated from Anthropic's official `https://claude.ai/install.ps1` bootstrap instead of the `Anthropic.ClaudeCode` WinGet package. The step then makes sure `claude` resolves from the guest user's persisted PATH. See the parent spec at `docs/matt-pocock/windows-claude-native-installer/spec.md` for the decisions.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] The step downloads `https://claude.ai/install.ps1` to a uniquely named file in the guest's temporary directory, never in the UNC phase directory. A download failure fails the step with a `03-install-tools:` message.
- [ ] The bootstrap runs in a child Windows PowerShell process that is noninteractive, uses no profile, and has a per-process execution-policy bypass. A nonzero exit fails the step. The guest's persistent execution policy is untouched.
- [ ] The temporary bootstrap file is removed in a `finally` block on success and failure alike. A removal failure is warned about and then fails the step. This matches the Windows pnpm step.
- [ ] The bootstrap runs on every setup, with no "already installed" probe.
- [ ] If the persisted user PATH has no `%USERPROFILE%\.local\bin` entry (compared case-insensitively, ignoring a trailing backslash), the step appends one. Repeated runs never duplicate it.
- [ ] The step's existing resolve-and-version checks for `node`, `pi`, `claude` and `codex` still run and pass. The Node, Pi and Codex installs are unchanged.
- [ ] The step no longer contains the WinGet lookup, the package-absent status constant, or the WinGet list/install helpers.
- [ ] The stale WinGet-specific Claude unit test, and the single `Anthropic.ClaudeCode` assertion in the broader Windows tools unit test, are deleted. No new script-content tests are added.
- [ ] `pnpm test:unit` passes.
- [ ] Handoff note: the maintainer verifies with the Windows `guest` tier end-to-end test. The implementing agent doesn't run it.
