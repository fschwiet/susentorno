# 05: Run the preflight first in `pnpm test`

Parent: [spec](../spec.md)

**What to build:** `pnpm test` runs `test:preflight` as its very first step, before `format:check`. An unready host then fails immediately with the complete list of what to fix, rather than minutes into the pipeline.

**Blocked by:** 01

**Status:** ready-for-review

- [x] `pnpm test` runs the preflight before format, lint, typecheck, and the tiers, and stops if it fails.
- [x] The Verification Pipeline section of `development.md` (the source of truth for step order) lists the preflight first, and `testing.md`'s "Default verification pipeline" section agrees.

## Manual verification (2026-09-27)

Run from an elevated PowerShell on the prepared host.

- **ISO variable unset:** `pnpm test` ran `pnpm test:preflight` first, which failed exactly `guest > Windows ISO valid` (13 passed), and the pipeline stopped there in about 6 s. `format:check`, `lint`, `typecheck`, and the tiers did not run.
- **ISO variable set:** `pnpm test:preflight` passed all 14 entries in about 7 s.
