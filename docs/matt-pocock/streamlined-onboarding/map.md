# Streamlined onboarding

Label: `wayfinder:map`

## Destination

A spec at `docs/matt-pocock/streamlined-onboarding/spec.md` describing: a `setup-guest-windows`
command at parity with `setup-guest-unix`; a shared ensure-and-preflight module both commands call,
which auto-creates the host and environment artifacts it can derive and hard-fails with a named
manual step otherwise; a `susentorno doctor` check-only surface; per-guest configuration persisted
in the environment so reruns stop re-prompting; and the documentation structure that results — such
that a user's documented path begins at guest setup rather than at machine setup.

Implementation issues are carved from the spec afterwards, not by this map.

## Notes

**Domain**: Windows host provisioning, Hyper-V guest lifecycle, and the CLI's command surface.
Vocabulary lives in `CONTEXT.md`; decisions of record in `docs/adr/`. Read both before answering a
ticket — several tickets here sit directly against an existing ADR.

**Skills every session should consult**: `grilling` and `domain-modeling` by default; `research` for
the research ticket.

**Standing constraints for this effort**, settled while charting:

- **Planning only.** Tickets resolve decisions. No production code or doc rewrites land from this
  map; the spec is the handoff.
- **Manual prerequisites hard-fail.** When something needing a human is absent, the command errors
  with the exact missing step named. It does not prompt inline and does not half-provision.
- **Windows parity is sequenced first.** The ensure-chain is designed against two callers, not
  retrofitted onto one. Windows tickets block the streamlining tickets within this map.
- **`run-hosting` stays a foreground command the user starts.** Per
  [ADR 0008](../../adr/0008-run-hosting-owns-hosting-lifecycle.md), nothing here forks it, owns its
  lifetime, or installs it as a service. A consequence to state plainly in the spec: the streamlined
  path is still two terminals, because `run-hosting` must be up during isolation. This effort
  removes the two configuration layers, not the second terminal.
- **`AGENTS.md` forbids worktrees and parallel agents for edits** — this project's tests do not run
  in parallel.

## Decisions so far

<!-- one line per resolved ticket: gist plus link -->

_None yet._

## Not yet specified

- **Test-tier coverage for `setup-guest-windows`.** The `guest` tier already boots a `windowsFresh`
  role over PowerShell Direct, but it exercises harness code, not a production command. What moves
  into the tier once the command exists, and what `testing.md`'s placement rules say about it, can't
  be phrased sharply until the transport (ticket 01) is chosen.
- **Whether `update-shares` folds into the ensure chain.** Shares are regenerated from customization
  inputs; whether that regeneration is part of "ensure the environment" or stays an explicit command
  depends on the ensure/fail inventory in ticket 06.
- **Teardown symmetry.** `delete-host-network` undoes `create-host-network`. Whether the widened
  ensure-chain acquires a matching teardown — and whether it would remove the share account and SMB
  shares it created — is unclear until ticket 02 reports what is creatable unattended.
- **The Windows analogue of the Ubuntu rerun round-trip.** `setup-guest-unix` reattaches an
  already-isolated guest to the Default Switch on every rerun, deliberately, as the recovery path.
  Whether a PowerShell Direct transport (which needs no network to reach the guest) makes that
  round-trip unnecessary is a question ticket 05 may sharpen into its own ticket.

## Out of scope

- **Automating Hyper-V VM creation and OS installation.** The destination is removing configuration
  layers, not building an image pipeline. The `guest` test tier builds golden images
  ([ADR 0025](../../adr/0025-guest-layer-tested-against-real-hyperv.md),
  [ADR 0027](../../adr/0027-windows-guest-tested-over-powershell-direct.md)); promoting that to a
  user-facing feature is a separate effort. ADR 0027 also records that the Windows path is not
  bootstrappable from clean, because the Enterprise evaluation sits behind a registration form.
- **BIOS virtualization flags.** Physical host firmware. No software can set them, so they stay a
  printed prerequisite.
- **Making `run-hosting` a Windows service or scheduled task.** Considered while charting and ruled
  out: it inverts [ADR 0008](../../adr/0008-run-hosting-owns-hosting-lifecycle.md), and its logs are
  wanted in a visible terminal during a guest setup that can fail.
