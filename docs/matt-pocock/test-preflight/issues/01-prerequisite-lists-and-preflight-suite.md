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

**Status:** ready-for-review

- [x] A `test:preflight` package script runs a dedicated preflight Vitest config, with test files running serially.
- [x] The preflight reports `unit`, `cli`, `host-network`, and `proxy-stack` groups. `unit` and `cli` have no tests yet; `host-network` and `proxy-stack` have one test per existing check, named after the entry.
- [x] Adding or removing an entry in a tier's list adds or removes its preflight test, with no other edit.
- [x] `pnpm test:host-network` and `pnpm test:proxy-stack` still fail fast on the first failing prerequisite, with the same fix-it messages as before.
- [x] Every failing check in the preflight is reported in one run (for example, with Docker stopped in a non-elevated shell, both the elevation and Docker entries fail).
- [x] `testing.md` gains a section describing the preflight as a preflight suite, not a tier, including how to run it and how to add a prerequisite. Its opening sentence lists all five tiers, including `host-network`.
- [x] Manual verification is recorded in the change: the preflight passes on a prepared host and fails exactly the expected entries on an unprepared one.

## Manual verification (2026-09-27)

- **Prepared host** (elevated shell, Docker Desktop running, no `run-hosting`): `pnpm test:preflight` passed in about 2.4 s. `unit (0)` and `cli (0)` were listed as skipped empty groups. `host-network > elevated shell` and the three `proxy-stack` entries passed.
- **Unprepared host** (non-elevated via `runas /trustlevel:0x20000`, with Docker's `resources\bin` removed from `PATH` so `docker info` fails): `pnpm test:preflight` failed exactly `host-network > elevated shell` and `proxy-stack > Docker running`, each with its existing fix-it message, in one run. `no running proxy` and `node.exe not blocked by Windows Firewall` passed.
- **Tier fail-fast:** with Docker off `PATH`, `pnpm test:proxy-stack` failed in `globalSetup` with the same "Docker does not appear to be running … Start Docker Desktop and re-run." message and ran no tests.
- `pnpm test:unit`, `pnpm test:cli`, `pnpm test:host-network`, and `pnpm test:proxy-stack` pass on the prepared host.
