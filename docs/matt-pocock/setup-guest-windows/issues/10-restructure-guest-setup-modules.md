# 10: Restructure guest setup into shared and Unix modules

**What to build:** A behavior-preserving prefactor that makes room for the Windows setup path without adding any Windows code. `setup-guest-unix` behaves exactly as before. Host-side modules that both platforms will use stay at the top of the guest setup area. Unix-only modules move into a `unix/` subdirectory with their names unchanged. See the spec's "Module boundaries" and ticket 07's layout table.

- `resolveGuestNetwork` and its result and failure types move out of the Unix command into a shared guest-network module. The hint text is unchanged.
- The `SetupAnswerPrompts` type moves into the CLI prompt module. The Unix answer functions move under `unix/`.
- Script discovery takes a naming parameter with two exported constants. `UNIX_STEP_NAMING` is `.sh`, case-sensitive, as today. `WINDOWS_STEP_NAMING` is `.ps1` with a case-insensitive extension. Sorting is explicitly ordinal. `GuestScript` remains the shared discovered-step representation.
- The pure SHA-256 diff and fingerprint normalization (`diffAmbientCandidates`) are extracted from Unix ambient trust into the shared host trust store module, and Unix re-imports them.
- The unit tests mirror the new layout: shared, `unix/`, and `windows/`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] No shared module gains a platform flag or platform branch.
- [ ] Unix module names and exported symbols are unchanged; only their locations move.
- [ ] Discovery with `WINDOWS_STEP_NAMING` matches `NN-name.ps1` with a case-insensitive extension, ignores non-matching files and directories, and orders ordinally. Unit tests cover this.
- [ ] Discovery with `UNIX_STEP_NAMING` behaves exactly as before.
- [ ] The unit, CLI, and existing Unix guest tiers pass.
