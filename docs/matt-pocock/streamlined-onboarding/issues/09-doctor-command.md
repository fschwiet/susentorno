# `susentorno doctor`: check inventory, output shape, exit codes

Type: grilling
Status: open
Blocked by: 06

## Question

What does the check-only surface report, and how?

Settled while charting: the ensure logic is a shared module called by both setup-guest commands, and
it is *also* exposed as a check-only command so a user can diagnose without touching a VM. The name
`doctor` is provisional — confirming or replacing it is part of this ticket.

It exists because the ensure chain, by design, hard-fails one prerequisite at a time in the middle of
a guest setup. A user starting from nothing should be able to see the whole list of what they are
missing before they begin, rather than discovering it across several failed runs.

Questions a resolution must settle:

- **Check-only, strictly?** The charting decision says it creates nothing. Confirm that a
  `--fix` or `--ensure` flag is not wanted, or say why it is.
- **What it covers.** The full ticket-06 inventory, plus the things preflight already checks
  (`src/guestSetup/preflightChecks.ts`: VM exists, exactly one adapter, both switches resolve,
  `run-hosting` bound on 53 and 67). But VM-scoped checks need a VM name, which a bare `doctor` does
  not have — unless ticket 08's guest record supplies one. Decide whether `doctor` is
  environment-scoped only, or optionally guest-scoped.
- **`run-hosting`'s place in the output.** Per the map's Notes it stays a user-started foreground
  command, so `doctor` reports whether it is up but never starts it. Since the documented path is
  permanently two terminals, this is the one line users will read most often; it should say which
  terminal to start it in and with what.
- **Output shape.** A pass/fail list, and whether it shows passing checks or only failures. Existing
  commands print single-line summaries prefixed with the command name
  (`delete-host-network: removed N firewall rule(s)…`); a multi-check report is a new shape for this
  CLI and should be chosen deliberately.
- **Exit codes.** Existing commands set `process.exitCode = 1` on failure. Whether `doctor`
  distinguishes "everything fine", "manual steps outstanding", and "could not determine" is worth
  deciding, since this is the command most likely to be scripted.
- **Whether it reports the same strings the ensure chain fails with.** Two wordings for one
  condition is how documentation drifts — the same drift that left `setup-environment.md` naming
  `create-host-network` where it meant `init`.
