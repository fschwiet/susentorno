# Promoting the Windows ambient-trust arm from the harness into `src/`

Type: grilling
Status: open
Blocked by: —

## Question

Where does the Windows guest-side ambient-root installer live once `setup-guest-windows` exists, and
what shape does it take?

[ADR 0027](../../../adr/0027-windows-guest-tested-over-powershell-direct.md) explicitly deferred
this. Under "Considered Options" it rejected "A Windows arm of `propagateAmbientTrust` in `src/`"
with the reason: "it would ship a product feature with no caller until a `setup-guest-windows`
command exists." Its Consequences section records the resulting substitution: "the guest-side
ambient-root installer is harness code," while "the host-side enumerator is production code."

So the host half already ships — `src/guestSetup/hostTrustStore.ts` enumerates the host's trusted
roots, and `src/commands/runHosting.ts` already imports `enumerateHostTrustedRoots`. The guest half
lives at `tests/guest/windowsAmbientTrust.ts`.

This effort creates the caller ADR 0027 was waiting for, so the deferral expires here.

ADR 0027 also records that ambient trust is **required, not optional flake-proofing**: susentorno is
developed from inside a susentorno guest and `current-auth-list.txt` terminates `github.com:443`, so
a `git ls-remote` fails without it. A Windows guest that skips this step is not merely less
convenient; it cannot reach a terminated upstream at all.

A resolution must state:

- Whether the Windows installer becomes a second arm of the existing `propagateAmbientTrust`
  (`src/guestSetup/ambientTrust.ts`) or a separate module — and whether that answer should follow
  ticket 01's ruling on shared-versus-honest-siblings, or is independent of it.
- What the harness then does: keeps its own copy, or consumes the production one. ADR 0027 named
  this as a deliberate substitution, so removing it changes what the `windowsFresh` role proves.
- Whether ADR 0027 needs a superseding or amending ADR once the deferral is discharged, or whether a
  note suffices.
- How failure surfaces. On Ubuntu this is `AmbientTrustError`; the Windows equivalent needs the same
  treatment, and the charting-time rule applies — a missing prerequisite hard-fails with the step
  named.
