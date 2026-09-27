# 02: Guest tier prerequisite list, including a side-effect-free ssh-agent check

Parent: [spec](../spec.md)

**What to build:** The preflight gains a `guest` group covering every check the `guest` tier runs before building images: elevated shell, Docker running, gateway ports free (either `:80` or `:443` held fails), and `ssh-agent` usable. The `guest` tier's `globalSetup` runs the same list first, then carries on with its non-prerequisite setup unchanged: sweeping residue, golden images, the host network, adding the harness key for the run, and teardown.

The `ssh-agent` entry reuses existing harness code, with no new ssh code. It ensures the persistent harness key pair exists, then runs the existing add-and-verify identity routine, then the existing remove-identity routine, leaving the agent as it found it. The `guest` `globalSetup` still adds the harness key for the run after the list passes, so the key is added twice during `pnpm test:guest`; that is accepted.

**Blocked by:** 01

**Status:** resolved

- [x] The preflight reports a `guest` group with entries for elevated shell, Docker running, gateway ports free, and `ssh-agent`.
- [x] After `pnpm test:preflight`, `ssh-add -l` lists the same identities it listed beforehand. The harness key file may now exist on disk.
- [x] With the `ssh-agent` service stopped, the preflight's `ssh-agent` entry fails with the existing fix-it message.
- [x] `pnpm test:guest` fails fast on the first failing prerequisite before any image build, as it does today.
- [x] The `guest` tier still adds the harness key for its run and removes it in teardown.

## Manual verification (2026-09-27)

- **Prepared host** (elevated PowerShell, Docker Desktop running, `ssh-agent` service running with no identities): `pnpm test:preflight` passed all 8 entries, including `guest > elevated shell`, `Docker running`, `gateway ports free`, and `ssh-agent`. `ssh-add -l` reported "The agent has no identities." both before and after.
- **`ssh-agent` stopped:** `pnpm test:preflight` failed only `guest > ssh-agent`, with the existing "`ssh-add …` failed … Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent …" message. `pnpm test:guest` failed in `globalSetup` via `runPrerequisites` with the same message, before any image build.
- **`pnpm test:guest`** on the prepared host: 4 files passed, 1 skipped (`SUSENTORNO_WINDOWS_ISO` unset); 32 tests passed, 14 skipped. During the run `ssh-add -l` listed the `susentorno-guest-tier-harness` key; after teardown the agent had no identities again.
