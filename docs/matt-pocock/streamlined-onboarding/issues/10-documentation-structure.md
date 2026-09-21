# Documentation structure after the change

Type: grilling
Status: open
Blocked by: 04, 05, 06, 07

## Question

What do the setup documents become once the machine and environment layers are ensured rather than
walked through by hand?

Today the user traverses `README.md` (host prerequisites) → `setup-machine.md` →
`setup-environment.md` → `setup-guest.md` → `diagnostics.md`, each ending with a "Next step" link.
The request that opened this effort was that a user should be able to start at guest setup.

**Evidence the three-way split has already drifted**, found while charting — `setup-environment.md`
contains two wrong commands:

- Under "Initialize the environment's directory" it says `susentorno create-host-network` where it
  means `susentorno init`.
- Under "Run the environment" it says `susentorno write-github-config` where it means
  `susentorno run-hosting`.

Both are copy-paste errors that survived because the same command names appear across three
documents with no single place that is authoritative. Whatever structure this ticket chooses should
make that class of error harder, and the resolution should say how.

Questions a resolution must settle:

- **What survives.** Do `setup-machine.md` and `setup-environment.md` disappear, become reference
  appendices for the manual steps that hard-fail, or stay as-is with `setup-guest.md` promoted to
  the entry point?
- **Where the manual prerequisites are documented.** Ticket 06's detect-and-fail list is exactly the
  set a user must do by hand. Those need one authoritative home that the error messages can point
  at — ideally by stable anchor, so an error can name the section.
- **Windows and Ubuntu in one document or two.** `setup-guest.md` currently interleaves both,
  alternating "**Ubuntu guest** —" and "**Windows guest** —" paragraphs. Once both platforms have a
  single driving command the asymmetry shrinks, but tickets 04 and 05 may leave real differences.
- **What happens to the manual fallback.** `setup-guest.md` carries a `<details>` block reproducing
  every step `setup-guest-unix` performs, for diagnosis. It is genuinely useful and genuinely the
  thing most likely to rot. Decide whether it survives, and if so what keeps it honest.
- **The VM-creation walkthrough.** Ruled out of scope for automation, so it stays prose — but it is
  the bulk of `setup-guest.md` §1 and will dominate a document meant to be the entry point. Consider
  splitting it out so the entry point is short.
- **`diagnostics.md`'s relationship to `doctor`** (ticket 09). If a command now reports what is
  wrong, the document that told you how to check by hand may be largely superseded.

Blocked by tickets 04, 05, 06 and 07 because the documentation cannot be restructured until the
Windows flow, the ensure inventory, and the environment lookup rule are all settled. Ticket 08 is
deliberately not a blocker: whether guests are remembered changes the prose but not the structure,
and holding this ticket for it would leave the documentation last in an already-long chain.
