# 01: Prerequisite lists and the preflight suite (host-network, proxy-stack)

Parent: [spec](../spec.md)

**What to build:** A developer can run `pnpm test:preflight` and, within a few seconds, see one test per prerequisite, grouped by tier, for the tiers whose checks exist today outside `guest`. This is the tracer bullet:

- Introduce the per-tier prerequisite list, an ordered list of `{ name, check }` entries.
- Give `unit` and `cli` empty lists.
- Move the `host-network` checks (elevated shell) and the `proxy-stack` checks (Docker running, no running proxy, `node.exe` not firewall-blocked) out of those tiers' `globalSetup`s into their lists.
- Have each of those `globalSetup`s run its list in order and stop at the first failure, which is its current behavior.
- Add a preflight Vitest suite that generates one `describe` per tier and one `it` per list entry from a single tier → list map.

The preflight is a suite, not a tier. Document it that way.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A `test:preflight` package script runs a dedicated preflight Vitest config, with test files running serially.
- [ ] The preflight reports `unit`, `cli`, `host-network`, and `proxy-stack` groups. `unit` and `cli` have no tests yet; `host-network` and `proxy-stack` have one test per existing check, named after the entry.
- [ ] Adding or removing an entry in a tier's list adds or removes its preflight test, with no other edit.
- [ ] `pnpm test:host-network` and `pnpm test:proxy-stack` still fail fast on the first failing prerequisite, with the same fix-it messages as before.
- [ ] Every failing check in the preflight is reported in one run (for example, with Docker stopped in a non-elevated shell, both the elevation and Docker entries fail).
- [ ] `testing.md` gains a section describing the preflight as a preflight suite, not a tier, including how to run it and how to add a prerequisite. Its opening sentence lists all five tiers, including `host-network`.
- [ ] Manual verification is recorded in the change: the preflight passes on a prepared host and fails exactly the expected entries on an unprepared one.
