# 12: `setup-guest-windows` command through guest structural checks

**What to build:** The first user-runnable slice of `susentorno setup-guest-windows`. The thin command and the deep `runWindowsSetup` phase machine run phases H1, H2, H3, G1, G2, and G3 from the spec. A user can run the command against a real VM and be told either that the guest passes every prerequisite or exactly which prerequisite failed. Because provisioning phases don't exist yet, a run that passes G3 ends with a clear failure saying that the remaining phases are not implemented. See the spec's "Command contract", "Phase machine", and "Module boundaries".

- **Command:** registers the non-secret options with their defaults (`--isolation-name`, `--nat-adapter-alias`, `--vm-name`, `--guest-username`, `--share-name`, `--share-account`) and the help text required by ticket 01. It has no password options.
- **H1:** host elevation, the environment and its Windows VM share, isolation name, adapter alias, both switches, and both host IPv4 addresses are resolved and validated before any prompt. Then the command prompts for a missing VM name and share name.
- **H2:** the Windows host preflight checks the VM exists, is `Running` or `Off`, and has exactly one adapter attached to the Default Switch or the selected Internal switch. It checks the named SMB share resolves to this environment's Windows VM-share directory, and the `run-hosting` DHCP and DNS listeners are bound.
- **H3:** the paired `Guest username` and masked `Guest password` prompt.
- **G1:** reconciles the VM to the Default Switch through the existing VM reconciliation, passing the Windows stop deadlines (about 3 minutes, then 60 seconds to confirm `Off`, never a force-stop). A VM already running on the Default Switch is reused.
- **G2:** PowerShell Direct readiness has a 5-minute deadline and a 15-second heartbeat. An auth rejection disposes the executor and repeats the paired prompt, including a username that came from a flag. EOF exits cleanly.
- **G3:** the guest structural checks:
  - the supported guest platform allowlist (`Windows 11 | Enterprise | x64 | 25H2`, with Enterprise Evaluation accepted);
  - an enabled local Administrators member;
  - an elevated token;
  - no standard pending-reboot marker;
  - a discoverable, usable WinGet with a usable source.

  Pin the supported WinGet version from the current golden image. The pending-reboot probe is a reusable function, because G7 will call it again.
- **Output and outcome:**
  - Each phase announces itself as `setup-guest-windows: <phase>...`.
  - The outcome is success, failure (with phase, step filename, and classified error), or cancelled.
  - The residual-state footer queries Hyper-V after a failure for the VM's actual power state and switch, and ends with the instruction to rerun.
  - The command maps a failure to exit code `1` and a cancellation to `130`.
  - Ctrl+C aborts the in-flight invocation, cleans up within about 30 seconds, prints the footer, and exits `130`. A second Ctrl+C exits immediately.
  - The executor is always disposed.

**Blocked by:** 11

**Status:** ready-for-agent

- [ ] A new elevated CLI-tier test covers:
  - the help text (PowerShell Direct, the switch move, both phases, elevation, `run-hosting`);
  - every non-secret option, and `--guest-password` and `--share-password` rejected as unknown options;
  - an invalid or unresolvable isolation name, and a missing environment or Windows VM share, failing with no prompt;
  - a nonexistent `--vm-name` failing before `Guest password`;
  - EOF at `Hyper-V VM name` exiting cleanly.
- [ ] Unit tests of `runWindowsSetup` with fakes cover:
  - phase order and prompt order;
  - flag suppression and defaults;
  - the guest paired re-prompt loop and its EOF exit;
  - structural failures that never re-prompt;
  - each accepted and rejected starting state;
  - the Windows stop deadlines passed to reconciliation;
  - fixed deadlines against a fake clock;
  - announcements and heartbeats;
  - cancellation, including the second Ctrl+C;
  - executor disposal.
- [ ] Focused unit tests cover the host preflight rules, the platform allowlist and pending-reboot probe, the answer resolution and generic paired-credential prompt, footer formatting, and the outcome-to-exit-code mapping, including a non-elevated host failing first.
- [ ] A failure names the prerequisite and the relevant VM, switch, adapter, share, account, or address, with a remediation. No secret appears in any output.
- [ ] The unit and CLI tiers pass.
