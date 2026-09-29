# 17: Isolate the Windows guest and run post-isolation steps

**What to build:** The rest of the phase machine, G7 through G14. A successful run now takes the guest from the Default Switch to the selected Internal switch, proves the isolated network works, runs every post-isolation step, and prints a success summary. Every failure boundary leaves the residual state that ticket 06 defines, and the next run replays from it. This completes the command's behavior. See the spec's "Phase machine" and tickets 03 and 06.

- **G7, the isolation gate:** no pending-reboot marker (reusing the G3 probe; the remediation is "restart the guest, then rerun"), and the `run-hosting` listeners still bound.
- **G8:** replace the Internal-switch VM share credential and mark it unverified. It runs only after G7.
- **G9:** graceful stop within the Windows deadlines, confirm `Off`, connect the adapter to the selected Internal switch, and start. The VM is never force-stopped.
- **G10:** PowerShell Direct readiness with the same executor. An auth rejection here is structural and never re-prompts.
- **G11:** isolated-network readiness, polled for 3 minutes. It requires a DHCP lease in `run-hosting`'s subnet with the Internal-switch host IP as gateway, a successful DNS lookup through the host, and a TCP connection to the proxy stack. A timeout names the unmet condition and points at `run-hosting`.
- **G12:** establish and verify Internal-switch UNC share access. An auth failure unique to this address is structural: the command removes the unverified entry and requires a full rerun.
- **G13:** run the post-isolation steps from `\\<internal-switch-host-ip>\<share>\post-scripts`, then close the selected-share connection.
- **G14:** dispose the executor and print the success summary.

**Blocked by:** 16

**Status:** ready-for-review

- [x] Isolated-readiness unit tests name each unmet condition on expiry.
- [x] Unit tests of `runWindowsSetup` cover:
  - that the command never isolates with a pending reboot or with `run-hosting` gone;
  - G8 strictly after G7;
  - G10 auth rejection as structural;
  - the G12 structural failure removing only the unverified Internal-switch entry;
  - every residual-state row in ticket 06's table, each followed by a full replay from the Default Switch, including a replay starting from a completed guest;
  - the footer's credential ledger at each boundary.
- [x] The full acceptance checklist rows owned by the unit tier (ticket 08, rows 6–25) each have a passing test.
- [x] The unit and CLI tiers pass.
