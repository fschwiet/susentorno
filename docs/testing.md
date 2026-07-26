# Test tiers

Configamatron's automated tests are divided into four tiers: `unit`, `cli`,
`proxy-stack`, and `guest`. Each tier is named for the **highest observable
interface it crosses** — its _test surface_ — not for an amount of integration
or a ranking of importance. Naming by surface makes two things predictable: where
a new test belongs, and what a suite requires to run (so a prerequisite failure
is distinguishable from a product failure).

The tier names use the project's domain vocabulary (see [CONTEXT.md](../CONTEXT.md)).
In particular, `guest` names the domain actor whose behavior is observed, not the
mechanism used to run it.

| Tier | Package command | Directory | Vitest config | Observable surface |
| --- | --- | --- | --- | --- |
| `unit` | `pnpm test:unit` | `tests/unit/` | `vitest.config.ts` | In-process behavior through a module interface or an intentional internal seam |
| `cli` | `pnpm test:cli` | `tests/cli/` | `vitest.cli.config.ts` | The packaged CLI (`dist/cli.js`) and the filesystem artifacts it generates |
| `proxy-stack` | `pnpm test:proxy-stack` | `tests/proxy-stack/` | `vitest.proxy-stack.config.ts` | The live proxy stack (Docker + local upstream adapters), without entering a guest |
| `guest` | `pnpm test:guest` | `tests/guest/` | `vitest.guest.config.ts` | Behavior observed through a disposable guest |

## What each tier exercises

- **`unit`** — Tests that call an in-process module interface directly, or that
  drive an intentional internal seam. A unit test that uses a local in-memory or
  stub adapter is still a unit test: the observation is made through the module,
  not through a packaged command or a running stack. This tier keeps the fast,
  Node-based execution model and requires no external services.

- **`cli`** — Tests that invoke the built, user-facing `configamatron` command
  and assert on its behavior or on the artifacts it writes to disk. Building the
  package (`pnpm build`) is a prerequisite because these tests run against
  `dist/cli.js`. Several in-process modules may participate in producing a
  result; that does not make it a unit test — the observation is made through the
  packaged interface.

- **`proxy-stack`** — Tests that bring the real proxy stack up (Envoy in Docker,
  networking, mock upstreams, and other local adapters) and observe its behavior
  without booting a guest. Their Docker and local-upstream requirements are
  meant to be obvious from the tier name and directory.

- **`guest`** — Tests whose observations are made from inside a disposable guest.
  A guest test typically crosses the CLI and the proxy stack as well, but it is
  placed here because the guest is the highest surface it exercises. The test
  implementation boots the guest with QEMU under WSL2; **Hyper-V remains the
  production guest platform, and is not the test runtime** (see
  [ADR-0010](adr/0010-wsl-qemu-vm-test-platform.md)). The `guest` name refers to
  the domain actor under test, not to the virtualization mechanism.

## Placing a new test

**The highest observable interface a test crosses determines its tier.** When a
test could plausibly live in more than one tier, choose the tier of the highest
surface it actually exercises, and prefer asserting at the highest stable seam
available rather than reaching down to lower-level implementation detail.

Worked cases:

- **Several in-process modules compose to produce a result** → `unit`, as long as
  the observation is made by calling a module directly (including through a local
  in-memory or stub adapter). Depth of composition does not promote a test to a
  higher tier; the surface does.
- **The test invokes the packaged CLI** → `cli`, even when many in-process
  modules participate. The suite name describes the observation (the packaged
  command and its artifacts), not the implementation depth behind it.
- **The test needs a live proxy stack but never enters a guest** → `proxy-stack`,
  so that its Docker and local-adapter requirements are discoverable from its
  location.
- **The test drives behavior from inside a disposable guest** → `guest`, even
  when it also crosses the CLI and the proxy stack, because the guest is the
  highest exercised seam.

Avoid proliferating new tiers. If a test seems not to fit, re-express it in terms
of the highest surface it observes and place it there.

## Prerequisites per tier

Each tier fails for its own environmental reasons; knowing them keeps a missing
prerequisite from being mistaken for a product defect.

| Tier | Prerequisites |
| --- | --- |
| `unit` | Node only. |
| `cli` | A production build (`pnpm build`, run automatically before the suite in the default pipeline). The suite shells out to `jq`; install it on the dev host and CI, or the jq-dependent tests self-skip. |
| `proxy-stack` | Docker running (Envoy is brought up via docker compose against local mock upstreams on transient ports). No guest and no real credential are required. |
| `guest` | Windows host with WSL2 (mirrored networking, `ignoredPorts=67`), a real Debian-based WSL2 distro set as default, QEMU/KVM available inside WSL2, Docker, and the one-time golden-image build. See the "Development" section of [README.md](../README.md) and the guest-harness notes in [technical-notes.md](../technical-notes.md) for the exact WSL configuration and setup command. |

When a guest run cannot verify because a prerequisite is unavailable (no WSL2, no
KVM, wrong default distro, etc.), report that explicitly as an environmental gap
rather than as a test failure.

## Default verification pipeline

`pnpm test` runs the default pipeline, which covers the **unit, CLI, and
proxy-stack** tiers (alongside format, lint, typecheck, and the build). The exact
fail-fast step order lives in the "Verification Pipeline" section of
[README.md](../README.md), the single source for the per-step commands.

The **guest** tier is **not** part of `pnpm test`. It is invoked separately with
`pnpm test:guest` because of its Windows/WSL2/QEMU prerequisites and its runtime
(guest boots and reboots take minutes). Run it when touching
`templates/vm-shared/` or proxy configuration. Stop any running
`configamatron run-proxy` first — the suite and `run-proxy` manage the same Envoy
stack and will clobber each other (see [technical-notes.md](../technical-notes.md)).

## Shared test support

Support code that serves more than one tier lives at the root of `tests/` and is
**shared**, not owned by any single tier — for example `proxyStack.ts`,
`testEnvRoot.ts`, `rmEnvRoot.ts`, `checkDockerRunning.ts`, `checkNoRunningProxy.ts`,
and `tests/fixtures/`. Multiple tiers consume these — for example the CLI tier
reads `tests/fixtures/`, while the proxy-stack and guest tiers share the stack
helpers.

Tier-specific setup and harness code stays inside its owning tier's directory —
for example `tests/proxy-stack/globalSetup.ts`, `tests/guest/globalSetup.ts`, and
`tests/guest/harness/`. Do not relocate a shared helper into one tier's directory,
which would give it misleading single-tier ownership.
