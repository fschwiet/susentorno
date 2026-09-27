# 02: Guest tier prerequisite list, including a side-effect-free ssh-agent check

Parent: [spec](../spec.md)

**What to build:** The preflight gains a `guest` group covering every check the `guest` tier runs before building images: elevated shell, Docker running, gateway ports free (either `:80` or `:443` held fails), and `ssh-agent` usable. The `guest` tier's `globalSetup` runs the same list first, then carries on with its non-prerequisite setup unchanged: sweeping residue, golden images, the host network, adding the harness key for the run, and teardown.

The `ssh-agent` entry reuses existing harness code, with no new ssh code. It ensures the persistent harness key pair exists, then runs the existing add-and-verify identity routine, then the existing remove-identity routine, leaving the agent as it found it. The `guest` `globalSetup` still adds the harness key for the run after the list passes, so the key is added twice during `pnpm test:guest`; that is accepted.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The preflight reports a `guest` group with entries for elevated shell, Docker running, gateway ports free, and `ssh-agent`.
- [ ] After `pnpm test:preflight`, `ssh-add -l` lists the same identities it listed beforehand. The harness key file may now exist on disk.
- [ ] With the `ssh-agent` service stopped, the preflight's `ssh-agent` entry fails with the existing fix-it message.
- [ ] `pnpm test:guest` fails fast on the first failing prerequisite before any image build, as it does today.
- [ ] The `guest` tier still adds the harness key for its run and removes it in teardown.
