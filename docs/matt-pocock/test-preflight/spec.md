# Spec: preflight suite for test-tier prerequisites

Status: ready-for-agent

## Problem Statement

A developer or coding agent running `pnpm test` has no quick way to know whether the host is set up to run every test tier. Each live tier checks its own prerequisites only when that tier starts, so a missing `ssh-agent` or a busy `:80` surfaces many minutes into the pipeline — after format, lint, typecheck, `unit`, build, `cli`, and `proxy-stack` have already run. Fixing one problem and re-running reveals the next, one at a time.

Worse, part of the `guest` tier can go missing without anyone noticing. The `windowsFresh` role self-skips when `SUSENTORNO_WINDOWS_ISO` is unset, and its only signal is a console line and a "skipped" count. A recent agentic run skipped it unnoticed, so Windows guest coverage silently did not run.

Some prerequisites are also only documented, never checked (Hyper-V available, Docker Compose, `jq`). And the tiers' checks live in separate `globalSetup` files, so there is no single place that says what a tier needs.

## Solution

Add a **preflight suite**: a Vitest suite run with `pnpm test:preflight`. It is not a tier; it exercises no product surface. It reports, in a few seconds and in one run, every prerequisite of every tier, as one test per prerequisite grouped by tier. `pnpm test` runs it as its very first step, so an unready host fails immediately with the complete list of what to fix.

Each tier's prerequisites become a single list of named checks that the tier's `globalSetup` and the preflight both consume, so they cannot drift. The `SUSENTORNO_WINDOWS_ISO` prerequisite becomes **required** for the `guest` tier: set, pointing at an existing file, and an x64 `en-us` Windows image. With it unset, the `guest` tier and the preflight fail rather than skipping `windowsFresh`.

## User Stories

1. As a developer setting up a new host, I want one command that tells me whether every test tier can run, so that I do not discover missing prerequisites one tier at a time.
2. As a developer, I want the preflight to report every failing prerequisite in one run, so that I can fix them all before re-running.
3. As a developer, I want preflight results grouped by tier, so that I can see which tiers a given problem blocks.
4. As a developer, I want each prerequisite to appear as its own named test, so that the report reads like a checklist.
5. As a developer, I want the preflight to finish in seconds, so that running it costs nothing compared to the tiers it guards.
6. As a developer, I want `pnpm test` to run the preflight first, so that an unready host fails before format, lint, typecheck, and the tiers spend minutes running.
7. As a coding agent running `pnpm test`, I want a missing prerequisite to be a failure rather than a skip or a console message, so that I cannot mistake partial coverage for a passing run.
8. As a maintainer adding a prerequisite to a tier, I want to add it in one place, so that both the tier's fail-fast setup and the preflight pick it up without further edits.
9. As a maintainer removing a prerequisite, I want its preflight test to disappear automatically, so that the preflight never reports a stale check.
10. As a maintainer, I want the tier's `globalSetup` and the preflight to run the same check code, so that the preflight passing means the tier will get past its own checks.
11. As a developer on a host without an elevated shell, I want the `host-network` and `guest` groups to fail with a message naming the fix, so that I know to re-run from an Administrator terminal.
12. As a developer, I want the preflight to verify that Hyper-V is available, so that a host without Hyper-V fails in the preflight rather than deep inside `host-network` or `guest`.
13. As a developer, I want the preflight to verify that Docker is running for the `proxy-stack` and `guest` tiers, so that a stopped Docker Desktop is caught up front.
14. As a developer, I want the preflight to verify that Docker Compose is available, so that a Docker install without Compose is caught before the proxy stack tries to start.
15. As a developer, I want the `proxy-stack` group to fail when a live `run-hosting` holds both `:80` and `:443`, so that the suite does not clobber the Envoy stack serving my real guest.
16. As a developer, I want the `guest` group to fail when either `:80` or `:443` is held, so that an IIS or dev-server listener is caught with its own fix-it message.
17. As a developer, I want the `proxy-stack` group to fail when Windows Firewall blocks this `node.exe`, so that a dismissed firewall prompt does not cause silent hangs later.
18. As a developer, I want the `guest` group to verify that an `ssh-agent` reachable by the `ssh` on PATH can hold the harness key, so that a disabled agent service or a Git-for-Windows OpenSSH mix-up is caught before any image build.
19. As a developer, I want the preflight's `ssh-agent` check to leave my agent as it found it, so that running the preflight has no lasting effect beyond the harness key file the `guest` tier creates anyway.
20. As a developer, I want the `guest` group to fail when `SUSENTORNO_WINDOWS_ISO` is unset, so that the `windowsFresh` role can never be silently skipped.
21. As a developer, I want the `guest` group to fail when `SUSENTORNO_WINDOWS_ISO` points at a file that does not exist, so that a typo or an unmounted drive is caught immediately.
22. As a developer, I want the `guest` group to fail when the ISO is not an x64 `en-us` Windows image, so that a wrong ISO is caught in seconds rather than partway through a build that can take up to two hours.
23. As a developer, I want the ISO check's failure message to mention that it needs elevation, so that an access-denied mount failure in a non-elevated shell is not confusing.
24. As a developer, I want the `cli` group to report `jq` as skipped when it is absent, so that the preflight matches the `cli` tests that already self-skip without it.
25. As a developer, I want the `unit` group to have no prerequisites, so that the preflight honestly shows the tier needs nothing beyond Node dependencies.
26. As a developer running inside a susentorno Linux guest, I want the Windows-only checks to fail with a message that the tier needs a Windows Hyper-V host, so that the preflight honestly answers "can all tests run here?".
27. As a maintainer, I want `pnpm test:guest` to fail fast on a missing or invalid Windows ISO, so that the `guest` tier enforces the same prerequisite on its own.
28. As a maintainer, I want the Windows golden image build to receive an already-validated ISO path, so that ISO validation lives in one place.
29. As a reader of `testing.md`, I want the preflight documented as a preflight suite and not a tier, so that the "avoid creating new tiers" guidance still holds.
30. As a reader of ADR-0027, I want the change that made the Windows ISO required recorded in the ADR with a date and a reason, so that the design history explains why the role no longer self-skips.
31. As a reader of `development.md`, I want the verification pipeline step order to include the preflight first, so that the documented order matches `pnpm test`.
32. As a developer, I want the preflight's `guest` checks to include every check the `guest` tier runs before building images, so that passing the preflight means the tier's pre-build gate will pass.

## Implementation Decisions

- **The preflight is a suite, not a tier.** It gets its own Vitest config and a `test:preflight` package script. Its tests run serially, since several checks touch shared host state such as the `ssh-agent` and ISO mounts. `testing.md` describes it explicitly as a preflight suite so the tier model is unchanged.
- **One prerequisite list per tier.** Each tier gets a prerequisites module exporting an ordered list of entries shaped `{ name, check }`, where `check` is an async function that resolves on success, throws an error whose message names the fix on failure, and can signal "skip, with reason" for optional prerequisites. The `unit` tier's list is empty, and the `cli` tier's list holds only `jq`.
- **The preflight generates its tests from those lists.** It holds one hand-maintained map from tier name to prerequisite list. For each tier it creates a `describe`, and for each entry an `it` named after the entry. Adding or removing an entry adds or removes its test with no other edit. The map changes only when a tier is added.
- **Tier `globalSetup`s consume the same lists.** `host-network`, `proxy-stack`, and `guest` each run their list in order and stop at the first failure, which is today's fail-fast behavior. The `guest` tier's non-prerequisite setup (sweeping residue, building golden images, creating the host network, adding the harness key for the run, and teardown) stays in its `globalSetup` after the list.
- **Prerequisites that are shared across tiers are listed in each tier that needs them.** For example, "Docker running" appears under both `proxy-stack` and `guest`. The preflight therefore runs a shared check once per tier that lists it. That is accepted because each check is cheap and the report shows exactly which tiers are blocked.
- **Tier contents:**
  - `cli`: `jq` on PATH (optional; skipped with a reason when absent).
  - `host-network`: elevated shell; Hyper-V available.
  - `proxy-stack`: Docker running; Docker Compose available; no running proxy (both loopback ports held); `node.exe` not blocked by Windows Firewall.
  - `guest`: elevated shell; Hyper-V available; Docker running; Docker Compose available; gateway ports free (either loopback port held fails); `ssh-agent` usable; Windows ISO valid.
- **Existing guards are reused unchanged in behavior.** These are the elevated-shell, Docker-running, no-running-proxy, gateway-ports-free, and node-firewall guards.
- **New checks:**
  - **Hyper-V available:** the Hyper-V Virtual Machine Management service (`vmms`) exists and is running.
  - **Docker Compose available:** `docker compose version` exits 0.
  - **`jq`:** resolvable on PATH, otherwise skip.
  - **Windows ISO valid:** the variable is set, the file exists, and a read-only mount of the ISO shows an `install.wim` image whose architecture is x64 and whose language is `en-us`. The ISO is dismounted afterward whether the check passes or fails. The failure message notes that the check needs an elevated shell. The logic that interprets the image metadata is a pure function, separate from the PowerShell invocation.
- **The `ssh-agent` check reuses existing harness code, with no new ssh code.** The `guest` entry ensures the persistent harness key pair exists, which the tier would create anyway. It then runs the existing add-and-verify identity routine, then the existing remove-identity routine. The agent is left as it was found. The `guest` `globalSetup` still adds the harness key for the run after the list passes, so the key is added twice during `pnpm test:guest`; that is accepted. No read-only variant is written.
- **The Windows ISO becomes required.**
  - The `windowsFresh` role no longer self-skips, and the `guest` `globalSetup` no longer branches on whether the variable is set.
  - The Windows golden image builder takes the validated ISO path as a parameter instead of reading the environment variable and checking existence itself.
  - There is no opt-out variable.
  - The helper that reads the variable remains as the prerequisite's input and no longer serves as an on/off switch.
- **Non-Windows hosts:** Windows-only checks (elevation, Hyper-V, firewall, ISO) fail on a non-`win32` platform with a message that the tier needs a Windows Hyper-V host. They do not skip.
- **Checks do not declare dependencies on each other.** Every check runs in the preflight even when an earlier one in the same tier failed, and each failure message stands on its own.
- **Pipeline:** `pnpm test` runs `test:preflight` as its first step, before `format:check`.
- **Documentation:**
  - `testing.md`: a preflight section; the `guest` prerequisites row says the ISO is required; the `windowsFresh` "opt-in" paragraph is rewritten.
  - `development.md`: the Verification Pipeline step order.
  - ADR-0027: amended in place. The sentence saying the role self-skips when the variable is unset is rewritten, and a dated note is added (2026-09-27: the ISO is now required, because a skipped `windowsFresh` role went unnoticed in an agentic run).

## Testing Decisions

- **Good tests here assert external behavior**, meaning what a check reports for a given observed state. They do not assert how a check shells out.
- **`unit` tier:**
  - The pure logic introduced by this work gets unit tests at its module interface. This mainly means interpreting Windows image metadata into pass, or a failure naming the actual architecture and language.
  - Prior art is the unit test for the pure message function behind the gateway-ports guard, and the unit tests for the image-cache helpers, including the one that reads `SUSENTORNO_WINDOWS_ISO`. Update that test to match the helper's new role.
- **The preflight suite is its own verification of the environment-touching checks.** Running `pnpm test:preflight` on a prepared host must pass every group. Running it on a deliberately unprepared host (non-elevated shell, Docker stopped, the ISO variable unset) must fail exactly the entries for those prerequisites, with fix-it messages. Record this manual verification in the implementing change.
- **Test generation from the lists needs no dedicated test.** It is a direct loop over data, and its behavior is visible in every preflight run.
- **The `guest` tier's behavior change is verified by the existing `guest` tier run.** With the ISO set, `windowsFresh` runs rather than skipping. With it unset, `pnpm test:guest` fails in `globalSetup` before any image build.
- Tests must follow `testing.md`'s tier placement rules and must not run in parallel with other live tiers.

## Out of Scope

- Checking that a production build (`dist/`) exists or is current. `pnpm test` builds before the tiers that need it, and a stale build would pass such a check.
- An opt-out for the Windows guest role, such as a skip variable.
- A dependency mechanism between checks (skipping a check as "blocked by" another).
- Aggregating every failure inside a tier's own `globalSetup`. Tiers keep fail-fast-on-first; only the preflight reports everything.
- A read-only `ssh-agent` check, or a stricter check that `ssh` and `ssh-add` resolve to the same OpenSSH installation.
- Downloading or fetching the Windows evaluation ISO automatically.
- Validating that the ISO is on a local disk rather than a network share. See the Further Notes.
- Changes to what the tiers themselves test.

## Further Notes

- `SUSENTORNO_WINDOWS_ISO` should point at a local path. The Hyper-V service attaches it directly to the build VM's DVD drive, so mapped drive letters are invisible to it and UNC paths need the host's computer account to have access. The tier also hashes the full ISO on every `guest` run. The rewritten `testing.md` text should say this.
- Making the ISO required means every host that runs the full `pnpm test` needs roughly 50–60 GB for `.image-cache/`, and its first Windows golden image build takes 60–120 minutes. This was accepted deliberately, in exchange for never silently losing Windows guest coverage.
- `testing.md`'s opening sentence lists four tiers and omits `host-network`. Fix it in passing when adding the preflight section.
