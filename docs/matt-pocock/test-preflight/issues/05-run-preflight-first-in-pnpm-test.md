# 05: Run the preflight first in `pnpm test`

Parent: [spec](../spec.md)

**What to build:** `pnpm test` runs `test:preflight` as its very first step, before `format:check`. An unready host then fails immediately with the complete list of what to fix, rather than minutes into the pipeline.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `pnpm test` runs the preflight before format, lint, typecheck, and the tiers, and stops if it fails.
- [ ] The Verification Pipeline section of `development.md` (the source of truth for step order) lists the preflight first, and `testing.md`'s "Default verification pipeline" section agrees.
